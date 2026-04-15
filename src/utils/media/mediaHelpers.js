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

function resolveMedia(url, contentType) {
    const ext = extFromUrl(url) || extFromContentType(contentType);
    const isImage = IMAGE_EXTS.has(ext);
    const isVideo = VIDEO_EXTS.has(ext);
    return ext ? { url, ext, isImage, isVideo } : null;
}

// ---------------------------------------------------------------------------
// Recent-message media scanner
// ---------------------------------------------------------------------------

async function fetchRecentMedia(interaction, { allowImage = true, allowVideo = true } = {}) {
    try {
        const channel = interaction.channel;
        if (!channel?.messages?.fetch) return null;

        const messages = await channel.messages.fetch({ limit: 20 });
        const recentMessages = [...messages.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);

        for (const msg of recentMessages) {
            // Attachments
            for (const att of msg.attachments.values()) {
                const info = resolveMedia(att.url, att.contentType);
                if (!info) continue;
                if ((allowImage && info.isImage) || (allowVideo && info.isVideo)) return info;
            }

            // Image embeds (e.g. image links Discord auto-previews)
            if (allowImage) {
                for (const embed of msg.embeds) {
                    for (const key of ['image', 'thumbnail']) {
                        const src = embed[key]?.url;
                        if (!src) continue;
                        const ext = extFromUrl(src);
                        if (IMAGE_EXTS.has(ext)) return { url: src, ext, isImage: true, isVideo: false };
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
async function handleMediaCommand(interaction, { allowVideo = false, allowImage = true, processFn }) {
    await interaction.deferReply();

    // 1. Explicit attachment takes priority
    let mediaInfo = null;
    const attachment = interaction.options.getAttachment('media');
    if (attachment) {
        mediaInfo = resolveMedia(attachment.url, attachment.contentType);
    }

    // 2. Fall back to recent channel messages
    if (!mediaInfo) {
        mediaInfo = await fetchRecentMedia(interaction, { allowImage, allowVideo });
        if (mediaInfo) {
            // Let the user know we're using a previous message's media
        }
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

    const inputPath = await downloadToTemp(url, ext);
    let outputPath = null;

    try {
        outputPath = await processFn(inputPath, ext, { isImage, isVideo });

        if (!outputPath) throw new Error('Processing produced no output file.');

        const stats = fs.statSync(outputPath);
        if (stats.size > MAX_FILE_SIZE) {
            return interaction.editReply(
                `⚠️ Output is too large to send (${Math.round(stats.size / 1024 / 1024)} MB — Discord's limit is 25 MB).\n` +
                'Try a smaller input, lower resolution, or shorter duration.'
            );
        }

        await interaction.editReply({ files: [outputPath] });
    } catch (err) {
        // Log full details to Railway for debugging
        logger.error('Media command failed', {
            command: interaction.commandName,
            userId: interaction.user.id,
            errorName: err.name,
            errorCode: err.code,
            error: err.message,
            stack: err.stack,
        });

        const message = [err.message, err?.response?.data?.message].filter(Boolean).join(' ').toLowerCase();

        // Discord API 40005 = "Request entity too large"
        const isDiscordSizeError = err.code === 40005 || err.status === 413
            || message.includes('entity too large')
            || message.includes('max file size')
            || message.includes('500mb');

        const reply = isDiscordSizeError
            ? '⚠️ The output file is too large for Discord (max 25 MB). Try a smaller/shorter input.'
            : `❌ Processing failed: ${err.message || 'Unknown error'}`;

        try { await interaction.editReply(reply); } catch {}
    } finally {
        await cleanup(inputPath, outputPath);
    }
}

module.exports = { handleMediaCommand, fetchRecentMedia };
