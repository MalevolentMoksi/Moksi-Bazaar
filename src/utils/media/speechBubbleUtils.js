// src/utils/media/speechBubbleUtils.js
// esmBot-style speech bubble. Unlike MediaForge's full-image stretch, the bubble
// is a band sized to `scale` of the image height (default 0.2) placed at the top
// or bottom, scaled to the image width, looking like a real speech bubble rather
// than a giant outline across the whole frame. Supports:
//   position: top | bottom     (esmBot gravity 2 / 8; bottom also vertically flips)
//   color:    transparent | white | black
//   scale:    0.01 to 1.0       (esmBot yscale: band height as a fraction of image height)
//   flip:     mirror horizontally (esmBot flipX: points the tail the other way)
//
// Assets (esmBot's, grayscale+alpha, 1090×290):
//   speech.png:           luminance encodes the bubble interior (alpha cut-out mode)
//   speechbubble_esm.png: white-filled bubble for the solid white/black modes
//
// The core builder produces a FULL-CANVAS RGBA overlay (positioned band on a
// transparent canvas). White/black overlays are composited over the source;
// transparent produces a cut-out mask applied via dest-out (image) / alphamerge (GIF/video).
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createTempPath, cleanup } = require('./tempFiles');
const { runFFmpeg, mp4OutputOptions, gifPaletteGen, gifPaletteUse } = require('./ffmpegUtils');
const { evenNumber, getFrameRate, probeDimensions, outputFormatFor } = require('./mediaProbe');

const ASSET_DIR = path.join(__dirname, '..', '..', 'assets', 'mediaTemplates');
const WHITE_ASSET = path.join(ASSET_DIR, 'speechbubble_esm.png'); // white-filled bubble
const ALPHA_ASSET = path.join(ASSET_DIR, 'speech.png');           // luminance cut-out mask

const DEFAULT_SCALE = 0.2;

function clampScale(scale) {
    if (!Number.isFinite(scale)) return DEFAULT_SCALE;
    return Math.min(1, Math.max(0.01, scale));
}

// Band height in pixels for a given image height + scale (at least 1px).
function bandHeight(imgH, scale) {
    return Math.max(1, Math.round(imgH * clampScale(scale)));
}

// Build a full-size (imgW×imgH) transparent-canvas RGBA PNG with the bubble band
// placed at top/bottom. For white/black: the visible bubble. For transparent: a
// cut-out mask whose ALPHA is opaque exactly over the bubble interior (use with
// dest-out / alphamerge to punch that region out of the source).
async function buildBubbleOverlay(imgW, imgH, { position, color, scale, flip }) {
    const bandH = bandHeight(imgH, scale);
    const top = position === 'bottom' ? imgH - bandH : 0;

    let band;
    if (color === 'transparent') {
        // speech.png luminance: dark = interior (cut out), light = keep. Convert that
        // luminance into an alpha band where interior -> opaque (so dest-out erases it).
        let lum = sharp(ALPHA_ASSET).resize(imgW, bandH, { fit: 'fill' }).removeAlpha().toColourspace('b-w');
        if (flip) lum = lum.flop();
        if (position === 'bottom') lum = lum.flip();
        const alphaBuf = await lum.negate().toBuffer(); // interior(dark)->white->opaque alpha
        band = await sharp({ create: { width: imgW, height: bandH, channels: 3, background: { r: 0, g: 0, b: 0 } } })
            .joinChannel(alphaBuf)
            .png()
            .toBuffer();
    } else {
        // White-filled asset; negate RGB for black, keep the alpha shape.
        let bubble = sharp(WHITE_ASSET).resize(imgW, bandH, { fit: 'fill' });
        if (flip) bubble = bubble.flop();
        if (position === 'bottom') bubble = bubble.flip();
        bubble = bubble.ensureAlpha();
        if (color === 'black') bubble = bubble.negate({ alpha: false });
        band = await bubble.png().toBuffer();
    }

    // Place the band on a full-size transparent canvas at the right vertical offset.
    return sharp({ create: { width: imgW, height: imgH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: band, top, left: 0 }])
        .png()
        .toBuffer();
}

// ---------------------------------------------------------------------------
// Static image
// ---------------------------------------------------------------------------
async function renderSpeechBubbleImage(inputPath, opts) {
    const { position = 'top', color = 'transparent', scale = DEFAULT_SCALE, flip = false } = opts || {};
    const { width, height, format } = await sharp(inputPath).metadata();

    const MAX_WIDTH = 2048;
    const downscale = width > MAX_WIDTH ? MAX_WIDTH / width : 1;
    const outW = downscale < 1 ? Math.round(width * downscale) : width;
    const outH = downscale < 1 ? Math.round(height * downscale) : height;

    const overlay = await buildBubbleOverlay(outW, outH, { position, color, scale, flip });
    const baseInput = downscale < 1 ? await sharp(inputPath).resize(outW, outH).toBuffer() : inputPath;

    if (color === 'transparent') {
        const outputPath = createTempPath('png');
        await sharp(baseInput)
            .ensureAlpha()
            .composite([{ input: overlay, blend: 'dest-out' }])
            .png()
            .toFile(outputPath);
        return outputPath;
    }

    const { ext, applyFormat } = outputFormatFor(format);
    const outputPath = createTempPath(ext);
    await applyFormat(
        sharp(baseInput).composite([{ input: overlay, blend: 'over' }])
    ).toFile(outputPath);
    return outputPath;
}

