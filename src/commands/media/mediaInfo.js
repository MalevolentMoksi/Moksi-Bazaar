// src/commands/media/mediaInfo.js
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const fs = require('fs');
const { handleMediaCommand, fetchRecentMedia, resolveMedia, downloadMediaToTemp } = require('../../utils/media/mediaHelpers');
const { isGifInput } = require('../../utils/media/formatHelpers');
const { probeFile } = require('../../utils/media/ffmpegUtils');
const { cleanup } = require('../../utils/media/tempFiles');
const { uncaption } = require('../../utils/media/uncaptionUtils');

const uncaptionCmd = {
    data: new SlashCommandBuilder()
        .setName('uncaption')
        .setDescription('Remove a caption bar from the top of an image, GIF, or video')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Captioned image, GIF, or video (optional: uses recent media if omitted)').setRequired(false)
        )
        .addIntegerOption(opt =>
            opt.setName('threshold').setDescription('Color tolerance for detecting the caption (0–255, default 10)').setMinValue(0).setMaxValue(255)
        ),
    async execute(interaction) {
        const threshold = interaction.options.getInteger('threshold') ?? 10;
        await handleMediaCommand(interaction, {
            allowImage: true, allowVideo: true,
            // The whole point is to read the original pixels — don't normalize first.
            normalizeInput: false,
            processFn: async (inputPath, ext, context) => {
                const isGif = await isGifInput(inputPath, ext, context);
                return uncaption(inputPath, threshold, { isGif, isVideo: context.isVideo && !isGif, ext });
            },
        });
    },
};

function formatBytes(n) {
    if (!n) return 'unknown';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatDuration(sec) {
    if (!sec || !Number.isFinite(sec)) return null;
    const s = Math.floor(sec % 60);
    const m = Math.floor((sec / 60) % 60);
    const h = Math.floor(sec / 3600);
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// /info — probe a media file and report its properties as an embed. No file output.
const info = {
    data: new SlashCommandBuilder()
        .setName('info')
        .setDescription('Show technical info (codec, resolution, duration…) about a media file')
        .addAttachmentOption(opt =>
            opt.setName('media').setDescription('Media to inspect (optional: uses recent media if omitted)').setRequired(false)
        ),
    async execute(interaction) {
        await interaction.deferReply();

        // Resolve media: explicit attachment first, then recent channel scan.
        let mediaInfo = null;
        const attachment = interaction.options.getAttachment('media');
        if (attachment) {
            mediaInfo = resolveMedia(attachment.url, attachment.contentType, attachment.proxyURL);
            if (!mediaInfo) return interaction.editReply('That attachment is not a supported media format.');
        } else {
            mediaInfo = await fetchRecentMedia(interaction, {
                allowImage: true, allowVideo: true, allowAudio: true,
            });
            if (!mediaInfo) return interaction.editReply('No media found. Attach a file or post one in the channel first.');
        }

        let inputPath = null;
        try {
            inputPath = await downloadMediaToTemp(mediaInfo);
            const probeData = await probeFile(inputPath);
            const fileSize = fs.statSync(inputPath).size;
            const v = probeData.streams?.find(s => s.codec_type === 'video');
            const a = probeData.streams?.find(s => s.codec_type === 'audio');
            const duration = Number.parseFloat(probeData.format?.duration || 0) || 0;

            const lines = [];
            lines.push(`**Type:** ${mediaInfo.isAudio ? 'Audio' : mediaInfo.isVideo ? 'Video' : mediaInfo.ext === 'gif' || mediaInfo.isGifLike ? 'GIF' : 'Image'}`);
            lines.push(`**Format:** ${probeData.format?.format_long_name || mediaInfo.ext.toUpperCase()}`);
            lines.push(`**Size:** ${formatBytes(fileSize)}`);
            if (v) {
                lines.push(`**Resolution:** ${v.width}×${v.height}`);
                lines.push(`**Video codec:** ${v.codec_name || 'unknown'}`);
                const fr = v.avg_frame_rate && v.avg_frame_rate.includes('/')
                    ? (() => { const [n, d] = v.avg_frame_rate.split('/').map(Number); return d ? (n / d).toFixed(2) : null; })()
                    : null;
                if (fr) lines.push(`**Frame rate:** ${fr} fps`);
            }
            if (a) {
                lines.push(`**Audio codec:** ${a.codec_name || 'unknown'}`);
                if (a.sample_rate) lines.push(`**Sample rate:** ${a.sample_rate} Hz`);
                if (a.channels) lines.push(`**Channels:** ${a.channels}`);
            }
            const dur = formatDuration(duration);
            if (dur) lines.push(`**Duration:** ${dur}`);
            if (probeData.format?.bit_rate) lines.push(`**Bitrate:** ${Math.round(probeData.format.bit_rate / 1000)} kbps`);

            const embed = new EmbedBuilder()
                .setTitle('📊 Media Info')
                .setDescription(lines.join('\n'))
                .setColor(0x5865F2);
            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            try { await interaction.editReply(`❌ Could not read that media: ${err.message}`); } catch {}
        } finally {
            await cleanup(inputPath);
        }
    },
};

module.exports = [uncaptionCmd, info];
