const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { processMediaInMessage, getMediaAnalysisProvider } = require('../../utils/db.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('testmedia')
    .setDescription('Test media analysis on recent messages (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption(o =>
      o.setName('limit')
       .setDescription('Messages to scan (1-25, default 10)')
       .setMinValue(1)
       .setMaxValue(25)
    ),

  async execute(interaction) {
    await interaction.deferReply();
    const limit      = interaction.options.getInteger('limit') || 10;
    const provider   = await getMediaAnalysisProvider();
    const colourMap  = { gemini: 0x4285F4, groq: 0xF55036, disabled: 0x99AAB5 };
    const scan       = await interaction.channel.messages.fetch({ limit });

    let total = 0, withMedia = 0, items = 0, ok = 0, fail = 0, details = [];

    for (const [, msg] of scan) {
      if (msg.author.bot) continue;
      total++;
      const media = [];

      if (msg.attachments.size) {
        msg.attachments.forEach(a => media.push({ icon: '📎', name: a.name }));
      }
      msg.embeds.forEach(e => {
        if (e.image?.url)      media.push({ icon: '🖼️', name: 'image' });
        if (e.thumbnail?.url)  media.push({ icon: '🖼️', name: 'thumbnail' });
      });
      msg.stickers.forEach(s => media.push({ icon: '🎨', name: s.name }));
      [...msg.content.matchAll(/<a?:(\\w+):(\\d+)>/g)]
        .forEach(m => media.push({ icon: '😀', name: m[1] }));

      if (!media.length) continue;

      withMedia++; items += media.length;
      let desc   = [];
      try {
        desc = await processMediaInMessage(msg);
        ok  += desc.length;
        fail += media.length - desc.length;
      } catch (e) {
        fail += media.length;
      }

      details.push({
        name: `${desc.length ? '✅' : '❌'} ${msg.member?.displayName || msg.author.username}`,
        value:
          `**Media:** ${media.map(m => m.icon + ' ' + m.name).join(', ')}\\n` +
          `**Time:** <t:${Math.floor(msg.createdTimestamp/1000)}:R>\\n` +
          (desc.length ? `**AI:**\\n${desc.map(d => '> ' + (d.length > 150 ? d.slice(0,147)+'…' : d)).join('\\n')}`
                        : 'No analysis')
      });
    }

    /* ---------- embeds ---------- */
    const embeds = [
      new EmbedBuilder()
        .setTitle('📊 Media Analysis Test')
        .setColor(colourMap[provider] ?? 0x5865F2)
        .addFields(
          { name: 'Config',
            value: `Provider: **${provider}**\\nMessages scanned: **${total}**\\nLimit: **${limit}**`,
            inline: true },
          { name: 'Stats',
            value: `Media messages: **${withMedia}**\\nItems: **${items}**\\nSuccess rate: **${items ? Math.round(ok/items*100) : 0}%**`,
            inline: true },
          { name: 'Results',
            value: `Successful: **${ok}**\\nFailed: **${fail}**`,
            inline: true }
        )
        .setTimestamp()
        .setFooter({ text: `Channel: #${interaction.channel.name}` })
    ];

    if (!details.length) {
      embeds.push(
        new EmbedBuilder()
          .setTitle('ℹ️ No Media Found')
          .setDescription(
            `No media detected in the last **${limit}** messages.\\n\\n` +
            '💡 Try uploading an image, GIF, video, sticker, or custom emoji then run the command again.')
          .setColor(0xFEE75C)
      );
    } else {
      const chunk = (arr, n) => arr.reduce((a,_,i) => (i%n ? a[a.length-1].push(arr[i])
                                                         : a.push([arr[i]]), a), []);
      chunk(details, 5).forEach((group,i) => {
        const emb = new EmbedBuilder()
          .setTitle(i ? '🔍 Details (cont.)' : '🔍 Detailed Media Analysis')
          .setColor(0x5865F2)
          .addFields(group);
        embeds.push(emb);
      });
    }

    await interaction.editReply({ embeds });
  }
};