// ---------------------------------------------------------------------------
// Animated GIF
// ---------------------------------------------------------------------------

/**
 * The filtergraph that puts the bubble on one frame.
 *
 * [0:v] is the scaled source, [1:v] the full-size overlay PNG rendered ahead of
 * time so this stays readable. White and black composite on top; transparent
 * punches the bubble out of the source's own alpha.
 *
 * The split is the whole point of this function existing. A filtergraph link
 * label feeds exactly ONE consumer, and the transparent branch used to read
 * [src] twice, once to extract its alpha and once to merge the result back
 * onto it. ffmpeg rejects the entire graph for that:
 *
 *     ffmpeg exited with code 234: Error binding filtergraph inputs/outputs:
 *     Invalid argument
 *
 * Transparent is the default colour, so this meant /speechbubble failed on
 * every animated GIF anyone tried it on.
 *
 * @param {number} width
 * @param {number} height
 * @param {'transparent'|'white'|'black'} color
 * @returns {string} a complexFilter chain ending in [bubbled]
 */
function bubbleChain(width, height, color) {
    const scaled = `[0:v]scale=${width}:${height}:flags=lanczos`;

    if (color !== 'transparent') {
        return `${scaled}[src];[src][1:v]overlay=0:0:format=auto[bubbled]`;
    }

    // alphaextract on the overlay is the region to cut. Subtracting it from the
    // source's own alpha makes that region transparent rather than white.
    return `${scaled},format=rgba,split=2[keep][alpha];`
        + `[1:v]alphaextract[mask];`
        + `[alpha]alphaextract[srcalpha];`
        + `[srcalpha][mask]blend=all_mode=subtract[cut];`
        + `[keep][cut]alphamerge[bubbled]`;
}

async function renderSpeechBubbleGif(inputPath, opts) {
    const { position = 'top', color = 'transparent', scale = DEFAULT_SCALE, flip = false } = opts || {};
    const dims = await probeDimensions(inputPath);
    const MAX_GIF_WIDTH = 1280;
    const gScale = dims.width > MAX_GIF_WIDTH ? MAX_GIF_WIDTH / dims.width : 1;
    const width = evenNumber(gScale < 1 ? dims.width * gScale : dims.width);
    const height = evenNumber(gScale < 1 ? dims.height * gScale : dims.height);
    const fps = await getFrameRate(inputPath);

    // Pre-render a full-size overlay so the filtergraph stays simple.
    const overlayBuf = await buildBubbleOverlay(width, height, { position, color, scale, flip });
    const overlayPath = createTempPath('png');
    const palettePath = createTempPath('png');
    const outputPath = createTempPath('gif');

    const reserveTransparent = color === 'transparent';
    const paletteGen = gifPaletteGen({ reserveTransparent });
    const paletteUse = gifPaletteUse({ reserveTransparent });

    const chain = bubbleChain(width, height, color);

    try {
        await fs.promises.writeFile(overlayPath, overlayBuf);

        await runFFmpeg(inputPath, palettePath, cmd => {
            cmd
                .input(overlayPath)
                .complexFilter(`${chain};[bubbled]fps=${fps},${paletteGen}`);
        });

        await runFFmpeg(inputPath, outputPath, cmd => {
            cmd
                .input(overlayPath)
                .input(palettePath)
                .complexFilter(`${chain};[bubbled]fps=${fps}[f];[f][2:v]${paletteUse}`)
                .outputOptions(['-loop', '0']);
        });

        return outputPath;
    } catch (err) {
        await cleanup(outputPath);
        throw err;
    } finally {
        await cleanup(overlayPath, palettePath);
    }
}

// ---------------------------------------------------------------------------
// Video (MP4). MP4 has no alpha, so transparent is downgraded to white.
// ---------------------------------------------------------------------------
async function renderSpeechBubbleVideo(inputPath, opts) {
    const { position = 'top', color = 'transparent', scale = DEFAULT_SCALE, flip = false } = opts || {};
    const effectiveColor = color === 'transparent' ? 'white' : color;

    const dims = await probeDimensions(inputPath);
    const MAX_VIDEO_WIDTH = 1920;
    const vScale = dims.width > MAX_VIDEO_WIDTH ? MAX_VIDEO_WIDTH / dims.width : 1;
    const width = evenNumber(vScale < 1 ? dims.width * vScale : dims.width);
    const height = evenNumber(vScale < 1 ? dims.height * vScale : dims.height);

    const overlayBuf = await buildBubbleOverlay(width, height, { position, color: effectiveColor, scale, flip });
    const overlayPath = createTempPath('png');
    const outputPath = createTempPath('mp4');

    try {
        await fs.promises.writeFile(overlayPath, overlayBuf);
        const outputOptions = await mp4OutputOptions(inputPath, {
            qualityMultiplier: 1.7,
            maxVideoKbps: 3000,
        });

        await runFFmpeg(inputPath, outputPath, cmd => {
            cmd
                .input(overlayPath)
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
        await cleanup(overlayPath);
    }
}

module.exports = {
    renderSpeechBubbleImage,
    renderSpeechBubbleGif,
    renderSpeechBubbleVideo,
    // Pure, and exported so the graph can be linted without ffmpeg or a GIF.
    bubbleChain,
    DEFAULT_SCALE,
};
