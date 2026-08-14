// src/utils/media/mediaHelpers.js
const fs = require('fs');
const { MessageFlags } = require('discord.js');
const logger = require('../logger');
const { downloadToTemp, cleanup, extFromUrl, IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS } = require('./tempFiles');
const { mediaFilePayload } = require('./formatHelpers');
const { ensureMediaSize } = require('./ffmpegUtils');
const { mediaSemaphore } = require('./concurrency');
const { normalizeInput } = require('./inputGuards');
const { ackPublic } = require('../interactionAck');

const MAX_FILE_SIZE = 24 * 1024 * 1024; // 24 MB. Discord bot upload limit is 25 MB

/**
 * Ceiling on what will be pulled down before processing, and how long that may
 * take. Neither existed: downloadToTemp caps nothing unless told to, and this
 * path never told it, so the caps added for video sampling protected only that
 * one caller. Input does not all come from Discord (an embed can point at any
 * host on the internet), so nothing else bounded it.
 *
 * Comfortably above any Discord attachment, including a tier-2 server's 50 MB.
 */
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 45_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extFromContentType(ct) {
    if (!ct) return '';
    const sub = ct.split('/')[1]?.split(';')[0]?.trim().toLowerCase();
    if (!sub) return '';
    const aliases = {
        jpeg: 'jpg', quicktime: 'mov', 'x-msvideo': 'avi', 'x-matroska': 'mkv',
        mpeg: 'mp3', 'x-wav': 'wav', 'x-m4a': 'm4a', 'mp4a-latm': 'm4a',
    };
    return aliases[sub] || sub;
}

function resolveMedia(url, contentType, backupUrl = null, extra = {}) {
    const urlExt = extFromUrl(url);
    const contentTypeExt = extFromContentType(contentType);
    const ext = contentTypeExt === 'gif'
        ? 'gif'
        : (urlExt && urlExt !== 'bin') ? urlExt : contentTypeExt;
    if (!ext) return null;

    const isImage = IMAGE_EXTS.has(ext);
    const isVideo = VIDEO_EXTS.has(ext);
    const isAudio = AUDIO_EXTS.has(ext);

    const isGifLike = extra.isGifLike === true || ext === 'gif' || contentTypeExt === 'gif';
    if (!isImage && !isVideo && !isAudio && !isGifLike) return null;

    return { url, backupUrl, ext, isImage, isVideo, isAudio, isGifLike };
}

function mediaAllowedByType(info, allowImage, allowVideo, allowGifLikeVideo = allowImage, allowAudio = false) {
    return (allowImage && info.isImage)
        || (allowVideo && info.isVideo)
        || (allowAudio && info.isAudio)
        || (allowGifLikeVideo && allowImage && info.isGifLike);
}

// ---------------------------------------------------------------------------
// Expired Discord CDN links
// ---------------------------------------------------------------------------

/** Discord's CDN hosts sign their URLs; every other host is left alone. */
const DISCORD_CDN_RE = /^https?:\/\/(?:cdn|media)\.discordapp\.(?:com|net)\//i;

/**
 * When a signed Discord CDN link dies, in ms since epoch (the `ex` query
 * param is hex epoch seconds). A link a user re-posts by copy-paste, or one
 * carried inside a forwarded message, keeps the ORIGINAL signature: the
 * Discord client re-signs what it renders, so the GIF looks perfectly alive
 * while the raw URL answers 404 "This content is no longer available." to
 * everyone else, this bot included.
 */
function discordUrlExpiry(url) {
    if (!DISCORD_CDN_RE.test(String(url ?? ''))) return null;
    try {
        const ex = new URL(url).searchParams.get('ex');
        if (!ex || !/^[0-9a-f]{1,12}$/i.test(ex)) return null;
        return parseInt(ex, 16) * 1000;
    } catch {
        return null;
    }
}

/**
 * Asks Discord for fresh signatures on dead CDN links. discord.js does not
 * wrap POST /attachments/refresh-urls, but the raw REST client speaks it
 * fine. Best-effort by design: a refresh that fails leaves the original
 * URLs to fail on their own and say why.
 *
 * @returns {Promise<Map<string, string>>} original -> refreshed
 */
