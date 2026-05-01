// src/utils/media/ffmpegUtils.js
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { createTempPath } = require('./tempFiles');

const DEFAULT_TARGET_BYTES = 18 * 1024 * 1024;

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

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

function parseBitrateKbps(value) {
    const parsed = Number.parseInt(value || 0, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed / 1000 : 0;
}

function getDurationSeconds(probeData) {
    const duration = Number.parseFloat(probeData.format?.duration || 0);
    if (Number.isFinite(duration) && duration > 0) return duration;
    const videoStream = probeData.streams?.find(s => s.codec_type === 'video');
    const streamDuration = Number.parseFloat(videoStream?.duration || 0);
    return Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : 0;
}

function estimateVideoKbps(videoStream) {
    const width = Number.parseInt(videoStream?.width || 0, 10);
    const height = Number.parseInt(videoStream?.height || 0, 10);
    if (!width || !height) return 900;
    const megapixels = (width * height) / 1_000_000;
    return clamp(Math.round(megapixels * 950), 700, 2200);
}

async function mp4OutputOptions(inputPath, {
    targetBytes = DEFAULT_TARGET_BYTES,
    durationMultiplier = 1,
    qualityMultiplier = 1.6,
    minVideoKbps = 420,
    maxVideoKbps = 2600,
    maxAudioKbps = 96,
    includeAudio = true,
    forceAudio = false,
} = {}) {
    let probeData = null;
    try {
        probeData = await probeFile(inputPath);
    } catch {
        return [
            '-c:v libx264',
            '-preset veryfast',
            '-crf 28',
            '-pix_fmt yuv420p',
            '-movflags faststart',
            ...(includeAudio ? ['-c:a aac', `-b:a ${maxAudioKbps}k`] : []),
        ];
    }

    const videoStream = probeData.streams?.find(s => s.codec_type === 'video');
    const audioStream = probeData.streams?.find(s => s.codec_type === 'audio');
    const hasAudioStream = includeAudio && (Boolean(audioStream) || forceAudio);
    const duration = getDurationSeconds(probeData) * Math.max(durationMultiplier || 1, 0.01);

    const sourceTotalKbps = parseBitrateKbps(probeData.format?.bit_rate);
    const sourceAudioKbps = parseBitrateKbps(audioStream?.bit_rate);
    const fallbackVideoKbps = sourceTotalKbps && sourceAudioKbps
        ? Math.max(sourceTotalKbps - sourceAudioKbps, 0)
        : 0;
    const sourceVideoKbps = parseBitrateKbps(videoStream?.bit_rate)
        || fallbackVideoKbps
        || estimateVideoKbps(videoStream);

    const audioKbps = hasAudioStream
        ? clamp(Math.round(sourceAudioKbps || maxAudioKbps), 48, maxAudioKbps)
        : 0;
    const fileBudgetKbps = duration > 0
        ? Math.floor((targetBytes * 8 / duration / 1000) * 0.9)
        : maxVideoKbps + audioKbps;
    const videoBudgetKbps = Math.max(fileBudgetKbps - audioKbps, 180);
    const preferredVideoKbps = Math.round(sourceVideoKbps * qualityMultiplier);
    const videoKbps = clamp(
        Math.min(preferredVideoKbps, videoBudgetKbps, maxVideoKbps),
        Math.min(minVideoKbps, videoBudgetKbps),
        Math.max(videoBudgetKbps, Math.min(minVideoKbps, maxVideoKbps))
    );

    return [
        '-c:v libx264',
        '-preset veryfast',
        `-b:v ${videoKbps}k`,
        `-maxrate ${Math.round(videoKbps * 1.35)}k`,
        `-bufsize ${Math.max(Math.round(videoKbps * 2), 500)}k`,
        '-pix_fmt yuv420p',
        '-movflags faststart',
        ...(hasAudioStream ? ['-c:a aac', `-b:a ${audioKbps}k`] : []),
    ];
}

async function compressMp4ToLimit(inputPath, maxBytes) {
    const attempts = [
        { targetBytes: Math.floor(maxBytes * 0.92), qualityMultiplier: 0.95, maxVideoKbps: 3500, maxAudioKbps: 80 },
        { targetBytes: Math.floor(maxBytes * 0.78), qualityMultiplier: 0.75, maxVideoKbps: 2600, maxAudioKbps: 64 },
        { targetBytes: Math.floor(maxBytes * 0.62), qualityMultiplier: 0.55, maxVideoKbps: 1800, maxAudioKbps: 48 },
    ];
    let bestPath = null;
    let bestSize = Number.POSITIVE_INFINITY;

    for (const attempt of attempts) {
        const outputPath = createTempPath('mp4');
        try {
            const outputOptions = await mp4OutputOptions(inputPath, attempt);
            await runFFmpeg(inputPath, outputPath, cmd => {
                cmd.outputOptions(outputOptions);
            });
            const size = fs.statSync(outputPath).size;
            if (size <= maxBytes) {
                if (bestPath) {
                    try { fs.unlinkSync(bestPath); } catch {}
                }
                return outputPath;
            }
            if (size < bestSize) {
                if (bestPath) {
                    try { fs.unlinkSync(bestPath); } catch {}
                }
                bestPath = outputPath;
                bestSize = size;
            } else {
                try { fs.unlinkSync(outputPath); } catch {}
            }
        } catch {
            try { fs.unlinkSync(outputPath); } catch {}
        }
    }

    return bestPath || inputPath;
}

async function ensureMediaSize(filePath, maxBytes) {
    const size = fs.statSync(filePath).size;
    if (size <= maxBytes) return filePath;

    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.mp4') {
        return compressMp4ToLimit(filePath, maxBytes);
    }
    return filePath;
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
        const outputOptions = await mp4OutputOptions(inputPath, { durationMultiplier: count });
        await runFFmpeg(listPath, outputPath, cmd => {
            cmd
                .inputOptions(['-f concat', '-safe 0'])
                .outputOptions(outputOptions);
        });
    } finally {
        try { fs.unlinkSync(listPath); } catch {}
    }
}

module.exports = {
    runFFmpeg,
    probeFile,
    hasAudio,
    atempoChain,
    mp4OutputOptions,
    ensureMediaSize,
    videoToGif,
    loopVideo,
};
