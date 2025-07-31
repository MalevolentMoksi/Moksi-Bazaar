const { SlashCommandBuilder } = require('@discordjs/builders');
const ytdl = require('ytdl-core');
const fs = require('fs');
const path = require('path');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ytdl')
    .setDescription('Sends the latest YouTube video as MP4 for easy download.'),

  async execute(interaction) {
    await interaction.deferReply();

    // Fetch recent messages
    const messages = await interaction.channel.messages.fetch({ limit: 25 });
    // Find YouTube URL, prefer official format
    const ytRegex = /(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/[^\s]+/i;

    let foundUrl = null;
    for (const msg of messages.values()) {
      const match = msg.content.match(ytRegex);
      if (match) {
        foundUrl = match[0];
        break;
      }
    }

    if (!foundUrl) {
      await interaction.editReply('No recent YouTube link found in this channel.');
      return;
    }

    // Download, save to temp, and upload
    try {
      const info = await ytdl.getInfo(foundUrl);
      const title = info.videoDetails.title.replace(/[^a-z0-9]/gi, '_').substring(0, 40);
      const tempPath = path.join('/tmp', `${title}.mp4`);

      // Download video at lowest quality to stay under Discord size limit
      const stream = ytdl(foundUrl, { quality: 'lowest', filter: 'audioandvideo' });
      const write = fs.createWriteStream(tempPath);
      stream.pipe(write);

      await new Promise((res, rej) => {
        write.on('finish', res);
        write.on('error', rej);
      });

      // Check file size
      const stats = fs.statSync(tempPath);
      const sizeMB = stats.size / (1024 * 1024);
      if (sizeMB > 8) { // Discord's standard limit
        fs.unlinkSync(tempPath);
        await interaction.editReply('Video too large for Discord upload (must be under 8MB).');
        return;
      }

      // Send file
      await interaction.editReply({ content: `Here's that video as .mp4:`, files: [tempPath] });
      fs.unlinkSync(tempPath);

    } catch (err) {
      console.error('YouTube download failed:', err);
      await interaction.editReply('Failed to download or send that video. (Maybe it\'s too big or not available in MP4.)');
    }
  }
};
