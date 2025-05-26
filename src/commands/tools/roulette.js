// src/commands/tools/roulette.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getBalance, updateBalance } = require('../../utils/db');

// Numbers colored red in European roulette
const redNumbers = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('roulette')
    .setDescription('Spin the roulette wheel and bet currency')
    .addSubcommand(sub =>
      sub.setName('number')
         .setDescription('Bet on a specific number (0–36)')
         .addIntegerOption(opt =>
           opt.setName('number')
              .setDescription('Number to bet on')
              .setRequired(true)
              .setMinValue(0)
              .setMaxValue(36))
         .addIntegerOption(opt =>
           opt.setName('amount')
              .setDescription('Amount of currency to bet')
              .setRequired(true)
              .setMinValue(1)))
    .addSubcommand(sub =>
      sub.setName('color')
         .setDescription('Bet on a color (red or black)')
         .addStringOption(opt =>
           opt.setName('color')
              .setDescription('Color to bet on')
              .setRequired(true)
              .addChoices(
                { name: 'Red', value: 'red' },
                { name: 'Black', value: 'black' }
              ))
         .addIntegerOption(opt =>
           opt.setName('amount')
              .setDescription('Amount of currency to bet')
              .setRequired(true)
              .setMinValue(1))),

  async execute(interaction) {
    const userId = interaction.user.id;
    const sub = interaction.options.getSubcommand();
    const betAmount = interaction.options.getInteger('amount');

    // Fetch and verify balance
    const balance = await getBalance(userId);
    if (betAmount > balance) {
      return interaction.reply({
        content: `❌ You only have $${balance} available to bet.`,
        ephemeral: true
      });
    }

    // Deduct initial bet
    let finalBalance = balance - betAmount;
    // Simulate spin
    const outcome = Math.floor(Math.random() * 37);
    const outcomeColor = outcome === 0
      ? 'green'
      : redNumbers.has(outcome)
        ? 'red'
        : 'black';

    // Determine payout
    let payout = 0;
    if (sub === 'number') {
      const guess = interaction.options.getInteger('number');
      if (guess === outcome) {
        // 35:1 payout for exact number
        payout = betAmount * 35;
      }
    } else {
      const guessColor = interaction.options.getString('color');
      if (guessColor === outcomeColor) {
        // 1:1 payout for color
        payout = betAmount;
      }
    }

    // Compute new balance and update DB
    finalBalance += payout;
    await updateBalance(userId, finalBalance);

    // Emoji for roulette outcome
    const colorEmoji = outcomeColor === 'red'
      ? '🔴'
      : outcomeColor === 'black'
        ? '⚫'
        : '🟢';

    // Build embed
    const embed = new EmbedBuilder()
      .setTitle('🎡 Roulette Spin')
      .setColor(
        outcomeColor === 'red'   ? 0xe74c3c :
        outcomeColor === 'black' ? 0x2c3e50 :
                                   0x27ae60
      )
      .addFields(
        { name: 'Result', value: `${colorEmoji} **${outcome}** (${outcomeColor})`, inline: true },
        { name: 'Bet',    value: `You bet $${betAmount} on ${sub}`, inline: true },
        { name: payout > 0 ? '🏆 You Won!' : '💸 You Lost', value:
            payout > 0
              ? `You won $${payout}!
Your new balance is $${finalBalance}.`
              : `You lost $${betAmount}.
Your new balance is $${finalBalance}.`,
          inline: false
        }
      );

    await interaction.reply({ embeds: [embed] });
  }
};
