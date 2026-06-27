// src/utils/media/ffmpegUtils.js
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { createTempPath } = require('./tempFiles');

const DEFAULT_TARGET_BYTES = 18 * 1024 * 1024;

// Lower OS priority for media subprocesses so heavy encodes/seam-carving don't
// starve the Node event loop (and the Discord gateway heartbeat). No-op on
// Windows; degrades gracefully if `renice` is unavailable. (See run_command.py
// in MediaForge, which does the same with os.nice(10).)
const FFMPEG_NICENESS = 10;

// Apply niceness to a fluent-ffmpeg command. Safe to call always.
function nice(cmd) {
    try { cmd.renice(FFMPEG_NICENESS); } catch {}
    return cmd;
}

// Promisified ffmpeg runner. configureFn receives the fluent-ffmpeg command object.
function runFFmpeg(input, output, configureFn) {
    return new Promise((resolve, reject) => {
        const cmd = ffmpeg(input);
        configureFn(cmd);
        nice(cmd)
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

// Tolerance ladder for size-fitting (mirrors MediaForge's TOLERANCES). Each pass
// aims a bit lower than the last until the output fits under the limit.
const SIZE_TOLERANCES = [0.98, 0.92, 0.85, 0.72, 0.55, 0.4, 0.25, 0.12];

// Two-pass H.264 size-capping: compute an exact target bitrate from duration and
// encode in two passes for the best quality at a given size ceiling. Falls back to
// the single-pass ladder if duration is unknown. (MediaForge: twopasscapvideo.)
async function compressMp4ToLimit(inputPath, maxBytes) {
    let duration = 0;
    let hasAudioStream = false;
    try {
        const probeData = await probeFile(inputPath);
        duration = getDurationSeconds(probeData);
        hasAudioStream = Boolean(probeData.streams?.find(s => s.codec_type === 'audio'));
    } catch {
        // fall through to single-pass ladder below
    }

    if (duration > 0) {
        const audioKbps = hasAudioStream ? 96 : 0;
        const totalBudgetKbps = (maxBytes * 8 / duration / 1000);
        let best = null;
        let bestSize = Number.POSITIVE_INFINITY;
        for (const tolerance of SIZE_TOLERANCES) {
            const videoKbps = Math.floor((totalBudgetKbps - audioKbps) * tolerance);
            if (videoKbps <= 0) continue;
            const passLog = createTempPath('log').replace(/\.log$/, '');
            const outputPath = createTempPath('mp4');
            try {
                // Pass 1 (analysis, discard output).
                await new Promise((resolve, reject) => {
                    nice(ffmpeg(inputPath))
                        .outputOptions([
                            '-c:v libx264', '-preset veryfast', `-b:v ${videoKbps}k`,
                            '-pix_fmt yuv420p', '-pass 1', `-passlogfile ${passLog}`, '-an', '-f mp4', '-y',
                        ])
                        .on('end', resolve)
                        .on('error', err => reject(new Error(`FFmpeg pass1 error: ${err.message}`)))
                        .save(process.platform === 'win32' ? 'NUL' : '/dev/null');
                });
                // Pass 2 (real encode).
                await new Promise((resolve, reject) => {
                    const cmd = nice(ffmpeg(inputPath))
                        .outputOptions([
                            '-c:v libx264', '-preset veryfast', `-b:v ${videoKbps}k`,
                            '-pix_fmt yuv420p', '-pass 2', `-passlogfile ${passLog}`, '-movflags +faststart',
                        ]);
                    if (hasAudioStream) cmd.outputOptions(['-c:a aac', `-b:a ${audioKbps}k`]);
                    else cmd.noAudio();
                    cmd
                        .on('end', resolve)
                        .on('error', err => reject(new Error(`FFmpeg pass2 error: ${err.message}`)))
                        .save(outputPath);
                });

                const size = fs.statSync(outputPath).size;
                if (size <= maxBytes) {
                    if (best) { try { fs.unlinkSync(best); } catch {} }
                    return outputPath;
                }
                if (size < bestSize) {
                    if (best) { try { fs.unlinkSync(best); } catch {} }
                    best = outputPath; bestSize = size;
                } else {
                    try { fs.unlinkSync(outputPath); } catch {}
                }
            } catch {
                try { fs.unlinkSync(outputPath); } catch {}
            } finally {
                // Clean up the two-pass log files (ffmpeg appends -0.log / .mbtree).
                for (const suffix of ['-0.log', '-0.log.mbtree', '.log', '.log.mbtree']) {
                    try { fs.unlinkSync(passLog + suffix); } catch {}
                }
            }
        }
        if (best) return best;
    }

    // Single-pass fallback ladder (duration unknown or two-pass exhausted).
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
            await runFFmpeg(inputPath, outputPath, cmd => { cmd.outputOptions(outputOptions); });
            const size = fs.statSync(outputPath).size;
            if (size <= maxBytes) {
                if (bestPath) { try { fs.unlinkSync(bestPath); } catch {} }
                return outputPath;
            }
            if (size < bestSize) {
                if (bestPath) { try { fs.unlinkSync(bestPath); } catch {} }
                bestPath = outputPath; bestSize = size;
            } else {
                try { fs.unlinkSync(outputPath); } catch {}
            }
        } catch {
            try { fs.unlinkSync(outputPath); } catch {}
        }
    }
    return bestPath || inputPath;
}

// Shrink a static image to fit under maxBytes. File size is roughly proportional
// to pixel count, so scale by sqrt(maxBytes/size) across the tolerance ladder.
// (MediaForge: intelligentdownsize.)
async function compressImageToLimit(inputPath, maxBytes) {
    const sharp = require('sharp');
    let meta;
    try { meta = await sharp(inputPath).metadata(); } catch { return inputPath; }
    const w = meta.width || 0;
    const h = meta.height || 0;
    if (!w || !h) return inputPath;
    const size = fs.statSync(inputPath).size;
    const ext = (path.extname(inputPath).slice(1) || 'png').toLowerCase();
    const fmt = ext === 'jpg' ? 'jpeg' : ext;

    for (const tolerance of SIZE_TOLERANCES) {
        const ratio = (maxBytes / size) * tolerance;
        const scale = Math.sqrt(ratio);
        if (scale >= 1) continue;
        const newW = Math.max(1, Math.round(w * scale));
        const newH = Math.max(1, Math.round(h * scale));
        const outputPath = createTempPath(ext);
        try {
            let pipe = sharp(inputPath, { animated: ext === 'gif' || ext === 'webp' }).resize(newW, newH);
            if (typeof pipe[fmt] === 'function') pipe = pipe[fmt]();
            await pipe.toFile(outputPath);
            if (fs.statSync(outputPath).size <= maxBytes) return outputPath;
            try { fs.unlinkSync(outputPath); } catch {}
        } catch {
            try { fs.unlinkSync(outputPath); } catch {}
        }
    }
    return inputPath;
}

// Shrink an animated GIF to fit under maxBytes by downscaling, re-encoding with
// the Discord-safe palette. Scales by sqrt(maxBytes/size) across the ladder.
async function compressGifToLimit(inputPath, maxBytes) {
    let dims = null;
    let fps = 15;
    try {
        const probeData = await probeFile(inputPath);
        const v = probeData.streams?.find(s => s.codec_type === 'video');
        if (v?.width && v?.height) dims = { width: v.width, height: v.height };
        const rate = v?.avg_frame_rate || v?.r_frame_rate;
        if (rate && rate.includes('/')) {
            const [n, d] = rate.split('/').map(Number);
            if (d) fps = Math.min(50, n / d || 15);
        }
    } catch {
        return inputPath;
    }
    if (!dims) return inputPath;
    const size = fs.statSync(inputPath).size;

    for (const tolerance of SIZE_TOLERANCES) {
        const ratio = (maxBytes / size) * tolerance;
        const scale = Math.sqrt(ratio);
        if (scale >= 1) continue;
        const newW = Math.max(2, Math.round(dims.width * scale / 2) * 2);
        const palettePath = createTempPath('png');
        const outputPath = createTempPath('gif');
        try {
            const vf = `fps=${fps},scale=${newW}:-1:flags=lanczos`;
            await runFFmpeg(inputPath, palettePath, cmd => {
                cmd.videoFilters(`${vf},${gifPaletteGen()}`);
            });
            await new Promise((resolve, reject) => {
                nice(ffmpeg(inputPath))
                    .input(palettePath)
                    .complexFilter(`${vf}[x];[x][1:v]${gifPaletteUse()}`)
                    .outputOptions(['-an', '-loop 0'])
                    .on('end', resolve)
                    .on('error', err => reject(new Error(`FFmpeg GIF resize error: ${err.message}`)))
                    .save(outputPath);
            });
            if (fs.statSync(outputPath).size <= maxBytes) {
                try { fs.unlinkSync(palettePath); } catch {}
                return outputPath;
            }
            try { fs.unlinkSync(outputPath); } catch {}
        } catch {
            try { fs.unlinkSync(outputPath); } catch {}
        } finally {
            try { fs.unlinkSync(palettePath); } catch {}
        }
    }
    return inputPath;
}

async function ensureMediaSize(filePath, maxBytes) {
    const size = fs.statSync(filePath).size;
    if (size <= maxBytes) return filePath;

    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.mp4' || ext === '.mov' || ext === '.webm' || ext === '.mkv') {
        return compressMp4ToLimit(filePath, maxBytes);
    }
    if (ext === '.gif') {
        return compressGifToLimit(filePath, maxBytes);
    }
    if (['.png', '.jpg', '.jpeg', '.webp', '.avif', '.bmp', '.tiff'].includes(ext)) {
        return compressImageToLimit(filePath, maxBytes);
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

// ---------------------------------------------------------------------------
// Discord-safe GIF dithering.
// Discord re-encodes GIF previews and mangles error-diffusion dithers
// (sierra2_4a / floyd_steinberg) into noise, while ordered "bayer" dithering
// survives — that's the part that matters for Discord. These helpers centralize
// the palettegen/paletteuse filters so every GIF pipeline (caption, speechbubble,
// magick, convert) stays consistent.
//
// NOTE: we deliberately use the DEFAULT stats_mode (full), NOT stats_mode=single.
// stats_mode=single emits one palette PER FRAME, which cannot be written to a
// single palette PNG in the two-pass (palettegen-to-file -> paletteuse) approach
// these pipelines use — it errors with "Cannot write more than one file with the
// same name". A single full-stats palette + bayer dithering is the correct combo.
//   reserveTransparent: keep a palette slot for transparency (cut-outs/overlays)
// ---------------------------------------------------------------------------
function gifPaletteGen({ reserveTransparent = false } = {}) {
    return `palettegen=reserve_transparent=${reserveTransparent ? 1 : 0}`;
}
function gifPaletteUse({ reserveTransparent = false } = {}) {
    const alpha = reserveTransparent ? ':alpha_threshold=128' : '';
    return `paletteuse=dither=bayer:bayer_scale=3${alpha}`;
}

// Create a high-quality GIF from a video using the two-pass palette method.
async function videoToGif(inputPath, outputPath, fps = 15, scale = 480) {
    const palettePath = createTempPath('png');
    try {
        // Pass 1: generate palette
        await runFFmpeg(inputPath, palettePath, cmd => {
            cmd.videoFilters(`fps=${fps},scale=${scale}:-1:flags=lanczos,${gifPaletteGen()}`);
        });
        // Pass 2: render GIF using palette
        await new Promise((resolve, reject) => {
            nice(ffmpeg(inputPath))
                .input(palettePath)
                .complexFilter(`fps=${fps},scale=${scale}:-1:flags=lanczos[x];[x][1:v]${gifPaletteUse()}`)
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
    ffmpeg,
    nice,
    runFFmpeg,
    probeFile,
    hasAudio,
    atempoChain,
    mp4OutputOptions,
    ensureMediaSize,
    videoToGif,
    loopVideo,
    gifPaletteGen,
    gifPaletteUse,
    FFMPEG_NICENESS,
};
