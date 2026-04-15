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

// White bar SVG with black Impact text (for /caption command)
function buildCaptionSVG(text, width, fontSize) {
    const padding = Math.max(6, Math.floor(fontSize * 0.4));
    const lineH   = Math.ceil(fontSize * 1.25);
    const lines   = wrapLines(text.toUpperCase(), width - padding * 2, fontSize);
    const svgH    = lines.length * lineH + padding * 2;
    const cx      = width / 2;
    const baseY   = padding + fontSize; // y = text baseline of first line

    const body = tspans(lines, cx, lineH);

    return {
        svgH,
        svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${svgH}">
  <rect width="${width}" height="${svgH}" fill="white"/>
  <text x="${cx}" y="${baseY}" text-anchor="middle"
        font-family="Impact,Arial Black,sans-serif"
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

function evenNumber(n, fallback = 2) {
    const safe = Number.isFinite(n) ? Math.floor(n) : fallback;
    if (safe <= 0) return fallback;
    return safe % 2 === 0 ? safe : safe - 1;
}

// Add a white Impact-text caption bar above or below an image
async function renderCaption(inputPath, text, position = 'bottom') {
    const { width, height } = await sharp(inputPath).metadata();
    const fontSize = Math.max(18, Math.floor(width * 0.065));
    const { svg, svgH } = buildCaptionSVG(text, width, fontSize);

    const captionBuf = await svgToPng(svg);
    const outputPath  = createTempPath('png');

    await sharp({
        create: {
            width,
            height: height + svgH,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 1 },
        },
    })
    .composite([
        { input: inputPath,  top: position === 'bottom' ? 0      : svgH,   left: 0 },
        { input: captionBuf, top: position === 'bottom' ? height : 0,       left: 0 },
    ])
    .png()
    .toFile(outputPath);

    return outputPath;
}

// Add a white Impact-text caption bar above or below a video
async function renderCaptionVideo(inputPath, text, position = 'bottom') {
    const probeData = await probeFile(inputPath);
    const videoStream = probeData.streams?.find(s => s.codec_type === 'video');
    if (!videoStream?.width || !videoStream?.height) {
        throw new Error('Could not determine video dimensions.');
    }

    const width = evenNumber(videoStream.width);
    const height = evenNumber(videoStream.height);
    const fontSize = Math.max(18, Math.floor(width * 0.065));
    const { svg, svgH } = buildCaptionSVG(text, width, fontSize);
    const captionHeight = svgH % 2 === 0 ? svgH : svgH + 1;

    const captionPath = createTempPath('png');
    const outputPath = createTempPath('mp4');

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
                    '-pix_fmt yuv420p',
                    '-movflags faststart',
                    '-c:a copy',
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

// Overlay classic Impact meme text (top and/or bottom) onto an image
async function renderMeme(inputPath, topText, bottomText) {
    const { width, height } = await sharp(inputPath).metadata();
    const fontSize = Math.max(18, Math.floor(width * 0.07));

    const composites = [];
    if (topText) {
        composites.push({
            input: await svgToPng(buildMemeTextSVG(topText, width, height, true, fontSize)),
            top: 0, left: 0,
        });
    }
    if (bottomText) {
        composites.push({
            input: await svgToPng(buildMemeTextSVG(bottomText, width, height, false, fontSize)),
            top: 0, left: 0,
        });
    }

    const outputPath = createTempPath('png');
    await sharp(inputPath).composite(composites).png().toFile(outputPath);
    return outputPath;
}

module.exports = { renderCaption, renderCaptionVideo, renderMeme };
