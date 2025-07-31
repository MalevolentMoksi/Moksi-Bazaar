const { SlashCommandBuilder } = require('@discordjs/builders');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ytdl')
        .setDescription('Find and upload the most recent YouTube video as an MP4 (if possible).'),

    async execute(interaction) {
        await interaction.deferReply();

        // 1. Find most recent YouTube link in last 30 messages
        const messages = await interaction.channel.messages.fetch({ limit: 30 });
        let foundUrl = null;
        const ytRegex = /(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/[^\s]+/i;
        for (const msg of messages.values()) {
            const match = msg.content?.match(ytRegex);
            if (match) {
                foundUrl = match[0];
                // Strip Discord-style markdown: [text](url)
                if (foundUrl.startsWith('[') && foundUrl.includes('](') && foundUrl.endsWith(')')) {
                    foundUrl = foundUrl.replace(/^\[.*\]\((.*?)\)$/, '$1');
                }
                break;
            }
        }
        if (!foundUrl) {
            await interaction.editReply('No recent YouTube link found in this channel.');
            return;
        }

        // 2. Download with yt-dlp via shell command in /tmp
        try {
            // Limit durations for bot-compat: <3min
            const outFn = `yt-${Date.now()}.mp4`;
            const tempPath = path.join('/tmp', outFn);
            const ytArgs = [
                foundUrl,
                '-f', 'bv*[ext=mp4][height<=480]+ba[ext=m4a]/b[ext=mp4]/best[ext=mp4]/best',
                '--merge-output-format', 'mp4',
                '-o', tempPath,
                '--max-filesize', '49M',
                '--no-part',
                '--no-playlist',
                '--max-downloads', '1',
                '--retries', '10',
                '--fragment-retries', '10',
                '-4',
                '--no-cache-dir'
                // remove '--quiet' and '--no-warnings' for debugging!
            ];

            await new Promise((res, rej) =>
                execFile('yt-dlp', ytArgs, (err, stdout, stderr) => err ? rej(stderr || err) : res())
            );

            // 3. Send it back if under size limit
            const stats = fs.statSync(tempPath);
            if (stats.size / (1024 * 1024) > 8) { // Replace 8 with your true upload limit, 8MB default for non-Nitro
                fs.unlinkSync(tempPath);
                await interaction.editReply('Downloaded video is too large to upload (must be under 8MB).');
                return;
            }

            // 4. Send as file
            await interaction.editReply({ content: `Here's the video as .mp4:`, files: [tempPath] });
            fs.unlinkSync(tempPath);
        } catch (err) {
            console.error('yt-dlp failed:', err);
            await interaction.editReply('❌ Could not download/send that YouTube video (too big or download failed).');
        }
    }
};
