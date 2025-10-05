// src/commands/tools/testmedia.js  (fixed)
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { processMediaInMessage, getMediaAnalysisProvider } = require('../../utils/db.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('testmedia')
    .setDescription('Test media analysis on recent messages (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  async execute(interaction) {
    await interaction.deferReply();
    try {
      const provider = await getMediaAnalysisProvider();
      const messages = await interaction.channel.messages.fetch({ limit: 10 });

      let out = [
        '**Media Analysis Test**',
        `Provider: ${provider}`,
        `Messages checked: ${messages.size}`,
        ''
      ];

      let mediaCount = 0;
      for (const [, msg] of messages) {
        if (msg.author.bot) continue;
        const author = msg.member?.displayName || msg.author.username;

        // attachments
        if (msg.attachments.size) {
          mediaCount++;
          out.push(`📎 **${author}** attachments (${msg.attachments.size}):`);
          for (const [, att] of msg.attachments) {
            out.push(`  • ${att.name} – ${(att.size / 1024).toFixed(1)} KB`);
          }
        }

        // embeds
        if (msg.embeds.length) {
          msg.embeds.forEach((e, i) => {
            if (e.image?.url || e.thumbnail?.url) {
              mediaCount++;
              out.push(`🖼️ **${author}** embed ${i + 1}:`);
              if (e.image?.url) out.push(`  • image: ${e.image.url}`);
              if (e.thumbnail?.url) out.push(`  • thumb: ${e.thumbnail.url}`);
            }
          });
        }

        // stickers
        if (msg.stickers.size) {
          mediaCount++;
          out.push(`🎨 **${author}** sticker(s): ${[...msg.stickers.values()].map(s => s.name).join(', ')}`);
        }

        // custom emojis
        const emojiRe = /<a?:(\\w+):(\\d+)>/g;
        const found = [...msg.content.matchAll(emojiRe)];
        if (found.length) {
          mediaCount++;
          out.push(`😀 **${author}** emojis: ${found.map(m => m[1]).join(', ')}`);
        }

        // run analysis when any media found
        if (mediaCount) {
          const desc = await processMediaInMessage(msg);
          if (desc.length) {
            out.push('✅ **AI descriptions:**');
            desc.forEach(d => out.push(`  ${d}`));
          } else {
            out.push('❌ **No analyzable media**');
          }
          out.push('');
        }
      }

      if (!mediaCount) out.push('No recent messages with media found.');

      const txt = out.join('\\n');
      if (txt.length > 2000) {
        const chunks = txt.match(/([\\s\\S]{1,1900})/g);
        await interaction.editReply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp({ content: chunks[i], ephemeral: true });
        }
      } else {
        await interaction.editReply(txt);
      }
    } catch (err) {
      console.error('[TESTMEDIA]', err);
      await interaction.editReply(`Error: ${err.message}`);
    }
  }
};