async function refreshDiscordUrls(rest, urls) {
    const refreshed = new Map();
    const eligible = [...new Set(urls.filter(u => DISCORD_CDN_RE.test(String(u ?? ''))))];
    if (!rest?.post || eligible.length === 0) return refreshed;
    try {
        const data = await rest.post('/attachments/refresh-urls', {
            body: { attachment_urls: eligible },
        });
        for (const entry of data?.refreshed_urls ?? []) {
            if (entry?.original && entry?.refreshed) refreshed.set(entry.original, entry.refreshed);
        }
    } catch (error) {
        logger.warn('Attachment URL refresh failed', { count: eligible.length, error: error.message });
    }
    return refreshed;
}

async function downloadMediaToTemp(mediaInfo, rest = null) {
    const limits = { maxBytes: MAX_INPUT_BYTES, timeoutMs: DOWNLOAD_TIMEOUT_MS };

    // A signature that is already dead (or dies within the minute) gets its
    // refresh BEFORE the doomed request rather than after it.
    let urls = [mediaInfo.url, mediaInfo.backupUrl].filter((u, i, arr) => u && arr.indexOf(u) === i);
    const dying = urls.filter(u => {
        const at = discordUrlExpiry(u);
        return at !== null && at < Date.now() + 60_000;
    });
    if (dying.length > 0) {
        const fresh = await refreshDiscordUrls(rest, dying);
        urls = urls.map(u => fresh.get(u) ?? u);
    }

    let lastErr = null;
    for (const url of urls) {
        try {
            return await downloadToTemp(url, mediaInfo.ext, limits);
        } catch (err) {
            lastErr = err;
            // A signature can also be revoked before its ex says so, which
            // lands here as a 404/403. One refresh, one retry, then honesty.
            if (/HTTP 40[34]/.test(String(err.message)) && DISCORD_CDN_RE.test(url)) {
                const fresh = (await refreshDiscordUrls(rest, [url])).get(url);
                if (fresh) {
                    try {
                        return await downloadToTemp(fresh, mediaInfo.ext, limits);
                    } catch (retryErr) {
                        lastErr = retryErr;
                    }
                }
            }
        }
    }

    throw lastErr ?? new Error('No URL to download media from.');
}

// ---------------------------------------------------------------------------
// Recent-message media scanner
// ---------------------------------------------------------------------------

