// src/utils/media/mediaHelpers.js
const fs = require('fs');
const { downloadToTemp, cleanup, extFromUrl, IMAGE_EXTS, VIDEO_EXTS } = require('./tempFiles');

const MAX_FILE_SIZE = 24 * 1024 * 1024; // 24 MB (Discord limit is 25 MB)

/**
 * Download the `media` attachment option from an interaction and run processFn on it.
 * Handles deferring, errors, size checks, and temp file cleanup automatically.
 *
 * processFn(inputPath, ext) should return a string path to the output file.
 */
async function handleMediaCommand(interaction, { allowVideo = false, allowImage = true, processFn }) {
    await interaction.deferReply();

    const attachment = interaction.options.getAttachment('media');
    if (!attachment) {
        return interaction.editReply('Please attach an image or video.');
    }

    const ext = extFromUrl(attachment.url);
    const isImage = IMAGE_EXTS.has(ext) || IMAGE_EXTS.has(extFromUrl(attachment.contentType || ''));
    const isVideo = VIDEO_EXTS.has(ext) || VIDEO_EXTS.has(extFromUrl(attachment.contentType || ''));

    if (allowImage && !allowVideo && !isImage) {
        return interaction.editReply('Please attach an image file (PNG, JPG, WEBP, etc.).');
    }
    if (!allowImage && allowVideo && !isVideo) {
        return interaction.editReply('Please attach a video file (MP4, MOV, WebM, etc.).');
    }
    if (!isImage && !isVideo) {
        return interaction.editReply('Unsupported file type. Please attach an image or video.');
    }

    // Infer extension from content type if URL ext is missing
    const inputExt = ext || contentTypeToExt(attachment.contentType) || 'bin';
    const inputPath = await downloadToTemp(attachment.url, inputExt);
    let outputPath = null;

    try {
        outputPath = await processFn(inputPath, inputExt, { isImage, isVideo });

        const stats = fs.statSync(outputPath);
        if (stats.size > MAX_FILE_SIZE) {
            return interaction.editReply('⚠️ The output file is too large to send (24 MB limit).');
        }

        await interaction.editReply({ files: [outputPath] });
    } catch (err) {
        const msg = err.message || 'An unknown error occurred.';
        try {
            await interaction.editReply(`❌ Processing failed: ${msg}`);
        } catch {}
        throw err; // let interactionCreate logger catch it too
    } finally {
        await cleanup(inputPath, outputPath);
    }
}

function contentTypeToExt(ct) {
    if (!ct) return null;
    const map = {
        'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
        'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov',
        'video/webm': 'webm',
    };
    return map[ct.split(';')[0].trim()] || null;
}

module.exports = { handleMediaCommand };
