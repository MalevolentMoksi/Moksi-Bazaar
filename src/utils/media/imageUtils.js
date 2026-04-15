// src/utils/media/imageUtils.js
const sharp = require('sharp');
const { createTempPath } = require('./tempFiles');

// Convert an image to the specified format (png, jpeg, webp, gif, avif)
async function toFormat(inputPath, format, options = {}) {
    const ext = format === 'jpeg' ? 'jpg' : format;
    const outputPath = createTempPath(ext);
    await sharp(inputPath, { animated: false })[format](options).toFile(outputPath);
    return outputPath;
}

async function resize(inputPath, width, height) {
    const outputPath = createTempPath('png');
    await sharp(inputPath, { animated: false })
        .resize(width || null, height || null, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toFile(outputPath);
    return outputPath;
}

async function rotate(inputPath, degrees) {
    const outputPath = createTempPath('png');
    await sharp(inputPath, { animated: false })
        .rotate(degrees)
        .png()
        .toFile(outputPath);
    return outputPath;
}

async function flip(inputPath) {
    const outputPath = createTempPath('png');
    await sharp(inputPath, { animated: false }).flip().png().toFile(outputPath);
    return outputPath;
}

async function flop(inputPath) {
    const outputPath = createTempPath('png');
    await sharp(inputPath, { animated: false }).flop().png().toFile(outputPath);
    return outputPath;
}

async function blur(inputPath, sigma) {
    const outputPath = createTempPath('png');
    await sharp(inputPath, { animated: false }).blur(sigma).png().toFile(outputPath);
    return outputPath;
}

async function invert(inputPath) {
    const outputPath = createTempPath('png');
    await sharp(inputPath, { animated: false }).negate({ alpha: false }).png().toFile(outputPath);
    return outputPath;
}

async function grayscale(inputPath) {
    const outputPath = createTempPath('png');
    await sharp(inputPath, { animated: false }).grayscale().png().toFile(outputPath);
    return outputPath;
}

async function deepfry(inputPath) {
    // Heavy saturation + sharpen + low-quality JPEG encoding = deep fried aesthetic
    const outputPath = createTempPath('jpg');
    await sharp(inputPath, { animated: false })
        .modulate({ saturation: 4, brightness: 1.1 })
        .sharpen({ sigma: 2, m1: 1, m2: 5 })
        .jpeg({ quality: 1, chromaSubsampling: '4:2:0' })
        .toFile(outputPath);
    return outputPath;
}

// Get image dimensions
async function getMetadata(inputPath) {
    return sharp(inputPath).metadata();
}

module.exports = { toFormat, resize, rotate, flip, flop, blur, invert, grayscale, deepfry, getMetadata };