async function fetchRecentMedia(interaction, {
    allowImage = true,
    allowVideo = true,
    allowGifLikeVideo = allowImage,
    allowAudio = false,
    mediaPredicate = null,
} = {}) {
    try {
        const channel = interaction.channel;
        if (!channel?.messages?.fetch) return null;

        const messages = await channel.messages.fetch({ limit: 20 });

        for (const msg of messages.values()) {
            // A forwarded message carries its payload in messageSnapshots and
            // nothing at the top level, so forwards were simply invisible
            // here: the scanner walked past the GIF everyone was looking at.
            // Snapshot attachments keep the original message's (often long
            // expired) signatures; the download path knows how to refresh
            // those, this scanner only has to see them.
            const sources = [msg, ...(msg.messageSnapshots?.values?.() ? msg.messageSnapshots.values() : [])];

            for (const source of sources) {
                // Attachments
                for (const att of (source.attachments?.values?.() ? source.attachments.values() : [])) {
                    const info = resolveMedia(att.url, att.contentType, att.proxyURL);
                    if (!info) continue;
                    const allowedByType = mediaAllowedByType(info, allowImage, allowVideo, allowGifLikeVideo, allowAudio);
                    const allowedByPredicate = !mediaPredicate || mediaPredicate(info);
                    if (allowedByType && allowedByPredicate) return info;
                }

                // Embed media (prefer GIF images first, then video, then static images)
                for (const embed of (source.embeds ?? [])) {
                    const embedType = String(embed.type || '').toLowerCase();
                    const embedUrl = String(embed.url || '');
                    // "GIF-like" means the embed represents an animated GIF even though
                    // Discord often serves it as a silent MP4 proxy. Detect it broadly:
                    //   - a "gifv" embed type,
                    //   - the embed's own URL is a .gif (klipy, imgur, most GIF hosts), or
                    //   - a known GIF host. This drives whether the video proxy is tagged
                    //     isGifLike so downstream commands output a GIF, not an MP4.
                    const gifHostRe = /tenor\.com|giphy\.com|klipy\.com|gfycat\.com|redgifs\.com/i;
                    const urlIsGif = /\.gif(\?|$)/i.test(embedUrl);
                    const isGifLikeEmbed = embedType === 'gifv' || urlIsGif || gifHostRe.test(embedUrl);

                    let staticImageCandidate = null;
                    if (allowImage) {
                        // Prefer a real .gif URL from the embed's own url/image/thumbnail
                        // over Discord's MP4 video proxy, so GIFs stay GIFs.
                        const gifCandidates = [
                            urlIsGif ? embedUrl : null,
                            embed.image?.url, embed.image?.proxyURL,
                            embed.thumbnail?.url, embed.thumbnail?.proxyURL,
                        ].filter(Boolean);
                        for (const src of gifCandidates) {
                            const info = resolveMedia(src, null, src);
                            if (info?.ext === 'gif' && (!mediaPredicate || mediaPredicate(info))) return info;
                        }
                        for (const key of ['image', 'thumbnail']) {
                            const src = embed[key]?.url || embed[key]?.proxyURL;
                            if (!src) continue;
                            const info = resolveMedia(src, null, embed[key]?.proxyURL);
                            if (!info?.isImage) continue;
                            if (mediaPredicate && !mediaPredicate(info)) continue;
                            if (!staticImageCandidate) staticImageCandidate = info;
                        }
                    }

                    if (allowVideo || (allowGifLikeVideo && allowImage && isGifLikeEmbed)) {
                        const videoSrc = embed.video?.url || embed.video?.proxyURL;
                        if (videoSrc) {
                            // Tag the proxy as GIF-like when the embed is a GIF, so commands
                            // (reverse, speed, …) emit a GIF instead of an MP4.
                            const info = resolveMedia(videoSrc, null, embed.video?.proxyURL, { isGifLike: isGifLikeEmbed });
                            const allowedByType = info && mediaAllowedByType(info, allowImage, allowVideo, allowGifLikeVideo);
                            if (allowedByType && (!mediaPredicate || mediaPredicate(info))) return info;
                        }
                    }

                    if (staticImageCandidate) return staticImageCandidate;
                }
            }
        }
    } catch {
        // Channel not accessible or rate-limited, silent fallthrough
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
 * processFn(inputPath, ext, { isImage, isVideo, isGifLike }) → Promise<string outputPath>
 *
 * Options:
 *   normalizeInput: cap input resolution/FPS/frame-count before processing (default true).
 *                     Set false for commands whose own logic must see the raw input
 *                     (e.g. format converters, info/probe).
 *   useQueue:       run processFn behind the shared concurrency semaphore (default true).
 */
async function handleMediaCommand(interaction, {
    allowVideo = false,
    allowImage = true,
    allowGifLikeVideo = allowImage,
    allowAudio = false,
    processFn,
    mediaPredicate = null,
    invalidMediaMessage = null,
    normalizeInput: doNormalizeInput = true,
    useQueue = true,
}) {
    // ackPublic rather than deferReply: a command that had to check something
    // before delegating here (whether ImageMagick exists, say) has already
    // claimed the interaction, and a second deferReply would throw.
    await ackPublic(interaction);

    // 1. Explicit attachment takes priority
    let mediaInfo = null;
    const attachment = interaction.options.getAttachment('media');
    if (attachment) {
        mediaInfo = resolveMedia(attachment.url, attachment.contentType, attachment.proxyURL);
        if (!mediaInfo) {
            return interaction.editReply(
                'The provided attachment is not a supported media format for this command.'
            );
        }
        if (mediaPredicate && !mediaPredicate(mediaInfo)) {
            return interaction.editReply(invalidMediaMessage || 'That media type is not supported for this command.');
        }
    }

    // 2. Fall back to recent channel messages
    if (!mediaInfo) {
        mediaInfo = await fetchRecentMedia(interaction, {
            allowImage,
            allowVideo,
            allowGifLikeVideo,
            allowAudio,
            mediaPredicate,
        });
    }

    // 3. Nothing found anywhere
    if (!mediaInfo) {
        return interaction.editReply(
            'No media found. Attach a file to the command, or use it in a channel where media was recently posted.'
        );
    }

    const { ext, isImage, isVideo, isAudio, isGifLike } = mediaInfo;

    // 4. Type guard
    const actsAsImage = isImage || (allowGifLikeVideo && isGifLike);
    const onlyAudioAllowed = allowAudio && !allowImage && !allowVideo;
    if (onlyAudioAllowed && !isAudio) {
        return interaction.editReply('That file doesn\'t look like audio. Please provide an MP3, WAV, OGG, or similar.');
    }
    if (!allowAudio && allowImage && allowVideo && isAudio) {
        return interaction.editReply('That file doesn\'t look like an image or video. Please provide a PNG, GIF, MP4, or similar.');
    }
    if (!allowAudio && allowImage && !allowVideo && !actsAsImage) {
        return interaction.editReply('That file doesn\'t look like an image. Please provide a PNG, JPG, WEBP, or similar.');
    }
    if (!allowAudio && !allowImage && allowVideo && !isVideo) {
        return interaction.editReply('That file doesn\'t look like a video. Please provide an MP4, MOV, WebM, or similar.');
    }
    if (mediaPredicate && !mediaPredicate(mediaInfo)) {
        return interaction.editReply(invalidMediaMessage || 'That media type is not supported for this command.');
    }

    let inputPath = null;
    let normalizedPath = null;
    let outputPath = null;

    try {
        inputPath = await downloadMediaToTemp(mediaInfo, interaction.client?.rest ?? null);

        // Normalize oversized/overlong input before processing (resolution/FPS/frames).
        // Audio has no resolution/FPS to cap, so it's never normalized.
        let processInput = inputPath;
        if (doNormalizeInput && !isAudio) {
            const norm = await normalizeInput(inputPath, ext, { isVideo, isGifLike });
            if (norm.replaced && norm.path !== inputPath) {
                normalizedPath = norm.path;
                processInput = norm.path;
            }
            if (norm.notes?.length) {
                try {
                    await interaction.followUp({
                        content: `ℹ️ Input ${norm.notes.join(', ')} before processing.`,
                        flags: MessageFlags.Ephemeral,
                    });
                } catch {}
            }
        }

        // Run the actual work behind the concurrency semaphore. Show a "queued"
        // hint only if we actually have to wait for a slot.
        const runWork = () => processFn(processInput, ext, { isImage, isVideo, isAudio, isGifLike, mediaInfo });
        if (useQueue) {
            if (mediaSemaphore.active >= mediaSemaphore.max) {
                try { await interaction.editReply('⏳ Your command is queued, processing will start shortly…'); } catch {}
            }
            outputPath = await mediaSemaphore.run(runWork);
        } else {
            outputPath = await runWork();
        }

        if (!outputPath) throw new Error('Processing produced no output file.');

        const ensuredOutputPath = await ensureMediaSize(outputPath, MAX_FILE_SIZE);
        if (ensuredOutputPath !== outputPath) {
            await cleanup(outputPath);
            outputPath = ensuredOutputPath;
        }

        const stats = fs.statSync(outputPath);
        if (stats.size > MAX_FILE_SIZE) {
            return interaction.editReply(
                `⚠️ Output is too large to send (${Math.round(stats.size / 1024 / 1024)} MB; Discord's limit is 25 MB).\n` +
                'Try a smaller input, lower resolution, or shorter duration.'
            );
        }

        // Always clear content so a "queued" notice never lingers above the file.
        await interaction.editReply({ content: '', files: [mediaFilePayload(outputPath, interaction.commandName)] });
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
        await cleanup(inputPath, normalizedPath, outputPath);
    }
}

module.exports = {
    handleMediaCommand, fetchRecentMedia, resolveMedia, downloadMediaToTemp,
    // Exported so the expiry parser and refresh flow can be pinned in tests.
    discordUrlExpiry, refreshDiscordUrls,
};
