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
         .setDescription('Bet on one or more specific numbers (0–36)')
         .addStringOption(opt =>
           opt.setName('numbers')
              .setDescription('Comma-separated numbers to bet on (e.g., 3,7,25)')
              .setRequired(true))
         .addIntegerOption(opt =>
           opt.setName('amount')
              .setDescription('Total amount of currency to bet')
              .setRequired(true)
              .setMinValue(1)))
    .addSubcommand(sub =>
      sub.setName('color')
         .setDescription('Bet on a color (red, black, or green)')
         .addStringOption(opt =>
           opt.setName('color')
              .setDescription('Color to bet on')
              .setRequired(true)
              .addChoices(
                { name: 'Red', value: 'red' },
                { name: 'Black', value: 'black' },
                { name: 'Green (0)', value: 'green' }
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

    // Simulate spin (0 to 36)
    const outcome = Math.floor(Math.random() * 37);
    const outcomeColor = outcome === 0
      ? 'green'
      : redNumbers.has(outcome)
        ? 'red'
        : 'black';

    // Determine payout (total return, including original stake)
    let payout = 0;
    let betDescription = '';

    if (sub === 'number') {
      const numberStr = interaction.options.getString('numbers');
      const guessedNumbers = numberStr.split(',')
        .map(n => parseInt(n.trim()))
        .filter(n => !isNaN(n) && n >= 0 && n <= 36);
      const uniqueNumbers = [...new Set(guessedNumbers)];

      if (uniqueNumbers.length === 0) {
        return interaction.reply({
          content: '❌ Please provide at least one valid number between 0 and 36.',
          ephemeral: true
        });
      }

      const betPerNumber = betAmount / uniqueNumbers.length;
      if (uniqueNumbers.includes(outcome)) {
        // Straight-up number pays 35:1, so total return = bet * 36
        payout = betPerNumber * 36;
      }
      betDescription = `Numbers: ${uniqueNumbers.join(', ')}`;

    } else {
      const guessColor = interaction.options.getString('color');
      if (guessColor === 'green') {
        // Green (0) pays 35:1 -> total return = bet * 36
        if (outcome === 0) payout = betAmount * 36;
      } else if (guessColor === outcomeColor) {
        // Red/Black pays 1:1 -> total return = bet * 2
        payout = betAmount * 2;
      }
      betDescription = `Color: ${guessColor}`;
    }

    // Update balance
    finalBalance += payout;
    await updateBalance(userId, finalBalance);

    // Emoji for outcome
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
        { name: 'Your Bet', value: `You wagered $${betAmount} on ${sub}\n${betDescription}`, inline: true },
        {
          name: payout > 0 ? '🏆 You Won!' : '💸 You Lost',
          value: payout > 0
            ? `You won $${(payout - betAmount).toFixed(2)} profit!\nTotal return: $${payout.toFixed(2)}\nNew balance: $${finalBalance.toFixed(2)}`
            : `You lost $${betAmount}.\nNew balance: $${finalBalance.toFixed(2)}`,
          inline: false
        }
      );

    await interaction.reply({ embeds: [embed] });
  }
};
