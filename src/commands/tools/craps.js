/**
 * Craps Game Command
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags
} = require('discord.js');
const { adjustBalance, recordGameResult } = require('../../utils/db');
const { ui, retireControls } = require('../../utils/ui/panel');
const { considerHeckle } = require('../../utils/casinoHeckle');
const { deductBet, resolveBet, notYourTable } = require('../../utils/gameHelpers');
const { ackPublic, replyPrivate } = require('../../utils/interactionAck');
const { money, parseAmount, AMOUNT_HINT } = require('../../utils/money');
const logger = require('../../utils/logger');
const { GAME_CONFIG, EMBED_COLORS } = require('../../utils/constants');

function rollDie() {
  return Math.floor(Math.random() * 6) + 1;
}

function playCraps() {
  const rolls = [];
  const roll = () => {
    const d1 = rollDie();
    const d2 = rollDie();
    const total = d1 + d2;
    rolls.push({ d1, d2, total });
    return total;
  };

  const first = roll();
  if (first === 7 || first === 11) {
    return { win: true, result: '🎉 Natural! You win!', rolls };
  }
  if ([2, 3, 12].includes(first)) {
    return { win: false, result: '💥 Craps! You lose.', rolls };
  }

  const point = first;
  while (true) {
    const total = roll();
    if (total === point) {
      return { win: true, result: `🎯 Hit the point (${point})! You win!`, rolls };
    }
    if (total === 7) {
      return {
        win: false,
        result: `💔 Rolled a 7 before hitting ${point}. You lose.`,
        rolls
      };
    }
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('craps')
    .setDescription('Roll the dice in a game of Craps')
    .addStringOption(o =>
      o.setName('bet')
        .setDescription('How much: 500, 10k, half or all')
        .setRequired(true)
    ),

  async execute(interaction) {
    const userId = interaction.user.id;

    // Shape first, while a private rejection costs nothing.
    const spec = parseAmount(interaction.options.getString('bet'));
    if (!spec) {
      return interaction.reply({ content: AMOUNT_HINT, flags: MessageFlags.Ephemeral });
    }

    // Acknowledged before the money moves. The deduction used to come first,
    // so a slow query could take the bet and then miss Discord's three-second
    // window, leaving the player charged for a game they never saw.
    await ackPublic(interaction);

    let bet = await resolveBet(userId, spec);
    const originalBet = bet;
    const deductResult = await deductBet(userId, bet, { game: 'craps' });
    if (!deductResult.success) {
      return replyPrivate(interaction, deductResult.error);
    }

    let balance = deductResult.newBalance;
    let stake = deductResult.stake;

    // "Play again" calls runRound() again and edits the same message, so the
    // rendering has to stay whatever that message was born as. Without this a
    // toggle flipped between rounds would try to change a message's shape,
    // which Discord refuses.
    let board = null;

    await runRound();

    async function runRound() {
      const game = playCraps();
      const payout = game.win ? bet * 2 : 0;
      if (payout > 0) {
        balance = await adjustBalance(userId, payout);
      }
      // Resolved either way; the bet is no longer owed back on a restart.
      await stake?.settle();
      recordGameResult(userId, 'craps', { wagered: bet, returned: payout }).catch(() => {});
      considerHeckle({
        channel: interaction.channel,
        userId,
        username: interaction.user.username,
        game: 'craps',
        wagered: bet,
        returned: payout,
      });

      const desc = game.rolls
        .map((r, i) => `Roll ${i + 1}: **${r.d1} + ${r.d2} = ${r.total}**`)
        .join('\n');

      const embed = new EmbedBuilder()
        .setTitle('🎲 Craps')
        .setColor(game.win ? EMBED_COLORS.WIN : EMBED_COLORS.LOSE)
        .setDescription(desc)
        .addFields(
          { name: 'Result', value: game.result, inline: false },
          { name: 'Bet', value: money(bet), inline: true },
          { name: 'Balance', value: money(balance), inline: true }
        );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('craps_play_again')
          .setLabel(`Roll again (${money(originalBet)})`)
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('craps_exit')
          .setLabel('Leave the table')
          .setStyle(ButtonStyle.Secondary)
      );

      const payload = board
        ? ui(embed, [row], { like: board })
        : ui(embed, [row], { scope: 'casino' });
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply(payload);
      }

      const message = await interaction.fetchReply();
      board = message;
      const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: GAME_CONFIG.CRAPS.COLLECTOR_TIMEOUT,
      });

      collector.on('collect', async (btnInt) => {
        if (btnInt.user.id !== userId) {
          return btnInt.reply({
            content: notYourTable('craps'),
            flags: MessageFlags.Ephemeral,
          });
        }
        await btnInt.deferUpdate();

        if (btnInt.customId === 'craps_play_again') {
          const deductAgain = await deductBet(userId, originalBet, { game: 'craps' });
          if (!deductAgain.success) {
            return await btnInt.followUp({
              content: deductAgain.error,
              flags: MessageFlags.Ephemeral,
            });
          }
          balance = deductAgain.newBalance;
          stake = deductAgain.stake;
          bet = originalBet;
          logger.info('Craps: Player starting new round', { userId, bet });
          // Retire this collector before the next round attaches its own,
          // otherwise every past round's collector also processes the click.
          collector.stop('superseded');
          await runRound();
        } else if (btnInt.customId === 'craps_exit') {
          logger.info('Craps: Player exited game', { userId, finalBalance: balance });
          collector.stop('left');
        }
      });

      // The buttons used to outlive the game: after Leave or a minute of
      // nothing, Roll again stayed on screen and answered with "that one's
      // dead". A new round replaces them itself, so only these two endings
      // take them away.
      collector.on('end', async (_c, reason) => {
        if (reason !== 'time' && reason !== 'left') return;
        try { await message.edit(retireControls(message)); } catch { /* message may be gone */ }
      });
    }
  }
};
