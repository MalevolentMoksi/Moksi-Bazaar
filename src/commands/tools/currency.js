// src/commands/tools/currency.js
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getBalance, updateBalance, getTopBalances } = require('../../utils/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('currency')
    .setDescription('Beg for cash or check your balance')
    .addSubcommand(sub =>
      sub.setName('beg').setDescription('Get down on your knees and beg for cash')
    )
    .addSubcommand(sub =>
      sub.setName('balance').setDescription('Check your current balance')
    )
    .addSubcommand(sub =>
      sub.setName('leaderboard')
         .setDescription('Show the top balances in this server')
    ),

  async execute(interaction) {
    const userId = interaction.user.id;
    const mention = interaction.user.toString();
    const sub = interaction.options.getSubcommand();

    if (sub === 'beg') {
      const bal = await getBalance(userId);
      if (bal > 0) {
        return interaction.reply({ content: `${mention}, nice try—but you still have $${bal}! You can only beg when you’re flat broke.`, flags: MessageFlags.Ephemeral});
      }
      const amount = Math.floor(Math.random() * 10000) + 1;
      await updateBalance(userId, amount);
      return interaction.reply(`${mention}, a benevolent stranger dropped $${amount} in your lap. Your new balance is $${amount}.`);
    }

    if (sub === 'balance') {
      const bal = await getBalance(userId);
      return interaction.reply(`${mention}, your current balance is $${bal}.`);
    }

    if (sub === 'leaderboard') {
      await interaction.deferReply();

      const DISPLAY_LIMIT = 10;
      const rankEmojis = ['👑', '🥈', '🥉'];
      const rows = await getTopBalances(DISPLAY_LIMIT * 2);

      // Bulk-fetch guild members instead of individual fetches
      const userIds = rows.map(r => r.user_id);
      let guildMembers;
      try {
        guildMembers = await interaction.guild.members.fetch({ user: userIds });
      } catch {
        guildMembers = interaction.guild.members.cache;
      }

      const board = [];
      for (const { user_id, balance } of rows) {
        const member = guildMembers.get(user_id);
        if (member) {
          board.push({ id: user_id, balance });
        }
        if (board.length >= DISPLAY_LIMIT) break;
      }

      if (!board.length) {
        return interaction.editReply({
          content: 'No balances found for members of this server yet.'
        });
      }

      const embed = new EmbedBuilder()
        .setTitle('💰 Server Currency Leaderboard')
        .setDescription(
          board
            .map(({ id, balance }, i) => {
              const rank = rankEmojis[i] || `**${i + 1}.**`;
              return `${rank} <@${id}> — $${balance.toLocaleString()}`;
            })
            .join('\n')
        )
        .setColor('Gold');

      return interaction.editReply({ embeds: [embed] });
    }
  }
};
