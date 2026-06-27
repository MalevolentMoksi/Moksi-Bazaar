// src/utils/media/magickUtils.js
// ImageMagick "magik" / content-aware-scale (liquid-rescale / seam-carving).
//
// Reference (mediaforge/src/processing/other.py::magickone):
//   magick <in> -liquid-rescale <strength>%x<strength>% <out>
// strength is a percentage (1-99): smaller = stronger warp. Animated inputs are
// exploded to frames, carved per-frame, and reassembled (animatedmultiplexer).
//
// This bot has no ImageMagick by default; the Dockerfile installs it (with the
// liblqr delegate) for production. magickAvailable() guards local dev gracefully.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const sharp = require('sharp');
const { createTempPath, cleanup } = require('./tempFiles');
const { runFFmpeg, mp4OutputOptions, nice, gifPaletteGen, gifPaletteUse } = require('./ffmpegUtils');
const { evenNumber, getFrameRate, probeDimensions } = require('./mediaProbe');

// Guardrails: seam-carving is O(W*H*seams) and genuinely slow.
const MAX_CARVE_DIM = 1000;   // downscale longest side to this before carving
const MAX_FRAMES = 120;       // refuse absurdly long animations
const FRAME_CONCURRENCY = 4;  // parallel `magick` processes per batch

let _binaryPromise = null;

// Resolve which ImageMagick binary exists: IM7 ships `magick`; Debian's IM6 ships
// `convert`/`mogrify`. Cached. Returns the binary name or null if none found.
function detectMagickBinary() {
    if (!_binaryPromise) {
        _binaryPromise = (async () => {
            for (const bin of ['magick', 'convert']) {
                const ok = await new Promise(resolve => {
                    let proc;
                    try {
                        proc = spawn(bin, ['-version']);
                    } catch {
                        return resolve(false);
                    }
                    proc.on('error', () => resolve(false));
                    proc.on('close', code => resolve(code === 0));
                });
                if (ok) return bin;
            }
            return null;
        })();
    }
    return _binaryPromise;
}

async function magickAvailable() {
    return Boolean(await detectMagickBinary());
}

// Run ImageMagick with array args (no shell -> no injection). Rejects on non-zero
// exit, surfacing stderr (e.g. "delegate failed" when liblqr is missing).
// On Linux the process is launched through `nice` so slow seam-carving doesn't
// starve the Node event loop / Discord gateway heartbeat.
async function runMagick(args) {
    const bin = await detectMagickBinary();
    if (!bin) {
        throw new Error('ImageMagick is not installed on this host.');
    }
    const useNice = process.platform !== 'win32';
    return new Promise((resolve, reject) => {
        function launch(withNice) {
            const cmd = withNice ? 'nice' : bin;
            const cmdArgs = withNice ? ['-n', '10', bin, ...args] : args;
            const proc = spawn(cmd, cmdArgs);
            let stderr = '';
            let spawnFailed = false;
            proc.stderr.on('data', d => { stderr += d.toString(); });
            proc.on('error', err => {
                // If `nice` isn't on PATH, retry once invoking the binary directly.
                if (withNice && err.code === 'ENOENT') {
                    spawnFailed = true;
                    return launch(false);
                }
                reject(new Error(`ImageMagick failed to start: ${err.message}`));
            });
            proc.on('close', code => {
                if (spawnFailed) return; // a fallback launch is handling it
                if (code === 0) return resolve();
                const detail = stderr.trim().split('\n').slice(-3).join(' ');
                reject(new Error(`ImageMagick exited ${code}: ${detail || 'unknown error'}`));
            });
        }
        launch(useNice);
    });
}

function liquidRescaleArgs(inputPath, strength, outputPath) {
    // strength% on both axes; a single -liquid-rescale call carves to that size.
    return [inputPath, '-liquid-rescale', `${strength}%x${strength}%`, outputPath];
}

// ---------------------------------------------------------------------------
// Static image
// ---------------------------------------------------------------------------
async function magickImage(inputPath, strength, ext = '') {
    // Downscale very large images before carving to keep it responsive.
    let carveInput = inputPath;
    let prepPath = null;
    const meta = await sharp(inputPath).metadata();
    const longest = Math.max(meta.width || 0, meta.height || 0);
    if (longest > MAX_CARVE_DIM) {
        const scale = MAX_CARVE_DIM / longest;
        prepPath = createTempPath('png');
        await sharp(inputPath)
            .resize(Math.round((meta.width || 0) * scale), Math.round((meta.height || 0) * scale))
            .png()
            .toFile(prepPath);
        carveInput = prepPath;
    }

    const outExt = ext && ['png', 'jpg', 'jpeg', 'webp'].includes(ext.toLowerCase()) ? ext.toLowerCase() : 'png';
    const outputPath = createTempPath(outExt);
    try {
        await runMagick(liquidRescaleArgs(carveInput, strength, outputPath));
        return outputPath;
    } catch (err) {
        await cleanup(outputPath);
        throw err;
    } finally {
        await cleanup(prepPath);
    }
}

