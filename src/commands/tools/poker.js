// src/commands/games/poker.js
const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder
} = require('discord.js');

const pokerManager = require('../../managers/pokerManager');
const pokerUI      = require('../../utils/pokerUI');
const pokerUtils   = require('../../utils/pokerUtils');
const { getBalance, updateBalance } = require('../../utils/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('poker')
    .setDescription("Multiplayer Texas Hold 'Em")
    .addSubcommand(sub =>
      sub.setName('join')
         .setDescription('Join the poker table'))
    .addSubcommand(sub =>
      sub.setName('start')
         .setDescription('Start the poker game (min 2 players)')),

  async execute(interaction) {
    const sub    = interaction.options.getSubcommand();
    const chan   = interaction.channelId;
    const userId = interaction.user.id;

    // ─── JOIN ─────────────────────────────────────────────────────
    if (sub === 'join') {
      let players;
      try {
        players = pokerManager.joinGame(chan, userId);
      } catch (err) {
        return interaction.reply({ content: err.message, ephemeral: true });
      }

      const embed = pokerUI.buildLobbyEmbed(players);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('poker:start')
          .setLabel('Start Game')
          .setStyle(ButtonStyle.Primary)
      );

      // send or edit the lobby message
      let lobbyMsg;
      if (interaction.deferred || interaction.replied) {
        lobbyMsg = await interaction.editReply({ embeds: [embed], components: [row] });
      } else {
        lobbyMsg = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });
      }

      // attach a one-time collector to handle the button
      const collector = lobbyMsg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 5 * 60 * 1000
      });

      collector.on('collect', async btn => {
        if (btn.customId !== 'poker:start') return;
        await btn.deferUpdate();       // acknowledge the click
        collector.stop();              // prevent double-starts
        // hand off to the same logic as `/poker start`
        await handleStart(btn);
      });

      return;
    }

    // ─── START (slash subcommand) ────────────────────────────────
    if (sub === 'start') {
      await handleStart(interaction);
      return;
    }
  }
};


/**
 * Shared logic for initiating a poker game (slash or button).
 * Expects an Interaction (ChatInput or Button).
 */
async function handleStart(interaction) {
  // use deferReply to give us a “deferred” message to edit
  await interaction.deferReply();

  const chan    = interaction.channelId;
  const players = pokerManager.getPlayers(chan);
  if (players.length < 2) {
    return interaction.editReply('❗ Need at least 2 players to start.');
  }

  // initialize game state
  const state = pokerManager.startGame(chan);

  // render the public table
  const { embed, components } = pokerUI.buildGameUI(state);
  const msg = await interaction.editReply({ embeds: [embed], components });

  // per-turn auto-action timer
  let turnTimeout;
  const scheduleTimeout = () => {
    clearTimeout(turnTimeout);
    turnTimeout = setTimeout(async () => {
      const curr    = state.players[state.currentPlayerIndex];
      const contrib = state.bets.get(curr.id) || 0;
      const action  = state.currentBet > contrib ? 'fold' : 'check';
      const updated = pokerManager.handleAction(chan, action);
      const { embed: e2, components: c2, gameOver } = pokerUI.buildGameUI(updated);
      await msg.edit({ embeds: [e2], components: c2 });
      if (!gameOver) scheduleTimeout();
    }, 60_000);
  };
  scheduleTimeout();

  // collect all button presses for up to 15 minutes
  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 15 * 60 * 1000
  });

  collector.on('collect', async btn => {
    await btn.deferUpdate();
    const [ , action, param ] = btn.customId.split(':');

    // Reveal‐cards button
    if (action === 'reveal') {
      if (btn.user.id !== param) {
        return btn.followUp({ content: '❌ That’s not your button!', ephemeral: true });
      }
      const pstate = state.players.find(p => p.id === param);
      return btn.followUp({
        content: `🂠 Your hole cards: **${pokerUtils.formatCards(pstate.holeCards)}**`,
        ephemeral: true
      });
    }

    // Enforce turn
    const currentId = state.players[state.currentPlayerIndex].id;
    if (btn.user.id !== currentId) {
      return btn.followUp({ content: '⏳ Not your turn!', ephemeral: true });
    }

    // Advance action
    const amount  = ['fold','check'].includes(action) ? null : parseInt(param, 10);
    const updated = pokerManager.handleAction(interaction.channelId, action, amount);
    const { embed: newEmbed, components: newComps, gameOver } = pokerUI.buildGameUI(updated);

    // Game over: payouts & final embed
    if (gameOver && updated.winners) {
      for (const [uid, chips] of Object.entries(updated.payouts)) {
        const bal = await getBalance(uid);
        await updateBalance(uid, bal + chips);
      }
      const resultsEmbed = new EmbedBuilder()
        .setTitle('🏆 Poker Results')
        .setColor('#FFD700')
        .addFields(
          {
            name: 'Winners',
            value: updated.winners
              .map(w => `<@${w.id}> (${w.hand.name})`)
              .join('\n'),
          },
          {
            name: 'Payouts',
            value: Object.entries(updated.payouts)
              .map(([id, ch]) => `<@${id}>: ${ch} chips`)
              .join('\n'),
          },
          {
            name: 'Final Hands',
            value: state.players
              .map(p => `<@${p.id}>: ${pokerUtils.formatCards(p.holeCards)}`)
              .join('\n'),
          }
        );
      await msg.edit({ embeds: [resultsEmbed], components: newComps });
      pokerManager.games.delete(interaction.channelId);
      collector.stop();
      return;
    }

    // Normal update
    await msg.edit({ embeds: [newEmbed], components: newComps });
    scheduleTimeout();
    if (gameOver) collector.stop();
  });

  collector.on('end', async () => {
    clearTimeout(turnTimeout);
    const disabledRows = msg.components.map(r => {
      const row = ActionRowBuilder.from(r);
      row.components.forEach(b => b.setDisabled(true));
      return row;
    });
    await msg.edit({ components: disabledRows });
  });
}
