// src/utils/media/captionUtils.js
const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');
const fs = require('fs');
const { getMetadata } = require('./imageUtils');
const { createTempPath } = require('./tempFiles');

const FONTS_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');

// Register fonts once at load time
const fontRegistrations = [
    { file: 'ImpactMix.ttf', family: 'Impact' },
    { file: 'arial.ttf', family: 'Arial' },
    { file: 'caption.otf', family: 'Caption' },
    { file: 'Ubuntu-R.ttf', family: 'Ubuntu' },
];

for (const { file, family } of fontRegistrations) {
    try {
        registerFont(path.join(FONTS_DIR, file), { family });
    } catch {}
}

function wrapText(ctx, text, maxWidth) {
    const words = text.split(' ');
    const lines = [];
    let current = '';
    for (const word of words) {
        const test = current ? `${current} ${word}` : word;
        if (ctx.measureText(test).width > maxWidth && current) {
            lines.push(current);
            current = word;
        } else {
            current = test;
        }
    }
    if (current) lines.push(current);
    return lines;
}

function drawImpactText(ctx, lines, centerX, startY, lineHeight, fontSize) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = Math.max(2, fontSize * 0.08);
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < lines.length; i++) {
        const y = startY + i * lineHeight;
        ctx.strokeText(lines[i], centerX, y);
        ctx.fillText(lines[i], centerX, y);
    }
}

// Render a white caption bar with Impact text above or below the image
async function renderCaption(inputPath, text, position = 'bottom') {
    const meta = await getMetadata(inputPath);
    const { width, height } = meta;

    const fontSize = Math.max(18, Math.floor(width * 0.065));
    const padding = Math.floor(fontSize * 0.5);
    const lineHeight = fontSize * 1.2;

    // Measure wrapped lines using a scratch canvas
    const scratch = createCanvas(width, 100);
    const scratchCtx = scratch.getContext('2d');
    scratchCtx.font = `bold ${fontSize}px Impact`;
    const lines = wrapText(scratchCtx, text.toUpperCase(), width - padding * 2);

    const captionHeight = Math.ceil(lines.length * lineHeight + padding * 2);
    const totalHeight = height + captionHeight;

    const canvas = createCanvas(width, totalHeight);
    const ctx = canvas.getContext('2d');

    // White background for the entire canvas
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, totalHeight);

    const img = await loadImage(inputPath);
    ctx.font = `bold ${fontSize}px Impact`;

    if (position === 'top') {
        ctx.drawImage(img, 0, captionHeight, width, height);
        drawImpactText(ctx, lines, width / 2, padding, lineHeight, fontSize);
    } else {
        ctx.drawImage(img, 0, 0, width, height);
        drawImpactText(ctx, lines, width / 2, height + padding, lineHeight, fontSize);
    }

    const outputPath = createTempPath('png');
    fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
    return outputPath;
}

// Render classic top+bottom meme Impact text directly onto the image
async function renderMeme(inputPath, topText, bottomText) {
    const meta = await getMetadata(inputPath);
    const { width, height } = meta;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const img = await loadImage(inputPath);
    ctx.drawImage(img, 0, 0, width, height);

    const fontSize = Math.max(18, Math.floor(width * 0.07));
    const padding = Math.floor(fontSize * 0.4);
    const lineHeight = fontSize * 1.15;
    ctx.font = `bold ${fontSize}px Impact`;

    if (topText) {
        const lines = wrapText(ctx, topText.toUpperCase(), width - padding * 2);
        drawImpactText(ctx, lines, width / 2, padding, lineHeight, fontSize);
    }

    if (bottomText) {
        const lines = wrapText(ctx, bottomText.toUpperCase(), width - padding * 2);
        const blockHeight = lines.length * lineHeight;
        const startY = height - padding - blockHeight;
        drawImpactText(ctx, lines, width / 2, startY, lineHeight, fontSize);
    }

    const outputPath = createTempPath('png');
    fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
    return outputPath;
}

module.exports = { renderCaption, renderMeme };