// ---------------------------------------------------------------------------
// Frame-based animated pipeline (GIF + video)
// Explode -> carve each frame to identical target dims -> reassemble.
// ---------------------------------------------------------------------------
function makeFrameDir() {
    const dir = path.join(os.tmpdir(), `mbazaar_magick_${crypto.randomUUID()}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

async function rmDir(dir) {
    if (!dir) return;
    try {
        await fs.promises.rm(dir, { recursive: true, force: true });
    } catch {
        // best-effort
    }
}

// Run an async mapper over items with bounded concurrency.
async function mapLimit(items, limit, mapper) {
    const results = new Array(items.length);
    let cursor = 0;
    async function worker() {
        while (cursor < items.length) {
            const i = cursor++;
            results[i] = await mapper(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

// Explode -> carve -> return { framesDir, carvedPattern, fps, targetW, targetH }.
async function carveFrames(inputPath, strength) {
    const dims = await probeDimensions(inputPath);
    const fps = await getFrameRate(inputPath);

    // Cap working resolution before carving (per-frame seam-carve is the slow part).
    const longest = Math.max(dims.width, dims.height);
    const scale = longest > MAX_CARVE_DIM ? MAX_CARVE_DIM / longest : 1;
    const workW = evenNumber(dims.width * scale);
    const workH = evenNumber(dims.height * scale);

    const framesDir = makeFrameDir();
    const rawPattern = path.join(framesDir, 'raw_%05d.png');

    // Explode to PNG frames at working resolution.
    await runFFmpeg(inputPath, rawPattern, cmd => {
        cmd.videoFilters(`scale=${workW}:${workH}:flags=lanczos`).outputOptions(['-vsync', '0']);
    });

    const rawFrames = fs.readdirSync(framesDir)
        .filter(f => f.startsWith('raw_'))
        .sort();
    if (rawFrames.length === 0) {
        await rmDir(framesDir);
        throw new Error('No frames could be extracted from the media.');
    }
    if (rawFrames.length > MAX_FRAMES) {
        await rmDir(framesDir);
        throw new Error(`Too many frames (${rawFrames.length}); magik is limited to ${MAX_FRAMES}. Try a shorter clip.`);
    }

    // Carve every frame to the SAME target size so reassembly lines up.
    // -liquid-rescale strength% shrinks; we then force exact even dims so all
    // frames match (carving can be off-by-one between frames otherwise).
    const targetW = evenNumber(Math.max(2, Math.round(workW * strength / 100)));
    const targetH = evenNumber(Math.max(2, Math.round(workH * strength / 100)));

    await mapLimit(rawFrames, FRAME_CONCURRENCY, async (frame) => {
        const inFrame = path.join(framesDir, frame);
        const outFrame = path.join(framesDir, frame.replace('raw_', 'carved_'));
        // Carve, then resize to exact target dims to guarantee uniform frame size.
        await runMagick([
            inFrame,
            '-liquid-rescale', `${strength}%x${strength}%`,
            '-resize', `${targetW}x${targetH}!`,
            outFrame,
        ]);
    });

    return { framesDir, carvedPattern: path.join(framesDir, 'carved_%05d.png'), fps, targetW, targetH };
}

// ---------------------------------------------------------------------------
// Animated GIF
// ---------------------------------------------------------------------------
async function magickGif(inputPath, strength) {
    const { framesDir, carvedPattern, fps } = await carveFrames(inputPath, strength);
    const palettePath = createTempPath('png');
    const outputPath = createTempPath('gif');
    try {
        // Pass 1: palette from carved frames.
        await new Promise((resolve, reject) => {
            nice(require('fluent-ffmpeg')(carvedPattern))
                .inputOptions([`-framerate ${fps}`])
                .complexFilter(gifPaletteGen())
                .on('end', resolve)
                .on('error', err => reject(new Error(`FFmpeg palette error: ${err.message}`)))
                .save(palettePath);
        });
        // Pass 2: assemble GIF using the palette (Discord-safe bayer dithering).
        await new Promise((resolve, reject) => {
            nice(require('fluent-ffmpeg')(carvedPattern))
                .inputOptions([`-framerate ${fps}`])
                .input(palettePath)
                .complexFilter(`[0:v][1:v]${gifPaletteUse()}`)
                .outputOptions(['-loop', '0'])
                .on('end', resolve)
                .on('error', err => reject(new Error(`FFmpeg GIF error: ${err.message}`)))
                .save(outputPath);
        });
        return outputPath;
    } catch (err) {
        await cleanup(outputPath);
        throw err;
    } finally {
        await cleanup(palettePath);
        await rmDir(framesDir);
    }
}

// ---------------------------------------------------------------------------
// Video (MP4). Carved frames are reassembled; original audio is mapped back in.
// ---------------------------------------------------------------------------
async function magickVideo(inputPath, strength) {
    const { framesDir, carvedPattern, fps } = await carveFrames(inputPath, strength);
    const outputPath = createTempPath('mp4');
    try {
        const outputOptions = await mp4OutputOptions(inputPath, {
            qualityMultiplier: 1.6,
            maxVideoKbps: 2800,
        });
        await new Promise((resolve, reject) => {
            nice(require('fluent-ffmpeg')(carvedPattern))
                .inputOptions([`-framerate ${fps}`])
                .input(inputPath)               // for the original audio stream
                .outputOptions([
                    '-map 0:v',
                    '-map 1:a?',
                    '-shortest',
                    ...outputOptions,
                ])
                .on('end', resolve)
                .on('error', err => reject(new Error(`FFmpeg error: ${err.message}`)))
                .save(outputPath);
        });
        return outputPath;
    } catch (err) {
        await cleanup(outputPath);
        throw err;
    } finally {
        await rmDir(framesDir);
    }
}

module.exports = {
    magickAvailable,
    magickImage,
    magickGif,
    magickVideo,
};
