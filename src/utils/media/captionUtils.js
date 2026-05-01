// src/utils/media/captionUtils.js
// Uses pure SVG rendered via sharp/libvips — no native canvas binary required.
const fs = require('fs');
const sharp = require('sharp');
const { createTempPath, cleanup } = require('./tempFiles');
const { runFFmpeg, probeFile } = require('./ffmpegUtils');

function escapeXml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Rough per-character width estimate for Impact (condensed, roughly 0.55 em wide)
function estimateWidth(text, fontSize) {
    return text.length * fontSize * 0.55;
}

function wrapLines(text, maxWidth, fontSize) {
    const words = text.split(' ');
    const lines = [];
    let line = '';
    for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (estimateWidth(test, fontSize) > maxWidth && line) {
            lines.push(line);
            line = word;
        } else {
            line = test;
        }
    }
    if (line) lines.push(line);
    return lines;
}

// Build <tspan> elements for multi-line SVG text
function tspans(lines, cx, lineH) {
    return lines
        .map((l, i) => `<tspan x="${cx}" dy="${i === 0 ? 0 : lineH}">${escapeXml(l)}</tspan>`)
        .join('');
}

// White bar SVG with black text in MediaForge-like caption style
function buildCaptionSVG(text, width, fontSize) {
    const padding = Math.max(6, Math.floor(fontSize * 0.4));
    const lineH   = Math.ceil(fontSize * 1.25);
    const lines   = wrapLines(text, width - padding * 2, fontSize);
    const svgH    = lines.length * lineH + padding * 2;
    const cx      = width / 2;
    const baseY   = padding + fontSize; // y = text baseline of first line

    const body = tspans(lines, cx, lineH);

    return {
        svgH,
        svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${svgH}">
  <rect width="${width}" height="${svgH}" fill="white"/>
  <text x="${cx}" y="${baseY}" text-anchor="middle"
                font-family="Atkinson Hyperlegible,Atkinson Hyperlegible Bold,Arial,sans-serif"
        font-size="${fontSize}" font-weight="bold" fill="black">
    ${body}
  </text>
</svg>`,
    };
}

// Impact outline text SVG for meme overlay (white text with black stroke)
// Double-renders the text: stroke pass first, then fill pass on top.
function buildMemeTextSVG(text, width, imageHeight, isTop, fontSize) {
    const padding  = Math.max(6, Math.floor(fontSize * 0.4));
    const lineH    = Math.ceil(fontSize * 1.25);
    const strokeW  = Math.max(2, Math.ceil(fontSize * 0.09));
    const lines    = wrapLines(text.toUpperCase(), width - padding * 2, fontSize);
    const cx       = width / 2;

    const baseY = isTop
        ? padding + fontSize
        : imageHeight - padding - (lines.length - 1) * lineH;

    const body = tspans(lines, cx, lineH);
    const attrs = `x="${cx}" y="${baseY}" text-anchor="middle"
        font-family="Impact,Arial Black,sans-serif"
        font-size="${fontSize}" font-weight="bold"`;

    // Two passes: black stroke outline first, white fill on top
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${imageHeight}">
  <text ${attrs} stroke="black" stroke-width="${strokeW}" fill="none">${body}</text>
  <text ${attrs} fill="white" stroke="none">${body}</text>
</svg>`;
}

async function svgToPng(svgString) {
    return sharp(Buffer.from(svgString)).png().toBuffer();
}

// Returns the output extension and a sharp format applicator matching the source format.
// JPEG/WebP are re-encoded at quality 92 (high quality, good compression); everything else is PNG.
function outputFormatFor(format) {
    if (format === 'jpeg') return { ext: 'jpg', applyFormat: s => s.jpeg({ quality: 92 }) };
    if (format === 'webp') return { ext: 'webp', applyFormat: s => s.webp({ quality: 92 }) };
    return { ext: 'png', applyFormat: s => s.png() };
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

function evenNumber(n, fallback = 2) {
    const safe = Number.isFinite(n) ? Math.floor(n) : fallback;
    if (safe <= 0) return fallback;
    const even = safe % 2 === 0 ? safe : safe - 1;
    return even > 0 ? even : fallback;
}

// Extract the frame rate (FPS) of an input video/GIF to preserve animation speed
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

// Add a white caption bar above or below an image
async function renderCaption(inputPath, text, position = 'bottom') {
    const { width, height, format } = await sharp(inputPath).metadata();
    const { ext, applyFormat } = outputFormatFor(format);

    const MAX_WIDTH = 2048;
    const scale = width > MAX_WIDTH ? MAX_WIDTH / width : 1;
    const outW = scale < 1 ? Math.round(width * scale) : width;
    const outH = scale < 1 ? Math.round(height * scale) : height;

    const fontSize = Math.max(18, Math.floor(outW * 0.065));
    const { svg, svgH } = buildCaptionSVG(text, outW, fontSize);

    const captionBuf = await svgToPng(svg);
    const imageInput = scale < 1 ? await sharp(inputPath).resize(outW, outH).toBuffer() : inputPath;
    const outputPath = createTempPath(ext);

    await applyFormat(
        sharp({
            create: {
                width: outW,
                height: outH + svgH,
                channels: 4,
                background: { r: 255, g: 255, b: 255, alpha: 1 },
            },
        }).composite([
            { input: imageInput, top: position === 'bottom' ? 0    : svgH, left: 0 },
            { input: captionBuf, top: position === 'bottom' ? outH : 0,    left: 0 },
        ])
    ).toFile(outputPath);

    return outputPath;
}

// Add a white caption bar above or below a video
async function renderCaptionVideo(inputPath, text, position = 'bottom') {
    const probeData = await probeFile(inputPath);
    const videoStream = probeData.streams?.find(s => s.codec_type === 'video');
    if (!videoStream?.width || !videoStream?.height) {
        throw new Error('Could not determine video dimensions.');
    }

    const MAX_VIDEO_WIDTH = 1920;
    const vScale = videoStream.width > MAX_VIDEO_WIDTH ? MAX_VIDEO_WIDTH / videoStream.width : 1;
    const width = evenNumber(vScale < 1 ? videoStream.width * vScale : videoStream.width);
    const height = evenNumber(vScale < 1 ? videoStream.height * vScale : videoStream.height);
    const fontSize = Math.max(18, Math.floor(width * 0.065));
    const { svg, svgH } = buildCaptionSVG(text, width, fontSize);
    const captionHeight = svgH % 2 === 0 ? svgH : svgH + 1;

    const captionPath = createTempPath('png');
    const outputPath = createTempPath('mp4');

    const sourceBps = parseInt(videoStream.bit_rate || probeData.format?.bit_rate || 0, 10);
    const maxrateKbps = sourceBps > 0 ? Math.min(Math.round(sourceBps * 1.15 / 1000), 6000) : 0;
    const bitrateOpts = maxrateKbps > 0
        ? [`-maxrate ${maxrateKbps}k`, `-bufsize ${maxrateKbps * 2}k`]
        : [];

    try {
        const captionBuf = await svgToPng(svg);
        await fs.promises.writeFile(captionPath, captionBuf);

        const padOffsetY = position === 'top' ? captionHeight : 0;
        const overlayY = position === 'top' ? '0' : 'H-h';

        await runFFmpeg(inputPath, outputPath, cmd => {
            cmd
                .input(captionPath)
                .complexFilter([
                    `[0:v]scale=${width}:${height}:flags=lanczos[scaled]`,
                    `[scaled]pad=${width}:${height + captionHeight}:0:${padOffsetY}:color=white[padded]`,
                    `[1:v]scale=${width}:${captionHeight}:flags=lanczos[caption]`,
                    `[padded][caption]overlay=0:${overlayY}[v]`,
                ])
                .outputOptions([
                    '-map [v]',
                    '-map 0:a?',
                    '-c:v libx264',
                    '-preset veryfast',
                    '-crf 20',
                    ...bitrateOpts,
                    '-pix_fmt yuv420p',
                    '-movflags faststart',
                    '-c:a aac',
                    '-b:a 128k',
                    '-shortest',
                ]);
        });

        return outputPath;
    } catch (err) {
        await cleanup(outputPath);
        throw err;
    } finally {
        await cleanup(captionPath);
    }
}

// Add a white caption bar above or below an animated GIF, preserving animation and quality.
async function renderCaptionGif(inputPath, text, position = 'bottom') {
    const probeData = await probeFile(inputPath);
    const videoStream = probeData.streams?.find(s => s.codec_type === 'video');
    if (!videoStream?.width || !videoStream?.height) {
        throw new Error('Could not determine GIF dimensions.');
    }

    const MAX_GIF_WIDTH = 1280;
    const gScale = videoStream.width > MAX_GIF_WIDTH ? MAX_GIF_WIDTH / videoStream.width : 1;
    const width = evenNumber(gScale < 1 ? videoStream.width * gScale : videoStream.width);
    const height = evenNumber(gScale < 1 ? videoStream.height * gScale : videoStream.height);
    const fontSize = Math.max(18, Math.floor(width * 0.065));
    const { svg, svgH } = buildCaptionSVG(text, width, fontSize);
    const captionHeight = svgH % 2 === 0 ? svgH : svgH + 1;
    const fps = await getFrameRate(inputPath);

    const captionPath = createTempPath('png');
    const palettePath = createTempPath('png');
    const outputPath = createTempPath('gif');

    try {
        const captionBuf = await svgToPng(svg);
        await fs.promises.writeFile(captionPath, captionBuf);

        const padOffsetY = position === 'top' ? captionHeight : 0;
        const overlayY = position === 'top' ? '0' : 'H-h';
        const captionFilter = `[0:v]scale=${width}:${height}:flags=lanczos[scaled];[scaled]pad=${width}:${height + captionHeight}:0:${padOffsetY}:color=white[padded];[1:v]scale=${width}:${captionHeight}:flags=lanczos[caption];[padded][caption]overlay=0:${overlayY}[v]`;

        // Pass 1: Generate palette from the captioned video with FPS applied
        await new Promise((resolve, reject) => {
            const ffmpeg = require('fluent-ffmpeg');
            ffmpeg(inputPath)
                .input(captionPath)
                .complexFilter(`${captionFilter};[v]fps=${fps},palettegen=max_colors=256:reserve_transparent=0`)
                .on('end', resolve)
                .on('error', err => reject(new Error(`FFmpeg palette error: ${err.message}`)))
                .save(palettePath);
        });

        // Pass 2: Render GIF using the palette with Sierra2-4a dithering for color quality
        await new Promise((resolve, reject) => {
            const ffmpeg = require('fluent-ffmpeg');
            ffmpeg(inputPath)
                .input(captionPath)
                .input(palettePath)
                .complexFilter(`${captionFilter};[v]fps=${fps}[f];[f][2:v]paletteuse=dither=sierra2_4a`)
                .outputOptions(['-an', '-loop', '0'])
                .on('end', resolve)
                .on('error', err => reject(new Error(`FFmpeg GIF error: ${err.message}`)))
                .save(outputPath);
        });

        return outputPath;
    } catch (err) {
        await cleanup(outputPath);
        throw err;
    } finally {
        await cleanup(captionPath, palettePath);
    }
}

// Overlay classic Impact meme text (top and/or bottom) onto an image
async function renderMeme(inputPath, topText, bottomText) {
    const { width, height, format } = await sharp(inputPath).metadata();
    const { ext, applyFormat } = outputFormatFor(format);

    const MAX_WIDTH = 2048;
    const scale = width > MAX_WIDTH ? MAX_WIDTH / width : 1;
    const outW = scale < 1 ? Math.round(width * scale) : width;
    const outH = scale < 1 ? Math.round(height * scale) : height;

    const fontSize = Math.max(18, Math.floor(outW * 0.07));

    const composites = [];
    if (topText) {
        composites.push({
            input: await svgToPng(buildMemeTextSVG(topText, outW, outH, true, fontSize)),
            top: 0, left: 0,
        });
    }
    if (bottomText) {
        composites.push({
            input: await svgToPng(buildMemeTextSVG(bottomText, outW, outH, false, fontSize)),
            top: 0, left: 0,
        });
    }

    const outputPath = createTempPath(ext);
    let base = sharp(inputPath);
    if (scale < 1) base = base.resize(outW, outH);
    await applyFormat(base.composite(composites)).toFile(outputPath);
    return outputPath;
}

// Overlay top/bottom meme text on a video, preserving it as a video.
async function renderMemeVideo(inputPath, topText, bottomText) {
    const probeData = await probeFile(inputPath);
    const videoStream = probeData.streams?.find(s => s.codec_type === 'video');
    if (!videoStream?.width || !videoStream?.height) {
        throw new Error('Could not determine video dimensions.');
    }

    const MAX_VIDEO_WIDTH = 1920;
    const vScale = videoStream.width > MAX_VIDEO_WIDTH ? MAX_VIDEO_WIDTH / videoStream.width : 1;
    const width = evenNumber(vScale < 1 ? videoStream.width * vScale : videoStream.width);
    const height = evenNumber(vScale < 1 ? videoStream.height * vScale : videoStream.height);
    const fontSize = Math.max(18, Math.floor(width * 0.07));

    const overlays = [];
    if (topText) {
        overlays.push({
            input: await svgToPng(buildMemeTextSVG(topText, width, height, true, fontSize)),
            top: 0,
            left: 0,
        });
    }
    if (bottomText) {
        overlays.push({
            input: await svgToPng(buildMemeTextSVG(bottomText, width, height, false, fontSize)),
            top: 0,
            left: 0,
        });
    }

    const overlayPath = createTempPath('png');
    const outputPath = createTempPath('mp4');

    try {
        await sharp({
            create: {
                width,
                height,
                channels: 4,
                background: { r: 0, g: 0, b: 0, alpha: 0 },
            },
        })
            .composite(overlays)
            .png()
            .toFile(overlayPath);

        await runFFmpeg(inputPath, outputPath, cmd => {
            cmd
                .input(overlayPath)
                .complexFilter([
                    `[0:v]scale=${width}:${height}:flags=lanczos[scaled]`,
                    '[scaled][1:v]overlay=0:0:format=auto[v]',
                ])
                .outputOptions([
                    '-map [v]',
                    '-map 0:a?',
                    '-c:v libx264',
                    '-preset veryfast',
                    '-crf 20',
                    '-pix_fmt yuv420p',
                    '-movflags faststart',
                    '-c:a aac',
                    '-b:a 128k',
                    '-shortest',
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

// Overlay top/bottom meme text on an animated GIF, preserving animation and quality.
async function renderMemeGif(inputPath, topText, bottomText) {
    const probeData = await probeFile(inputPath);
    const videoStream = probeData.streams?.find(s => s.codec_type === 'video');
    if (!videoStream?.width || !videoStream?.height) {
        throw new Error('Could not determine GIF dimensions.');
    }

    const MAX_GIF_WIDTH = 1280;
    const gScale = videoStream.width > MAX_GIF_WIDTH ? MAX_GIF_WIDTH / videoStream.width : 1;
    const width = evenNumber(gScale < 1 ? videoStream.width * gScale : videoStream.width);
    const height = evenNumber(gScale < 1 ? videoStream.height * gScale : videoStream.height);
    const fontSize = Math.max(18, Math.floor(width * 0.07));
    const fps = await getFrameRate(inputPath);

    const overlays = [];
    if (topText) {
        overlays.push({
            input: await svgToPng(buildMemeTextSVG(topText, width, height, true, fontSize)),
            top: 0,
            left: 0,
        });
    }
    if (bottomText) {
        overlays.push({
            input: await svgToPng(buildMemeTextSVG(bottomText, width, height, false, fontSize)),
            top: 0,
            left: 0,
        });
    }

    const overlayPath = createTempPath('png');
    const palettePath = createTempPath('png');
    const outputPath = createTempPath('gif');

    try {
        await sharp({
            create: {
                width,
                height,
                channels: 4,
                background: { r: 0, g: 0, b: 0, alpha: 0 },
            },
        })
            .composite(overlays)
            .png()
            .toFile(overlayPath);

        const memeFilter = `[0:v][1:v]overlay=0:0:format=auto[v]`;

        // Pass 1: Generate palette from the meme-overlay GIF with FPS applied
        await new Promise((resolve, reject) => {
            const ffmpeg = require('fluent-ffmpeg');
            ffmpeg(inputPath)
                .input(overlayPath)
                .complexFilter(`${memeFilter};[v]fps=${fps},palettegen=max_colors=256:reserve_transparent=0`)
                .on('end', resolve)
                .on('error', err => reject(new Error(`FFmpeg palette error: ${err.message}`)))
                .save(palettePath);
        });

        // Pass 2: Render GIF using the palette with Sierra2-4a dithering for color quality
        await new Promise((resolve, reject) => {
            const ffmpeg = require('fluent-ffmpeg');
            ffmpeg(inputPath)
                .input(overlayPath)
                .input(palettePath)
                .complexFilter(`${memeFilter};[v]fps=${fps}[f];[f][2:v]paletteuse=dither=sierra2_4a`)
                .outputOptions(['-an', '-loop', '0'])
                .on('end', resolve)
                .on('error', err => reject(new Error(`FFmpeg GIF error: ${err.message}`)))
                .save(outputPath);
        });

        return outputPath;
    } catch (err) {
        await cleanup(outputPath);
        throw err;
    } finally {
        await cleanup(overlayPath, palettePath);
    }
}

module.exports = {
    renderCaption,
    renderCaptionVideo,
    renderCaptionGif,
    renderMeme,
    renderMemeVideo,
    renderMemeGif,
    isAnimatedImage,
    isGifImage,
};
