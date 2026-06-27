// src/utils/media/speechBubbleUtils.js
// MediaForge-style speech-bubble overlay. Ports the original FFmpeg filtergraph
// (scale2ref -> alphaextract,negate,alphamerge for the transparent cut-out;
// overlay for solid white/black bubbles) onto this bot's Sharp + FFmpeg stack.
//
// Reference (mediaforge/src/processing/ffmpeg/other.py::speech_bubble):
//   transparent: [1:v]format=rgba,alphaextract,negate[mask];[0:v][mask]alphamerge
//   white/black: [0:v][1:v]overlay=format=auto   (negate the bubble first for black)
//   position=bottom flips the bubble vertically.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createTempPath, cleanup } = require('./tempFiles');
const { runFFmpeg, mp4OutputOptions } = require('./ffmpegUtils');
const { evenNumber, getFrameRate, probeDimensions, outputFormatFor } = require('./mediaProbe');

const BUBBLE_ASSET = path.join(__dirname, '..', '..', 'assets', 'mediaTemplates', 'speechbubble.png');

// Produce the bubble PNG scaled to exactly width x height, flipped for "bottom",
// and (for the solid white/black modes) recolored. The asset is a white bubble on a
// transparent background, so:
//   - white  -> use as-is (already white where opaque)
//   - black  -> negate RGB (white -> black), keep alpha
//   - the alpha channel always carries the bubble's shape.
async function buildBubblePng(width, height, position, color) {
    let pipeline = sharp(BUBBLE_ASSET).resize(width, height, { fit: 'fill' });
    if (position === 'bottom') {
        pipeline = pipeline.flip(); // vertical flip (matches FFmpeg vflip)
    }
    if (color === 'black') {
        // Invert RGB only, preserve the alpha shape.
        pipeline = pipeline.negate({ alpha: false });
    }
    return pipeline.png().toBuffer();
}

// ---------------------------------------------------------------------------
// Static image
// ---------------------------------------------------------------------------
async function renderSpeechBubbleImage(inputPath, position = 'top', color = 'transparent') {
    const { width, height, format } = await sharp(inputPath).metadata();

    const MAX_WIDTH = 2048;
    const scale = width > MAX_WIDTH ? MAX_WIDTH / width : 1;
    const outW = scale < 1 ? Math.round(width * scale) : width;
    const outH = scale < 1 ? Math.round(height * scale) : height;

    const bubbleBuf = await buildBubblePng(outW, outH, position, color);
    const baseInput = scale < 1
        ? await sharp(inputPath).resize(outW, outH).toBuffer()
        : inputPath;

    if (color === 'transparent') {
        // Cut the bubble shape out of the source: where the bubble is opaque, the
        // source becomes transparent. Sharp's 'dest-out' keeps the destination
        // (source image) only where the incoming (bubble) is NOT present —
        // i.e. it erases the source under the opaque bubble pixels. Output PNG.
        const outputPath = createTempPath('png');
        await sharp(baseInput)
            .ensureAlpha()
            .composite([{ input: bubbleBuf, blend: 'dest-out' }])
            .png()
            .toFile(outputPath);
        return outputPath;
    }

    // Solid white/black bubble overlaid on top, source format preserved.
    const { ext, applyFormat } = outputFormatFor(format);
    const outputPath = createTempPath(ext);
    await applyFormat(
        sharp(baseInput).composite([{ input: bubbleBuf, blend: 'over' }])
    ).toFile(outputPath);
    return outputPath;
}

// Build the chain that turns the pre-scaled source [src] and the bubble [1:v] into
// the bubbled result labelled [bubbled]. inputs:
//   transparent -> cut the bubble shape out of the source (source gets a hole)
//   white/black -> overlay the (already recolored) bubble on top
function bubbleChain(color) {
    if (color === 'transparent') {
        // alphaextract -> bubble shape; negate -> opaque OUTSIDE, transparent INSIDE;
        // alphamerge applies that as [src]'s new alpha, cutting the bubble region out.
        return '[1:v]format=rgba,alphaextract,negate[mask];[src][mask]alphamerge[bubbled]';
    }
    return '[src][1:v]overlay=format=auto[bubbled]';
}

