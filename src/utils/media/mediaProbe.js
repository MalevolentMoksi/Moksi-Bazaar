// src/utils/media/mediaProbe.js
// Small shared probe/format helpers used by the media-rendering utils
// (captionUtils, speechBubbleUtils, magickUtils). Kept dependency-light so
// new utils can reuse them without importing from caption-specific code.
const sharp = require('sharp');
const { probeFile } = require('./ffmpegUtils');

// Round down to the nearest even number (FFmpeg/H.264 require even dimensions).
function evenNumber(n, fallback = 2) {
    const safe = Number.isFinite(n) ? Math.floor(n) : fallback;
    if (safe <= 0) return fallback;
    const even = safe % 2 === 0 ? safe : safe - 1;
    return even > 0 ? even : fallback;
}

// Parse an FFmpeg frame-rate string ("30000/1001", "25") into a number.
function parseFrameRate(rate, fallback = 15) {
    if (!rate) return fallback;
    if (String(rate).includes('/')) {
        const [num, den] = String(rate).split('/').map(Number);
        const value = den ? num / den : fallback;
        return Number.isFinite(value) && value > 0 ? value : fallback;
    }
    const value = parseFloat(rate);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Extract the frame rate (FPS) of an input video/GIF to preserve animation speed.
async function getFrameRate(inputPath) {
    try {
        const probeData = await probeFile(inputPath);
        const videoStream = probeData.streams?.find(s => s.codec_type === 'video');
        if (!videoStream) return 15;
        return parseFrameRate(videoStream.avg_frame_rate, parseFrameRate(videoStream.r_frame_rate));
    } catch {
        return 15;
    }
}

// Probe the pixel dimensions of a video/GIF/animated input via ffprobe.
async function probeDimensions(inputPath) {
    const probeData = await probeFile(inputPath);
    const videoStream = probeData.streams?.find(s => s.codec_type === 'video');
    if (!videoStream?.width || !videoStream?.height) {
        throw new Error('Could not determine media dimensions.');
    }
    return { width: videoStream.width, height: videoStream.height };
}

async function isAnimatedImage(inputPath) {
    try {
        const meta = await sharp(inputPath, { animated: true }).metadata();
        return (meta.pages || 1) > 1;
    } catch {
        return false;
    }
}

async function isGifImage(inputPath) {
    try {
        const meta = await sharp(inputPath, { animated: true }).metadata();
        return meta.format === 'gif';
    } catch {
        return false;
    }
}

// Returns the output extension and a sharp format applicator matching the source format.
// JPEG/WebP are re-encoded at quality 92 (high quality, good compression); everything else is PNG.
function outputFormatFor(format) {
    if (format === 'jpeg') return { ext: 'jpg', applyFormat: s => s.jpeg({ quality: 92 }) };
    if (format === 'webp') return { ext: 'webp', applyFormat: s => s.webp({ quality: 92 }) };
    return { ext: 'png', applyFormat: s => s.png() };
}

module.exports = {
    evenNumber,
    parseFrameRate,
    getFrameRate,
    probeDimensions,
    isAnimatedImage,
    isGifImage,
    outputFormatFor,
};
