// src/commands/media/videodl.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const fs = require('fs');
const logger = require('../../utils/logger');
const { ytdlpAvailable, download } = require('../../utils/media/ytdlpUtils');
const { ensureMediaSize } = require('../../utils/media/ffmpegUtils');
const { mediaFilePayload } = require('../../utils/media/formatHelpers');
const { cleanup } = require('../../utils/media/tempFiles');
const { mediaSemaphore } = require('../../utils/media/concurrency');

const MAX_FILE_SIZE = 24 * 1024 * 1024;

// Basic sanity check so we only hand real http(s) URLs to yt-dlp.
/**
 * Hosts that are not on the public internet.
 *
 * yt-dlp fetches whatever it is handed, and this command is open to every
 * member, so a bare protocol check let anyone aim the container's own network
 * stack at itself: the dashboard on localhost, a Railway private service at
 * `something.railway.internal`, or a cloud metadata endpoint. None of that is
 * a video, but the failure text comes back to the caller, and the request
 * happens either way.
 */
const PRIVATE_HOST_RE = new RegExp([
    '^localhost$',
    '\\.local$', '\\.internal$', '\\.localhost$',
    '^127\\.', '^0\\.', '^10\\.',
    '^169\\.254\\.',                       // link-local, including cloud metadata
    '^192\\.168\\.',
    '^172\\.(1[6-9]|2\\d|3[01])\\.',       // 172.16.0.0/12
    '^\\[?::1\\]?$', '^\\[?f[cd]',          // IPv6 loopback and unique-local
].join('|'), 'i');

function looksLikeUrl(s) {
    try {
        const u = new URL(s);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        const host = u.hostname;
        if (!host || PRIVATE_HOST_RE.test(host)) return false;
        // A hostname with no dot is a bare service name, which only resolves
        // on a private network. Public sites always have one.
        if (!host.includes('.') && !host.includes(':')) return false;
        return true;
    } catch {
        return false;
    }
}

const videodl = {
    data: new SlashCommandBuilder()
        .setName('videodl')
        .setDescription('Download a video (or its audio) from a URL: YouTube, Twitter, TikTok, etc.')
        .addStringOption(opt =>
            opt.setName('url').setDescription('The video URL to download').setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('format')
                .setDescription('Download video or audio only (default: video)')
                .addChoices(
                    { name: 'Video', value: 'video' },
                    { name: 'Audio only', value: 'audio' }
                )
        ),
    async execute(interaction) {
        const url = interaction.options.getString('url').trim();
        const mode = interaction.options.getString('format') ?? 'video';

        if (!looksLikeUrl(url)) {
            return interaction.reply({ content: 'Please provide a valid http(s) URL.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply();

        if (!(await ytdlpAvailable())) {
            return interaction.editReply('⚠️ The `videodl` command requires yt-dlp, which is not available on this host. (It is enabled in the deployed bot.)');
        }

        let downloadedPath = null;
        let sendPath = null;
        try {
            if (mediaSemaphore.active >= mediaSemaphore.max) {
                try { await interaction.editReply('⏳ Your download is queued, it will start shortly…'); } catch {}
            }
            downloadedPath = await mediaSemaphore.run(() => download(url, mode, { maxBytes: MAX_FILE_SIZE }));

            sendPath = await ensureMediaSize(downloadedPath, MAX_FILE_SIZE);
            const stats = fs.statSync(sendPath);
            if (stats.size > MAX_FILE_SIZE) {
                return interaction.editReply(
                    `⚠️ The download is too large to send (${Math.round(stats.size / 1024 / 1024)} MB; Discord's limit is 25 MB). ` +
                    'Try the audio-only format, or a shorter clip.'
                );
            }
            // Clear content so the "queued" notice never lingers above the file.
            await interaction.editReply({ content: '', files: [mediaFilePayload(sendPath, mode === 'audio' ? 'audio' : 'video')] });
        } catch (err) {
            logger.error('videodl failed', { url, mode, error: err.message });
            const msg = String(err.message || '');
            const friendly = msg.toLowerCase().includes('too large') || msg.toLowerCase().includes('max-filesize')
                ? '⚠️ That video is larger than Discord allows (25 MB). Try the audio-only format or a shorter video.'
                : `❌ Could not download that: ${msg.slice(0, 300)}`;
            try { await interaction.editReply(friendly); } catch {}
        } finally {
            await cleanup(downloadedPath, sendPath !== downloadedPath ? sendPath : null);
        }
    },
};

module.exports = videodl;
// Exported for the tests; the command loader ignores anything but data/execute.
module.exports.looksLikeUrl = looksLikeUrl;
