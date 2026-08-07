// src/commands/tools/currency.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getBalance, adjustBalance, getTopBalances } = require('../../utils/db');
const { ackPublic, replyPublic, replyPrivate } = require('../../utils/interactionAck');
const { ui } = require('../../utils/ui/panel');

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

    // Both branches below read the balance first, and a database read is
    // exactly the thing that can outlast Discord's three-second window.
    if (sub === 'beg' || sub === 'balance') await ackPublic(interaction);

    if (sub === 'beg') {
      const bal = await getBalance(userId);
      if (bal > 0) {
        return replyPrivate(interaction, `${mention}, nice try, but you still have $${bal}! You can only beg when you’re flat broke.`);
      }
      const amount = Math.floor(Math.random() * 10000) + 1;
      // Added, not assigned. Writing an absolute figure computed from a read
      // taken moments earlier discards anything that landed in between: a
      // daily claim, a payout, a gift.
      const balance = await adjustBalance(userId, amount);
      return replyPublic(interaction, `${mention}, a benevolent stranger dropped $${amount} in your lap. Your new balance is $${(balance ?? amount).toLocaleString()}.`);
    }

    if (sub === 'balance') {
      const bal = await getBalance(userId);
      return replyPublic(interaction, `${mention}, your current balance is $${bal}.`);
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
              return `${rank} <@${id}>: $${balance.toLocaleString()}`;
            })
            .join('\n')
        )
        .setColor('Gold');

      return interaction.editReply(ui(embed, [], { scope: 'casino' }));
    }
  }
};
