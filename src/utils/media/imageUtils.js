// src/utils/media/imageUtils.js
const sharp = require('sharp');
const { createTempPath } = require('./tempFiles');
const { runFFmpeg } = require('./ffmpegUtils');

function isGifExt(ext) {
    return String(ext || '').toLowerCase() === 'gif';
}

async function gifFilter(inputPath, filter, outputExt = 'gif') {
    const outputPath = createTempPath(outputExt);
    await runFFmpeg(inputPath, outputPath, cmd => {
        cmd
            .videoFilters(filter)
            .outputOptions([
                '-an',
                '-loop 0',
                '-gifflags -offsetting',
            ]);
    });
    return outputPath;
}

// Convert an image to the specified format (png, jpeg, webp, gif, avif)
async function toFormat(inputPath, format, options = {}, inputExt = '') {
    const outputExt = format === 'jpeg' ? 'jpg' : format;
    const outputPath = createTempPath(outputExt);

    if (isGifExt(inputExt) && format === 'webp') {
        await runFFmpeg(inputPath, outputPath, cmd => {
            cmd.outputOptions([
                '-an',
                '-loop 0',
                '-c:v libwebp_anim',
                '-quality 80',
                '-compression_level 6',
            ]);
        });
        return outputPath;
    }

    await sharp(inputPath, { animated: false })[format](options).toFile(outputPath);
    return outputPath;
}

async function resize(inputPath, width, height, ext = '') {
    if (isGifExt(ext)) {
        if (width && height) {
            return gifFilter(inputPath, `scale=${width}:${height}:force_original_aspect_ratio=decrease`);
        }
        if (width) {
            return gifFilter(inputPath, `scale=${width}:-1`);
        }
        if (height) {
            return gifFilter(inputPath, `scale=-1:${height}`);
        }
    }

    const outputPath = createTempPath('png');
    await sharp(inputPath, { animated: false })
        .resize(width || null, height || null, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toFile(outputPath);
    return outputPath;
}

async function rotate(inputPath, degrees, ext = '') {
    if (isGifExt(ext)) {
        const radians = `${degrees}*PI/180`;
        return gifFilter(inputPath, `rotate=${radians}:ow=rotw(${radians}):oh=roth(${radians}):fillcolor=black`);
    }

    const outputPath = createTempPath('png');
    await sharp(inputPath, { animated: false })
        .rotate(degrees)
        .png()
        .toFile(outputPath);
    return outputPath;
}

async function flip(inputPath, ext = '') {
    if (isGifExt(ext)) {
        return gifFilter(inputPath, 'vflip');
    }

    const outputPath = createTempPath('png');
    await sharp(inputPath, { animated: false }).flip().png().toFile(outputPath);
    return outputPath;
}

async function flop(inputPath, ext = '') {
    if (isGifExt(ext)) {
        return gifFilter(inputPath, 'hflip');
    }

    const outputPath = createTempPath('png');
    await sharp(inputPath, { animated: false }).flop().png().toFile(outputPath);
    return outputPath;
}

async function blur(inputPath, sigma, ext = '') {
    if (isGifExt(ext)) {
        return gifFilter(inputPath, `gblur=sigma=${sigma}`);
    }

    const outputPath = createTempPath('png');
    await sharp(inputPath, { animated: false }).blur(sigma).png().toFile(outputPath);
    return outputPath;
}

async function invert(inputPath, ext = '') {
    if (isGifExt(ext)) {
        return gifFilter(inputPath, 'negate');
    }

    const outputPath = createTempPath('png');
    await sharp(inputPath, { animated: false }).negate({ alpha: false }).png().toFile(outputPath);
    return outputPath;
}

async function grayscale(inputPath, ext = '') {
    if (isGifExt(ext)) {
        return gifFilter(inputPath, 'hue=s=0');
    }

    const outputPath = createTempPath('png');
    await sharp(inputPath, { animated: false }).grayscale().png().toFile(outputPath);
    return outputPath;
}

async function deepfry(inputPath, ext = '') {
    if (isGifExt(ext)) {
        return gifFilter(inputPath, 'eq=saturation=4:contrast=1.45:brightness=0.04,unsharp=5:5:1.2:5:5:0,noise=alls=12:allf=t+u');
    }

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
