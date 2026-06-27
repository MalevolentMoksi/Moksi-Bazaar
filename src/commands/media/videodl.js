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
function looksLikeUrl(s) {
    try {
        const u = new URL(s);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

const videodl = {
    data: new SlashCommandBuilder()
        .setName('videodl')
        .setDescription('Download a video (or its audio) from a URL — YouTube, Twitter, TikTok, etc.')
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
                try { await interaction.editReply('⏳ Your download is queued — it will start shortly…'); } catch {}
            }
            downloadedPath = await mediaSemaphore.run(() => download(url, mode, { maxBytes: MAX_FILE_SIZE }));

            sendPath = await ensureMediaSize(downloadedPath, MAX_FILE_SIZE);
            const stats = fs.statSync(sendPath);
            if (stats.size > MAX_FILE_SIZE) {
                return interaction.editReply(
                    `⚠️ The download is too large to send (${Math.round(stats.size / 1024 / 1024)} MB — Discord's limit is 25 MB). ` +
                    'Try the audio-only format, or a shorter clip.'
                );
            }
            await interaction.editReply({ files: [mediaFilePayload(sendPath, mode === 'audio' ? 'audio' : 'video')] });
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
