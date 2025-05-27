// src/commands/games/poker.js
const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder
} = require('discord.js');

const pokerManager = require('../../managers/pokerManager');  // you’ll implement next
const pokerUI      = require('../../utils/pokerUI');         // you’ll implement next
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
    const sub = interaction.options.getSubcommand();
    const chan = interaction.channelId;
    const user = interaction.user.id;

    // ─── JOIN ─────────────────────────────────────────────────────
    if (sub === 'join') {
      let players;
      try {
        players = pokerManager.joinGame(chan, user);
      } catch (err) {
        return interaction.reply({ content: err.message, ephemeral: true });
      }
      // build a lobby embed + a “Start Game” button
      const embed = pokerUI.buildLobbyEmbed(players);
      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('poker:start')
            .setLabel('Start Game')
            .setStyle(ButtonStyle.Primary)
        );

      // reply or edit
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ embeds: [embed], components: [row] });
      } else {
        await interaction.reply({ embeds: [embed], components: [row] });
      }
      return;
    }

    // ─── START ────────────────────────────────────────────────────
    if (sub === 'start') {
      await interaction.deferReply();
      const players = pokerManager.getPlayers(chan);
      if (players.length < 2) {
        return interaction.editReply('❗ Need at least 2 players to start.');
      }

      // init state + DM hole cards
      const state = pokerManager.startGame(chan);
      state.players.forEach(async p => {
        try {
          const user = await interaction.client.users.fetch(p.id);
          await user.send(
            `🂠 Your hole cards: **${pokerUtils.formatCards(p.holeCards)}**`
          );
        } catch (e) {
          console.warn(`Failed to DM ${p.id}:`, e);
        }
      });

      // now render the public table embed & buttons
      const { embed, components } = pokerUI.buildGameUI(state);
      const msg = await interaction.editReply({ embeds: [embed], components });

      // ── Step 6: schedule per-turn auto-action after 60s ─────────────
      let turnTimeout;
      const scheduleTimeout = () => {
        clearTimeout(turnTimeout);
        turnTimeout = setTimeout(async () => {
          // auto-fold if there's a bet to call, else auto-check
          const curr  = state.players[state.currentPlayerIndex];
          const contrib = state.bets.get(curr.id) || 0;
          const action = state.currentBet > contrib ? 'fold' : 'check';

          // advance via pokerManager
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
        const currentId = state.players[state.currentPlayerIndex].id;
        if (btn.user.id !== currentId) {
          return btn.reply({ content: '⏳ Not your turn!', ephemeral: true });
        }

        await btn.deferUpdate();

        // parse customId (“poker:action:amount”)
        const [ , action, amtStr ] = btn.customId.split(':');
        const amount = amtStr ? parseInt(amtStr, 10) : null;

        // advance the state
        const updated = pokerManager.handleAction(chan, action, amount);

        // rebuild UI
        const { embed: newEmbed, components: newComps, gameOver } =
          pokerUI.buildGameUI(updated);

        // Handle game over (showdown or single player)
        if (gameOver && updated.winners) {
          // Process payouts
          for (const [userId, chips] of Object.entries(updated.payouts)) {
            const bal = await getBalance(userId);
            await updateBalance(userId, bal + chips);
          }

          // Build final results embed
          const resultsEmbed = new EmbedBuilder()
            .setTitle('🏆 Poker Results')
            .setColor('#FFD700')
            .addFields(
              {
                name: 'Winners',
                value: updated.winners
                  .map(w => `<@${w.id}> (${w.hand.name})`)
                  .join('\n'),
                inline: false
              },
              {
                name: 'Payouts',
                value: Object.entries(updated.payouts)
                  .map(([id, chips]) => `<@${id}>: ${chips} chips`)
                  .join('\n'),
                inline: false
              },
              {
                name: 'Final Hands',
                value: updated.players
                  .map(p => `<@${p.id}>: ${pokerUtils.formatCards(p.holeCards)}`)
                  .join('\n'),
                inline: false
              }
            );

          // Send final results and clean up
          await msg.edit({ embeds: [resultsEmbed], components: newComps });
          pokerManager.games.delete(chan);
          collector.stop();
          return;
        }

        await msg.edit({ embeds: [newEmbed], components: newComps });

        // reset the per-turn clock
        scheduleTimeout();

        if (gameOver) collector.stop();
      });

      collector.on('end', async (collected, reason) => {
        // clear any pending auto-action
        clearTimeout(turnTimeout);

        // build disabled copies of each row
        const disabledRows = msg.components.map(r => {
          const row = ActionRowBuilder.from(r);
          row.components.forEach(btn => btn.setDisabled(true));
          return row;
        });
        await msg.edit({ components: disabledRows });
      });
    }
  }
};
