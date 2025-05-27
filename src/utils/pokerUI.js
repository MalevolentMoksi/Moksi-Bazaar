// src/utils/pokerUI.js
// Builds embeds and components for poker lobby and in-game UI

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');
const pokerUtils = require('./pokerUtils');

/**
 * Build the lobby embed showing joined players.
 * @param {string[]} players  Array of user IDs
 * @returns {EmbedBuilder}
 */
function buildLobbyEmbed(players) {
  const embed = new EmbedBuilder()
    .setTitle("🃏 Texas Hold 'Em Lobby")
    .setDescription(
      players.length
        ? players.map((id, i) => `${i + 1}. <@${id}>`).join('\n')
        : 'No players yet. Click Join to start playing!'
    )
    .addFields({ name: 'Players', value: `${players.length}`, inline: true });
  return embed;
}

/**
 * Build the main game embed and action buttons.
 * @param {object} state  Game state from pokerManager
 * @returns {{ embed: EmbedBuilder, components: ActionRowBuilder[], gameOver: boolean }}
 */
function buildGameUI(state) {
  const {
    players,
    communityCards,
    pot,
    currentBet,
    stage,
    currentPlayerIndex,
    bets
  } = state;

  // Embed with table info
  const embed = new EmbedBuilder()
    .setTitle("🃏 Texas Hold 'Em")
    .addFields(
      { name: 'Stage', value: stage, inline: true },
      { name: 'Pot', value: `${pot}`, inline: true },
      { name: 'Current Bet', value: `${currentBet}`, inline: true },
      {
        name: 'Community Cards',
        value:
          communityCards.length > 0
            ? pokerUtils.formatCards(communityCards)
            : 'None',
        inline: false
      },
      {
        name: 'Players',
        value: players
          .map((p, i) => {
            const prefix = i === currentPlayerIndex ? '➡️ ' : '';
            const status = p.isActive ? 'Active' : 'Folded';
            const contributed = bets.get(p.id) || 0;
            // Always mask hole cards
            const hole = p.isActive ? '🂠 🂠' : '❌';
            return (
              `${prefix}<@${p.id}> • ${status} • Bet: ${contributed}\n` +
              `Hole: ${hole}`
            );
          })
          .join('\n\n'),
        inline: false
      }
    );

  // Determine if game is over (only one player left or showdown)
  const activeCount = players.filter(p => p.isActive).length;
  const gameOver = activeCount <= 1 || stage === 'showdown';

  // Build action buttons if still playing
  const components = [];
  if (!gameOver) {
    const current = players[currentPlayerIndex];
    const contributed = bets.get(current.id) || 0;
    const toCall = currentBet - contributed;
    const row = new ActionRowBuilder();

    // Fold
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('poker:fold')
        .setLabel('Fold')
        .setStyle(ButtonStyle.Danger)
    );

    // Check or Call
    if (toCall <= 0) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId('poker:check')
          .setLabel('Check')
          .setStyle(ButtonStyle.Secondary)
      );
    } else {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`poker:call:${toCall}`)
          .setLabel(`Call (${toCall})`)
          .setStyle(ButtonStyle.Primary)
      );
    }

    // Bet/Raise presets: minimal amounts
    const betAmt = currentBet === 0 ? 10 : currentBet * 2;
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`poker:bet:${betAmt}`)
        .setLabel(`Bet ${betAmt}`)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`poker:raise:${betAmt}`)
        .setLabel(`Raise to ${betAmt}`)
        .setStyle(ButtonStyle.Primary)
    );

    components.push(row);
  }

  return { embed, components, gameOver };
}

module.exports = { buildLobbyEmbed, buildGameUI };
