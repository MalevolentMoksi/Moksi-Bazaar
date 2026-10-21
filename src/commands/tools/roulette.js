/**
 * Roulette Game Command
 */

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { adjustBalance, recordGameResult } = require('../../utils/db');
const { considerHeckle } = require('../../utils/casinoHeckle');
const { deductBet, resolveBet } = require('../../utils/gameHelpers');
const { ackPublic, replyPublic, replyPrivate } = require('../../utils/interactionAck');
const { ui } = require('../../utils/ui/panel');
const { money, signedMoney, parseAmount, AMOUNT_HINT } = require('../../utils/money');
const logger = require('../../utils/logger');

// Numbers colored red in European roulette
const redNumbers = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('roulette')
    .setDescription('Spin the roulette wheel and bet currency')
    .addSubcommand(sub =>
      sub.setName('number')
         .setDescription('Bet on one or more specific numbers (0-36)')
         .addStringOption(opt =>
           opt.setName('numbers')
              .setDescription('Comma-separated numbers to bet on (e.g., 3,7,25)')
              .setRequired(true))
         .addStringOption(opt =>
           opt.setName('bet')
              .setDescription('Total, split evenly across the numbers: 500, 10k, half or all')
              .setRequired(true)))
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
         .addStringOption(opt =>
           opt.setName('bet')
              .setDescription('How much: 500, 10k, half or all')
              .setRequired(true))),

  async execute(interaction) {
    const userId = interaction.user.id;
    const sub = interaction.options.getSubcommand();

    // Shapes first, while a private rejection costs nothing.
    const spec = parseAmount(interaction.options.getString('bet'));
    if (!spec) {
      return interaction.reply({ content: AMOUNT_HINT, flags: MessageFlags.Ephemeral });
    }

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
          content: 'Name at least one number from 0 to 36, separated by commas: `7` or `3, 17, 25`.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    // Everything above is argument parsing, which cannot outrun Discord's
    // three-second window. The money below can, so claim the interaction here.
    await ackPublic(interaction);

    // "all" and "half" need the balance, so the split is checked only now.
    const betAmount = await resolveBet(userId, spec);
    if (sub === 'number') {
      // Integer stake per number; the indivisible remainder is refunded below
      betPerNumber = Math.floor(betAmount / uniqueNumbers.length);
      if (betPerNumber === 0) {
        return replyPrivate(interaction,
          `${money(betAmount)} cannot be split across ${uniqueNumbers.length} numbers.`);
      }
    }

    const deductResult = await deductBet(userId, betAmount, { game: 'roulette' });
    if (!deductResult.success) {
      return replyPrivate(interaction, deductResult.error);
    }

    let finalBalance = deductResult.newBalance;
    const stake = deductResult.stake;

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
      betDescription = `${uniqueNumbers.join(', ')} at ${money(betPerNumber)} each`;
      if (remainder > 0) {
        betDescription += `\n-# ${money(remainder)} did not divide evenly and went back to you`;
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
      betDescription = `${guessColor[0].toUpperCase()}${guessColor.slice(1)}`;
    }

    // Credit winnings atomically
    if (payout > 0) {
      finalBalance = await adjustBalance(userId, payout);
    }
    // The wheel has stopped and the money has moved; nothing is owed back.
    await stake?.settle();

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
        { name: `Bet ${money(staked)}`, value: betDescription, inline: true },
        {
          name: payout > 0 ? `🏆 ${signedMoney(payout - staked)}` : `💸 ${signedMoney(-staked)}`,
          value: payout > 0
            ? `Paid **${money(payout)}**. Balance ${money(finalBalance)}.`
            : `Balance ${money(finalBalance)}.`,
          inline: false
        }
      );

    await replyPublic(interaction, ui(embed, [], { scope: 'casino' }));
  }
};
