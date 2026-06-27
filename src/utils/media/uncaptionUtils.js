// src/utils/media/uncaptionUtils.js
// Removes a solid-colour caption bar from the TOP of media (the classic esmBot /
// "caption" style white bar). Detects the bar height by scanning rows of the first
// frame from the top until a row deviates from white by more than `threshold`, then
// crops that many pixels off. (Ports MediaForge processing/vips/other.py::uncaption.)
const sharp = require('sharp');
const { createTempPath } = require('./tempFiles');
const { runFFmpeg, mp4OutputOptions, probeFile, nice, ffmpeg, gifPaletteGen, gifPaletteUse } = require('./ffmpegUtils');
const { getFrameRate, evenNumber } = require('./mediaProbe');

// Scan rows of a raw RGB(A) buffer; return the first row index whose mean channel
// deviation from white exceeds threshold (i.e. where the caption ends). Returns 0
// if the very top isn't white (no caption found).
function detectCaptionHeight({ data, info }, threshold) {
    const { width, height, channels } = info;
    for (let y = 0; y < height; y++) {
        // Sample a few x positions across the row (cheap and robust).
        let sumDev = 0;
        let samples = 0;
        const step = Math.max(1, Math.floor(width / 16));
        for (let x = 0; x < width; x += step) {
            const idx = (y * width + x) * channels;
            const dev = (Math.abs(255 - data[idx]) + Math.abs(255 - data[idx + 1]) + Math.abs(255 - data[idx + 2])) / 3;
            sumDev += dev;
            samples++;
        }
        if (samples && (sumDev / samples) > threshold) {
            return y; // caption occupies rows [0, y)
        }
    }
    return 0;
}

// Get the caption bar height in pixels from the first frame of any media.
async function captionHeight(inputPath, threshold) {
    // Extract the first frame as PNG so sharp can read it regardless of input type.
    const framePath = createTempPath('png');
    try {
        await runFFmpeg(inputPath, framePath, cmd => {
            cmd.outputOptions(['-frames:v 1', '-an']);
        });
        const raw = await sharp(framePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        return detectCaptionHeight(raw, threshold);
    } finally {
        const { cleanup } = require('./tempFiles');
        await cleanup(framePath);
    }
}

// Crop `cropTop` pixels off the top, dispatching by media type.
async function cropTop(inputPath, cropTop, { isGif, isVideo, ext }) {
    if (cropTop <= 0) {
        throw new Error('No caption detected at the top of this media. Try a lower threshold.');
    }

    // Static image: sharp extract.
    if (!isGif && !isVideo) {
        const meta = await sharp(inputPath).metadata();
        const newH = (meta.height || 0) - cropTop;
        if (newH <= 0) throw new Error('Detected caption is larger than the image.');
        const outExt = ['png', 'jpg', 'jpeg', 'webp'].includes((ext || '').toLowerCase()) ? ext.toLowerCase() : 'png';
        const outputPath = createTempPath(outExt);
        await sharp(inputPath).extract({ left: 0, top: cropTop, width: meta.width, height: newH }).toFile(outputPath);
        return outputPath;
    }

    // Probe dims for the crop filter.
    const probeData = await probeFile(inputPath);
    const v = probeData.streams?.find(s => s.codec_type === 'video');
    if (!v?.width || !v?.height) throw new Error('Could not determine media dimensions.');
    const cropEven = evenNumber(cropTop, 2);
    const outW = evenNumber(v.width);
    const outH = evenNumber(v.height - cropEven);
    if (outH <= 0) throw new Error('Detected caption is larger than the media.');
    const cropFilter = `crop=${outW}:${outH}:0:${cropEven}`;

    if (isGif) {
        const fps = await getFrameRate(inputPath);
        const palettePath = createTempPath('png');
        const outputPath = createTempPath('gif');
        try {
            await runFFmpeg(inputPath, palettePath, cmd => {
                cmd.videoFilters(`${cropFilter},${gifPaletteGen()}`);
            });
            await new Promise((resolve, reject) => {
                nice(ffmpeg(inputPath))
                    .input(palettePath)
                    .complexFilter(`${cropFilter}[c];[c][1:v]${gifPaletteUse()}`)
                    .outputOptions(['-an', '-loop 0'])
                    .on('end', resolve)
                    .on('error', err => reject(new Error(`FFmpeg GIF error: ${err.message}`)))
                    .save(outputPath);
            });
            return outputPath;
        } finally {
            const { cleanup } = require('./tempFiles');
            await cleanup(palettePath);
        }
    }

    // Video.
    const outputPath = createTempPath('mp4');
    const outputOptions = await mp4OutputOptions(inputPath);
    await runFFmpeg(inputPath, outputPath, cmd => {
        cmd.videoFilters(cropFilter).outputOptions(['-map 0:a?', ...outputOptions]);
    });
    return outputPath;
}

async function uncaption(inputPath, threshold, { isGif, isVideo, ext }) {
    const h = await captionHeight(inputPath, threshold);
    return cropTop(inputPath, h, { isGif, isVideo, ext });
}

module.exports = { uncaption };