// ---------------------------------------------------------------------------
// Animated GIF
// ---------------------------------------------------------------------------
async function renderSpeechBubbleGif(inputPath, position = 'top', color = 'transparent') {
    const dims = await probeDimensions(inputPath);
    const MAX_GIF_WIDTH = 1280;
    const gScale = dims.width > MAX_GIF_WIDTH ? MAX_GIF_WIDTH / dims.width : 1;
    const width = evenNumber(gScale < 1 ? dims.width * gScale : dims.width);
    const height = evenNumber(gScale < 1 ? dims.height * gScale : dims.height);
    const fps = await getFrameRate(inputPath);

    // White/black recolor the bubble at write time; transparent keeps the white
    // asset (only its alpha shape matters for the cut-out).
    const writeColor = color === 'transparent' ? 'white' : color;
    const bubbleBuf = await buildBubblePng(width, height, position, writeColor);
    const bubblePath = createTempPath('png');
    const palettePath = createTempPath('png');
    const outputPath = createTempPath('gif');

    // Transparent cut-outs need a reserved transparent palette entry to stay see-through.
    const paletteGen = color === 'transparent'
        ? 'palettegen=max_colors=255:reserve_transparent=1'
        : 'palettegen=max_colors=256:reserve_transparent=0';
    const paletteUse = color === 'transparent'
        ? 'paletteuse=dither=sierra2_4a:alpha_threshold=128'
        : 'paletteuse=dither=sierra2_4a';

    // Scale source to even dims, then apply the bubble -> [bubbled].
    const sourcePrep = `[0:v]scale=${width}:${height}:flags=lanczos[src];${bubbleChain(color)}`;

    try {
        await fs.promises.writeFile(bubblePath, bubbleBuf);

        // Pass 1: palette from the bubbled frames.
        await runFFmpeg(inputPath, palettePath, cmd => {
            cmd
                .input(bubblePath)
                .complexFilter(`${sourcePrep};[bubbled]fps=${fps},${paletteGen}`);
        });

        // Pass 2: render GIF using the palette.
        await runFFmpeg(inputPath, outputPath, cmd => {
            cmd
                .input(bubblePath)
                .input(palettePath)
                .complexFilter(`${sourcePrep};[bubbled]fps=${fps}[f];[f][2:v]${paletteUse}`)
                .outputOptions(['-loop', '0']);
        });

        return outputPath;
    } catch (err) {
        await cleanup(outputPath);
        throw err;
    } finally {
        await cleanup(bubblePath, palettePath);
    }
}

// ---------------------------------------------------------------------------
// Video (MP4). MP4 has no alpha, so transparent is downgraded to white upstream.
// ---------------------------------------------------------------------------
async function renderSpeechBubbleVideo(inputPath, position = 'top', color = 'transparent') {
    // MP4 cannot carry alpha — a transparent cut-out can't be represented.
    // Fall back to a solid white bubble (documented in the command description).
    const effectiveColor = color === 'transparent' ? 'white' : color;

    const dims = await probeDimensions(inputPath);
    const MAX_VIDEO_WIDTH = 1920;
    const vScale = dims.width > MAX_VIDEO_WIDTH ? MAX_VIDEO_WIDTH / dims.width : 1;
    const width = evenNumber(vScale < 1 ? dims.width * vScale : dims.width);
    const height = evenNumber(vScale < 1 ? dims.height * vScale : dims.height);

    const bubbleBuf = await buildBubblePng(width, height, position, effectiveColor);
    const bubblePath = createTempPath('png');
    const outputPath = createTempPath('mp4');

    try {
        await fs.promises.writeFile(bubblePath, bubbleBuf);
        const outputOptions = await mp4OutputOptions(inputPath, {
            qualityMultiplier: 1.7,
            maxVideoKbps: 3000,
        });

        await runFFmpeg(inputPath, outputPath, cmd => {
            cmd
                .input(bubblePath)
                .complexFilter([
                    `[0:v]scale=${width}:${height}:flags=lanczos[src]`,
                    '[src][1:v]overlay=0:0:format=auto[v]',
                ])
                .outputOptions([
                    '-map [v]',
                    '-map 0:a?',
                    '-shortest',
                    ...outputOptions,
                ]);
        });

        return outputPath;
    } catch (err) {
        await cleanup(outputPath);
        throw err;
    } finally {
        await cleanup(bubblePath);
    }
}

module.exports = {
    renderSpeechBubbleImage,
    renderSpeechBubbleGif,
    renderSpeechBubbleVideo,
    BUBBLE_ASSET,
};
