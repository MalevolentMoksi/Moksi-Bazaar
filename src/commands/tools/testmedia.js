const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { processMediaInMessage, getMediaAnalysisProvider } = require('../../utils/db.js');

const TRUNC = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('testmedia')
    .setDescription('Test media analysis on recent messages (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption(o =>
      o.setName('limit')
       .setDescription('Messages to scan (1–25, default 10)')
       .setMinValue(1)
       .setMaxValue(25)
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const limit = interaction.options.getInteger('limit') || 10;
    const provider = await getMediaAnalysisProvider();
    const color = provider === 'gemini' ? 0x4285F4 : provider === 'groq' ? 0xF55036 : 0x99AAB5;

    const messages = await interaction.channel.messages.fetch({ limit });
    let total = 0, withMedia = 0, items = 0, ok = 0, fail = 0;

    const results = [];
    for (const [, msg] of messages) {
      if (msg.author.bot) continue;
      total++;

      const mediaList = [];
      // attachments
      if (msg.attachments.size) {
        msg.attachments.forEach(a => mediaList.push({ icon: '📎', name: a.name }));
      }
      // embeds
      msg.embeds.forEach(e => {
        if (e.image?.url)     mediaList.push({ icon: '🖼️', name: 'image' });
        if (e.thumbnail?.url) mediaList.push({ icon: '🖼️', name: 'thumbnail' });
      });
      // stickers
      msg.stickers.forEach(s => mediaList.push({ icon: '🎨', name: s.name }));
      // custom emojis
      const emojiRe = /<a?:(\w+):(\d+)>/g;
      [...(msg.content?.matchAll(emojiRe) || [])].forEach(m => mediaList.push({ icon: '😀', name: m[1] }));

      if (!mediaList.length) continue;

      withMedia++;
      items += mediaList.length;

      let descriptions = [];
      try {
        descriptions = await processMediaInMessage(msg);
        ok += descriptions.length;
        fail += mediaList.length - descriptions.length;
      } catch (e) {
        fail += mediaList.length;
      }

      const typeSummary = mediaList.map(m => `${m.icon} ${m.name}`).join(', ');
      const lines = [
        `Media: ${typeSummary}`,
        `Time: <t:${Math.floor(msg.createdTimestamp / 1000)}:R>`
      ];
      if (descriptions.length) {
        lines.push('AI:');
        lines.push(...descriptions.map(d => `> ${TRUNC(d, 300)}`));
      } else {
        lines.push('AI: none');
      }

      results.push({
        name: `${descriptions.length ? '✅' : '❌'} ${msg.member?.displayName || msg.author.username}`,
        value: TRUNC(lines.join('\n'), 1000) // keep under Discord field limit
      });
    }

    // Summary embed
    const summary = new EmbedBuilder()
      .setTitle('📊 Media Analysis Test')
      .setColor(color)
      .addFields(
        {
          name: 'Config',
          value: [
            `Provider: ${provider}`,
            `Messages scanned: ${total}`,
            `Limit: ${limit}`,
            `Channel: #${interaction.channel.name}`
          ].join('\n'),
          inline: true
        },
        {
          name: 'Stats',
          value: [
            `Media messages: ${withMedia}`,
            `Items: ${items}`,
            `Success rate: ${items ? Math.round((ok / items) * 100) : 0}%`
          ].join('\n'),
          inline: true
        },
        {
          name: 'Results',
          value: [
            `Successful: ${ok}`,
            `Failed: ${fail}`,
            `Provider status: ${provider === 'disabled' ? 'disabled' : 'active'}`
          ].join('\n'),
          inline: true
        }
      )
      .setTimestamp();

    const embeds = [summary];

    if (!results.length) {
      embeds.push(
        new EmbedBuilder()
          .setTitle('ℹ️ No Media Found')
          .setDescription(
            [
              `No media detected in the last ${limit} messages.`,
              '',
              'Tips:',
              '• Upload an image, GIF, or video',
              '• Use custom emojis or stickers',
              '• Share a link that generates an image embed'
            ].join('\n')
          )
          .setColor(0xFEE75C)
      );
    } else {
      // chunk into groups of 5 fields to stay safe on limits
      for (let i = 0; i < results.length; i += 5) {
        embeds.push(
          new EmbedBuilder()
            .setTitle(i ? '🔍 Details (cont.)' : '🔍 Detailed Media Analysis')
            .setColor(0x5865F2)
            .addFields(results.slice(i, i + 5))
        );
      }
    }

    await interaction.editReply({ embeds });
  }
};
