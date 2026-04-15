// src/utils/media/captionUtils.js
// Uses pure SVG rendered via sharp/libvips — no native canvas binary required.
const fs = require('fs');
const sharp = require('sharp');
const { createTempPath } = require('./tempFiles');

const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;

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

async function preferSmallerRaster(outputPath) {
    const originalStats = await fs.promises.stat(outputPath);
    if (originalStats.size <= MAX_ATTACHMENT_BYTES) {
        return outputPath;
    }

    const fallbackPath = createTempPath('jpg');
    await sharp(outputPath).jpeg({ quality: 92, mozjpeg: true }).toFile(fallbackPath);

    const fallbackStats = await fs.promises.stat(fallbackPath);
    if (fallbackStats.size < originalStats.size) {
        try { await fs.promises.unlink(outputPath); } catch {}
        return fallbackPath;
    }

    try { await fs.promises.unlink(fallbackPath); } catch {}
    return outputPath;
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
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(outputPath);

    return preferSmallerRaster(outputPath);
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
    await sharp(inputPath).composite(composites).png({ compressionLevel: 9, adaptiveFiltering: true }).toFile(outputPath);
    return preferSmallerRaster(outputPath);
}

module.exports = { renderCaption, renderMeme };
