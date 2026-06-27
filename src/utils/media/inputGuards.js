// src/utils/media/inputGuards.js
// Normalize input media BEFORE processing so oversized/overlong inputs don't blow
// up encode time or memory. Caps resolution, FPS, and total frame count for
// videos/GIFs (mirrors MediaForge's ensuresize + ensureduration). Static images
// are only resolution-capped. Returns { path, notes[] } — notes describe any
// change so the command can tell the user.
const fs = require('fs');
const sharp = require('sharp');
const { createTempPath, cleanup } = require('./tempFiles');
const { runFFmpeg, probeFile, nice, ffmpeg, gifPaletteGen, gifPaletteUse } = require('./ffmpegUtils');
const { getFrameRate, evenNumber } = require('./mediaProbe');

// Defaults chosen to be generous but safe for a Discord bot.
const MAX_INPUT_DIMENSION = 2048; // longest side for images/video before processing
const MAX_INPUT_FPS = 60;
const MAX_INPUT_FRAMES = 1800;    // ~30s @ 60fps / 2min @ 15fps

function parseRate(rate) {
    if (!rate) return 0;
    if (String(rate).includes('/')) {
        const [n, d] = String(rate).split('/').map(Number);
        return d ? n / d : 0;
    }
    return parseFloat(rate) || 0;
}

// Cap a static image's longest side. Returns { path, notes }.
async function normalizeImageInput(inputPath, ext) {
    try {
        const meta = await sharp(inputPath).metadata();
        const longest = Math.max(meta.width || 0, meta.height || 0);
        if (longest <= MAX_INPUT_DIMENSION) return { path: inputPath, notes: [] };
        const scale = MAX_INPUT_DIMENSION / longest;
        const outExt = ['png', 'jpg', 'jpeg', 'webp', 'avif'].includes((ext || '').toLowerCase())
            ? ext.toLowerCase() : 'png';
        const outputPath = createTempPath(outExt);
        await sharp(inputPath)
            .resize(Math.round((meta.width || 0) * scale), Math.round((meta.height || 0) * scale))
            .toFile(outputPath);
        return {
            path: outputPath,
            notes: [`resized to ${Math.round((meta.width || 0) * scale)}×${Math.round((meta.height || 0) * scale)}`],
            replaced: true,
        };
    } catch {
        return { path: inputPath, notes: [] };
    }
}

// Cap a video/GIF: resolution, FPS, then frame count (trim). Returns { path, notes }.
async function normalizeVideoInput(inputPath, { isGif }) {
    const notes = [];
    let current = inputPath;
    let createdPaths = [];

    let probeData;
    try {
        probeData = await probeFile(inputPath);
    } catch {
        return { path: inputPath, notes: [] };
    }
    const v = probeData.streams?.find(s => s.codec_type === 'video');
    if (!v?.width || !v?.height) return { path: inputPath, notes: [] };

    let width = v.width;
    let height = v.height;
    let fps = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 15;
    const duration = Number.parseFloat(probeData.format?.duration || 0) || 0;

    const needResize = Math.max(width, height) > MAX_INPUT_DIMENSION;
    const needFps = fps > MAX_INPUT_FPS;
    const estFrames = duration > 0 ? Math.round(Math.min(fps, MAX_INPUT_FPS) * duration) : 0;
    const needTrim = estFrames > MAX_INPUT_FRAMES;

    if (!needResize && !needFps && !needTrim) {
        return { path: inputPath, notes: [] };
    }

    // Build a single ffmpeg pass that applies resolution + fps caps.
    const filters = [];
    if (needResize) {
        const scale = MAX_INPUT_DIMENSION / Math.max(width, height);
        width = evenNumber(width * scale);
        height = evenNumber(height * scale);
        filters.push(`scale=${width}:${height}:flags=lanczos`);
        notes.push(`resized to ${width}×${height}`);
    }
    if (needFps) {
        filters.push(`fps=${MAX_INPUT_FPS}`);
        fps = MAX_INPUT_FPS;
        notes.push(`capped to ${MAX_INPUT_FPS}fps`);
    }

    const maxDuration = needTrim ? (MAX_INPUT_FRAMES / fps) : null;
    if (needTrim) notes.push(`trimmed to ~${maxDuration.toFixed(1)}s`);

    const outExt = isGif ? 'gif' : 'mp4';
    const outputPath = createTempPath(outExt);
    createdPaths.push(outputPath);

    try {
        if (isGif) {
            const vf = filters.length ? filters.join(',') : 'null';
            const palettePath = createTempPath('png');
            createdPaths.push(palettePath);
            await runFFmpeg(inputPath, palettePath, cmd => {
                if (maxDuration) cmd.outputOptions([`-t ${maxDuration}`]);
                cmd.videoFilters(`${vf},${gifPaletteGen()}`);
            });
            await new Promise((resolve, reject) => {
                const cmd = nice(ffmpeg(inputPath));
                if (maxDuration) cmd.outputOptions([`-t ${maxDuration}`]);
                cmd.input(palettePath)
                    .complexFilter(`${vf}[x];[x][1:v]${gifPaletteUse()}`)
                    .outputOptions(['-an', '-loop 0'])
                    .on('end', resolve)
                    .on('error', err => reject(new Error(`FFmpeg normalize error: ${err.message}`)))
                    .save(outputPath);
            });
            try { fs.unlinkSync(palettePath); } catch {}
        } else {
            await runFFmpeg(inputPath, outputPath, cmd => {
                if (filters.length) cmd.videoFilters(filters.join(','));
                if (maxDuration) cmd.outputOptions([`-t ${maxDuration}`]);
                cmd.outputOptions([
                    '-c:v libx264', '-preset veryfast', '-crf 23',
                    '-pix_fmt yuv420p', '-movflags +faststart', '-c:a copy',
                ]);
            });
        }
        return { path: outputPath, notes, replaced: true };
    } catch {
        // If normalization fails, fall back to the original input rather than erroring.
        await cleanup(...createdPaths);
        return { path: inputPath, notes: [] };
    }
}

// Top-level: normalize based on media kind. Never throws — worst case returns input.
async function normalizeInput(inputPath, ext, { isVideo, isGifLike } = {}) {
    try {
        if (isGifLike || (ext || '').toLowerCase() === 'gif') {
            return await normalizeVideoInput(inputPath, { isGif: true });
        }
        if (isVideo) {
            return await normalizeVideoInput(inputPath, { isGif: false });
        }
        return await normalizeImageInput(inputPath, ext);
    } catch {
        return { path: inputPath, notes: [] };
    }
}

module.exports = {
    normalizeInput,
    MAX_INPUT_DIMENSION,
    MAX_INPUT_FPS,
    MAX_INPUT_FRAMES,
};
