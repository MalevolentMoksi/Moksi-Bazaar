// src/utils/media/ffmpegUtils.js
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const { createTempPath } = require('./tempFiles');

// Promisified ffmpeg runner. configureFn receives the fluent-ffmpeg command object.
function runFFmpeg(input, output, configureFn) {
    return new Promise((resolve, reject) => {
        const cmd = ffmpeg(input);
        configureFn(cmd);
        cmd
            .on('end', resolve)
            .on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)))
            .save(output);
    });
}

// Probe a file and return its metadata (streams, format, etc.)
function probeFile(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, data) => {
            if (err) return reject(err);
            resolve(data);
        });
    });
}

// Check whether a file has an audio stream
async function hasAudio(filePath) {
    try {
        const data = await probeFile(filePath);
        return data.streams.some(s => s.codec_type === 'audio');
    } catch {
        return false;
    }
}

// Build the atempo filter chain for any speed multiplier (FFmpeg atempo range is 0.5-100 per link)
function atempoChain(speed) {
    if (speed >= 0.5) return `atempo=${speed}`;
    // Below 0.5 needs chaining: e.g. 0.25x = atempo=0.5,atempo=0.5
    const filters = [];
    let remaining = speed;
    while (remaining < 0.5) {
        filters.push('atempo=0.5');
        remaining /= 0.5;
    }
    filters.push(`atempo=${remaining}`);
    return filters.join(',');
}

// Create a high-quality GIF from a video using the two-pass palette method
async function videoToGif(inputPath, outputPath, fps = 15, scale = 480) {
    const palettePath = createTempPath('png');
    try {
        // Pass 1: generate palette
        await runFFmpeg(inputPath, palettePath, cmd => {
            cmd.videoFilters(`fps=${fps},scale=${scale}:-1:flags=lanczos,palettegen`);
        });
        // Pass 2: render GIF using palette
        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .input(palettePath)
                .complexFilter(`fps=${fps},scale=${scale}:-1:flags=lanczos[x];[x][1:v]paletteuse`)
                .outputOptions(['-an', '-loop 0'])
                .on('end', resolve)
                .on('error', err => reject(new Error(`FFmpeg GIF error: ${err.message}`)))
                .save(outputPath);
        });
    } finally {
        try { fs.unlinkSync(palettePath); } catch {}
    }
}

// Loop a video N times using the concat demuxer
async function loopVideo(inputPath, outputPath, count) {
    const listPath = createTempPath('txt');
    const lines = Array(count).fill(`file '${inputPath.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, lines);
    try {
        await runFFmpeg(listPath, outputPath, cmd => {
            cmd
                .inputOptions(['-f concat', '-safe 0'])
                .outputOptions(['-c copy']);
        });
    } finally {
        try { fs.unlinkSync(listPath); } catch {}
    }
}

module.exports = { runFFmpeg, probeFile, hasAudio, atempoChain, videoToGif, loopVideo };
