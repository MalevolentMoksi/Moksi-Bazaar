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
const { getBalance, updateBalance } = require('../../utils/db');
const { deductBet } = require('../../utils/gameHelpers');
const logger = require('../../utils/logger');
const config = require('../../config');

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
    .addIntegerOption(o =>
      o.setName('bet')
        .setDescription('Amount to wager')
        .setRequired(true)
        .setMinValue(1)
    ),

  async execute(interaction) {
    const userId = interaction.user.id;
    let bet = interaction.options.getInteger('bet');
    const originalBet = bet;

    // Deduct bet
    const deductResult = await deductBet(userId, bet);
    if (!deductResult.success) {
      return interaction.reply({
        content: `❌ ${deductResult.error}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    let balance = deductResult.newBalance;

    await interaction.deferReply();
    await runRound();

    async function runRound() {
      const game = playCraps();
      const payout = game.win ? bet * 2 : 0;
      balance += payout;
      await updateBalance(userId, balance);

      const desc = game.rolls
        .map((r, i) => `Roll ${i + 1}: **${r.d1} + ${r.d2} = ${r.total}**`)
        .join('\n');

      const embed = new EmbedBuilder()
        .setTitle('🎲 Craps')
        .setColor(game.win ? 0x2ecc71 : 0xe74c3c)
        .setDescription(desc)
        .addFields(
          { name: 'Result', value: game.result, inline: false },
          { name: 'Bet', value: `$${bet}`, inline: true },
          { name: 'Balance', value: `$${balance}`, inline: true }
        );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('craps_play_again')
          .setLabel('Play Again')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('craps_exit')
          .setLabel('Exit Game')
          .setStyle(ButtonStyle.Danger)
      );

      if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ embeds: [embed], components: [row] });
      } else {
        await interaction.reply({ embeds: [embed], components: [row] });
      }

      const message = await interaction.fetchReply();
      const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: config.GAMES.CRAPS.COLLECTOR_TIMEOUT,
      });

      collector.on('collect', async (btnInt) => {
        if (btnInt.user.id !== userId) {
          return btnInt.reply({
            content: 'This is not your game!',
            flags: MessageFlags.Ephemeral,
          });
        }
        await btnInt.deferUpdate();

        if (btnInt.customId === 'craps_play_again') {
          const deductAgain = await deductBet(userId, originalBet);
          if (!deductAgain.success) {
            return await btnInt.followUp({
              content: `Could not deduct bet: ${deductAgain.error}`,
              flags: MessageFlags.Ephemeral,
            });
          }
          balance = deductAgain.newBalance;
          bet = originalBet;
          logger.info('Craps: Player starting new round', { userId, bet });
          await runRound();
        } else if (btnInt.customId === 'craps_exit') {
          logger.info('Craps: Player exited game', { userId, finalBalance: balance });
          collector.stop();
        }
      });

      collector.on('end', () => {
        logger.debug('Craps collector ended', { userId });
      });
    }
  }
};
