/**
 * Roulette Game Command
 */

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { adjustBalance, recordGameResult } = require('../../utils/db');
const { considerHeckle } = require('../../utils/casinoHeckle');
const { deductBet } = require('../../utils/gameHelpers');
const { ui } = require('../../utils/ui/panel');
const logger = require('../../utils/logger');

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

    // Parse number bets before any money moves so bad input costs nothing
    let uniqueNumbers = null;
    let betPerNumber = 0;
    if (sub === 'number') {
      const numberStr = interaction.options.getString('numbers');
      const guessedNumbers = numberStr.split(',')
        .map(n => parseInt(n.trim()))
        .filter(n => !isNaN(n) && n >= 0 && n <= 36);
      uniqueNumbers = [...new Set(guessedNumbers)];

      if (uniqueNumbers.length === 0) {
        return interaction.reply({
          content: '❌ Please provide at least one valid number between 0 and 36.', flags: MessageFlags.Ephemeral
        });
      }

      // Integer stake per number; the indivisible remainder is refunded below
      betPerNumber = Math.floor(betAmount / uniqueNumbers.length);
      if (betPerNumber === 0) {
        return interaction.reply({
          content: `❌ A bet of $${betAmount} cannot be split across ${uniqueNumbers.length} numbers.`, flags: MessageFlags.Ephemeral
        });
      }
    }

    // Deduct bet
    const deductResult = await deductBet(userId, betAmount);
    if (!deductResult.success) {
      return interaction.reply({
        content: `❌ ${deductResult.error}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    let finalBalance = deductResult.newBalance;

    // Refund what an even split cannot use, right away
    const remainder = sub === 'number' ? betAmount - betPerNumber * uniqueNumbers.length : 0;
    if (remainder > 0) {
      finalBalance = await adjustBalance(userId, remainder);
    }
    const staked = betAmount - remainder;

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
      if (uniqueNumbers.includes(outcome)) {
        // Straight-up number pays 35:1, so total return = bet * 36
        payout = betPerNumber * 36;
      }
      betDescription = `Numbers: ${uniqueNumbers.join(', ')} ($${betPerNumber} each)`;
      if (remainder > 0) {
        betDescription += `\nIndivisible $${remainder} returned`;
      }

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

    // Credit winnings atomically
    if (payout > 0) {
      finalBalance = await adjustBalance(userId, payout);
    }

    // The refunded remainder was never at risk, so `staked` is what was
    // actually wagered and is what the statistics should count.
    recordGameResult(userId, 'roulette', { wagered: staked, returned: payout }).catch(() => {});
    considerHeckle({
      channel: interaction.channel,
      userId,
      username: interaction.user.username,
      game: 'roulette',
      wagered: staked,
      returned: payout,
    });

    logger.info('Roulette game played', {
      userId,
      sub,
      outcome,
      betAmount,
      payout,
      win: payout > 0,
      newBalance: finalBalance,
    });

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
            ? `You won $${(payout - staked).toLocaleString()} profit!\nTotal return: $${payout.toLocaleString()}\nNew balance: $${finalBalance.toLocaleString()}`
            : `You lost $${staked.toLocaleString()}.\nNew balance: $${finalBalance.toLocaleString()}`,
          inline: false
        }
      );

    await interaction.reply(ui(embed, [], { scope: 'casino' }));
  }
};
