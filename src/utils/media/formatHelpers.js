const path = require('path');
const sharp = require('sharp');
const { AttachmentBuilder } = require('discord.js');

const DEFAULT_IMAGE_FORMAT = { ext: 'png', format: 'png', options: {} };
const STATIC_IMAGE_FORMATS = {
    jpg: { ext: 'jpg', format: 'jpeg', options: { quality: 92 } },
    jpeg: { ext: 'jpg', format: 'jpeg', options: { quality: 92 } },
    png: { ext: 'png', format: 'png', options: {} },
    webp: { ext: 'webp', format: 'webp', options: { quality: 92 } },
    avif: { ext: 'avif', format: 'avif', options: { quality: 80 } },
};

function normalizeExt(ext) {
    return String(ext || '')
        .trim()
        .toLowerCase()
        .replace(/^\./, '');
}

function isGifExt(ext) {
    return normalizeExt(ext) === 'gif';
}

function staticImageFormatForExt(ext) {
    return STATIC_IMAGE_FORMATS[normalizeExt(ext)] || DEFAULT_IMAGE_FORMAT;
}

function applySharpFormat(pipeline, formatInfo, overrides = {}) {
    const options = { ...(formatInfo.options || {}), ...(overrides[formatInfo.format] || {}) };
    return Object.keys(options).length
        ? pipeline[formatInfo.format](options)
        : pipeline[formatInfo.format]();
}

async function isGifFile(inputPath) {
    try {
        const meta = await sharp(inputPath, { animated: true }).metadata();
        return meta.format === 'gif';
    } catch {
        return false;
    }
}

async function isGifInput(inputPath, ext = '', mediaContext = {}) {
    return mediaContext?.isGifLike === true
        || isGifExt(ext)
        || await isGifFile(inputPath);
}

function mediaFilePayload(outputPath, commandName = 'media') {
    const ext = normalizeExt(path.extname(outputPath)) || 'bin';
    const safeCommandName = String(commandName || 'media').replace(/[^a-z0-9_-]/gi, '_') || 'media';
    return new AttachmentBuilder(outputPath, { name: `${safeCommandName}.${ext}` });
}

module.exports = {
    normalizeExt,
    isGifExt,
    isGifFile,
    isGifInput,
    staticImageFormatForExt,
    applySharpFormat,
    mediaFilePayload,
};
