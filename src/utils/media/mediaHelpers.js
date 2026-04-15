// src/utils/media/mediaHelpers.js
const fs = require('fs');
const logger = require('../logger');
const { downloadToTemp, cleanup, extFromUrl, IMAGE_EXTS, VIDEO_EXTS } = require('./tempFiles');

const MAX_FILE_SIZE = 24 * 1024 * 1024; // 24 MB — Discord bot upload limit is 25 MB

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extFromContentType(ct) {
    if (!ct) return '';
    const sub = ct.split('/')[1]?.split(';')[0]?.trim().toLowerCase();
    if (!sub) return '';
    const aliases = { jpeg: 'jpg', quicktime: 'mov', 'x-msvideo': 'avi', 'x-matroska': 'mkv' };
    return aliases[sub] || sub;
}

function resolveMedia(url, contentType, backupUrl = null) {
    const urlExt = extFromUrl(url);
    const contentTypeExt = extFromContentType(contentType);
    const ext = (urlExt && urlExt !== 'bin') ? urlExt : contentTypeExt;
    if (!ext) return null;

    const isImage = IMAGE_EXTS.has(ext);
    const isVideo = VIDEO_EXTS.has(ext);
    if (!isImage && !isVideo) return null;

    return { url, backupUrl, ext, isImage, isVideo };
}

async function downloadMediaToTemp(mediaInfo) {
    try {
        return await downloadToTemp(mediaInfo.url, mediaInfo.ext);
    } catch (primaryErr) {
        if (!mediaInfo.backupUrl || mediaInfo.backupUrl === mediaInfo.url) throw primaryErr;
        try {
            return await downloadToTemp(mediaInfo.backupUrl, mediaInfo.ext);
        } catch (secondaryErr) {
            const combinedErr = new Error(
                `Failed to download media from both primary and proxy URLs: ${secondaryErr.message}`
            );
            combinedErr.cause = primaryErr;
            throw combinedErr;
        }
    }
}

// ---------------------------------------------------------------------------
// Recent-message media scanner
// ---------------------------------------------------------------------------

async function fetchRecentMedia(interaction, {
    allowImage = true,
    allowVideo = true,
    mediaPredicate = null,
} = {}) {
    try {
        const channel = interaction.channel;
        if (!channel?.messages?.fetch) return null;

        const messages = await channel.messages.fetch({ limit: 20 });

        for (const msg of messages.values()) {
            // Attachments
            for (const att of msg.attachments.values()) {
                const info = resolveMedia(att.url, att.contentType, att.proxyURL);
                if (!info) continue;
                const allowedByType = (allowImage && info.isImage) || (allowVideo && info.isVideo);
                const allowedByPredicate = !mediaPredicate || mediaPredicate(info);
                if (allowedByType && allowedByPredicate) return info;
            }

            // Image embeds (e.g. image links Discord auto-previews)
            if (allowImage) {
                for (const embed of msg.embeds) {
                    for (const key of ['image', 'thumbnail']) {
                        const src = embed[key]?.url || embed[key]?.proxyURL;
                        if (!src) continue;
                        const info = resolveMedia(src, null, embed[key]?.proxyURL);
                        if (!info?.isImage) continue;
                        if (!mediaPredicate || mediaPredicate(info)) return info;
                    }
                }
            }
        }
    } catch {
        // Channel not accessible or rate-limited — silent fallthrough
    }
    return null;
}

// ---------------------------------------------------------------------------
// Main command wrapper
// ---------------------------------------------------------------------------

/**
 * Standard wrapper for all media commands.
 * - Tries the explicit `media` attachment option first.
 * - Falls back to the most recent image/video in the channel.
 * - Defers the reply, downloads the file, runs processFn, sends the result.
 *
 * processFn(inputPath, ext, { isImage, isVideo }) → Promise<string outputPath>
 */
async function handleMediaCommand(interaction, {
    allowVideo = false,
    allowImage = true,
    processFn,
    mediaPredicate = null,
    invalidMediaMessage = null,
}) {
    await interaction.deferReply();

    // 1. Explicit attachment takes priority
    let mediaInfo = null;
    let usedRecentFallback = false;
    const attachment = interaction.options.getAttachment('media');
    if (attachment) {
        mediaInfo = resolveMedia(attachment.url, attachment.contentType, attachment.proxyURL);
        if (!mediaInfo) {
            return interaction.editReply(
                'The provided attachment is not a supported image/video format for this command.'
            );
        }
        if (mediaPredicate && !mediaPredicate(mediaInfo)) {
            return interaction.editReply(invalidMediaMessage || 'That media type is not supported for this command.');
        }
    }

    // 2. Fall back to recent channel messages
    if (!mediaInfo) {
        mediaInfo = await fetchRecentMedia(interaction, { allowImage, allowVideo, mediaPredicate });
        usedRecentFallback = Boolean(mediaInfo);
    }

    // 3. Nothing found anywhere
    if (!mediaInfo) {
        return interaction.editReply(
            'No media found. Attach an image/video to the command, or use it in a channel where media was recently posted.'
        );
    }

    const { url, ext, isImage, isVideo } = mediaInfo;

    // 4. Type guard
    if (allowImage && !allowVideo && !isImage) {
        return interaction.editReply('That file doesn\'t look like an image. Please provide a PNG, JPG, WEBP, or similar.');
    }
    if (!allowImage && allowVideo && !isVideo) {
        return interaction.editReply('That file doesn\'t look like a video. Please provide an MP4, MOV, WebM, or similar.');
    }
    if (mediaPredicate && !mediaPredicate(mediaInfo)) {
        return interaction.editReply(invalidMediaMessage || 'That media type is not supported for this command.');
    }

    let inputPath = null;
    let outputPath = null;

    try {
        inputPath = await downloadMediaToTemp(mediaInfo);
        outputPath = await processFn(inputPath, ext, { isImage, isVideo });

        if (!outputPath) throw new Error('Processing produced no output file.');

        const stats = fs.statSync(outputPath);
        if (stats.size > MAX_FILE_SIZE) {
            return interaction.editReply(
                `⚠️ Output is too large to send (${Math.round(stats.size / 1024 / 1024)} MB — Discord's limit is 25 MB).\n` +
                'Try a smaller input, lower resolution, or shorter duration.'
            );
        }

        const replyPayload = { files: [outputPath] };
        if (usedRecentFallback) {
            replyPayload.content = 'Using the most recent compatible media in this channel.';
        }
        await interaction.editReply(replyPayload);
    } catch (err) {
        const rawErrorText = [
            err?.message,
            err?.rawError?.message,
            err?.cause?.message,
        ]
            .filter(Boolean)
            .join(' | ');

        // Log full details to Railway for debugging
        logger.error('Media command failed', {
            command: interaction.commandName,
            userId: interaction.user.id,
            errorName: err.name,
            errorCode: err.code,
            error: rawErrorText || err.message,
            stack: err.stack,
        });

        // Discord API 40005 = "Request entity too large"
        const lowered = (rawErrorText || '').toLowerCase();
        const isDiscordSizeError = err.code === 40005 || err.status === 413
            || lowered.includes('entity too large')
            || lowered.includes('request entity too large')
            || (lowered.includes('max file size') && lowered.includes('mb'));

        const reply = isDiscordSizeError
            ? '⚠️ The output file is too large for Discord (max 25 MB). Try a smaller/shorter input.'
            : `❌ Processing failed: ${err.message || 'Unknown error'}`;

        try { await interaction.editReply(reply); } catch {}
    } finally {
        await cleanup(inputPath, outputPath);
    }
}

module.exports = { handleMediaCommand, fetchRecentMedia };
