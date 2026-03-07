/**
 * Duel Command
 * Challenge other users to wagered duels with persistent DB-backed state
 */

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const {
  getBalance,
  updateBalance,
  createPendingDuel,
  getPendingDuelsFor,
  updateDuelStatus,
  deleteDuel,
} = require('../../utils/db');
const logger = require('../../utils/logger');
const { GAME_CONFIG } = require('../../utils/constants');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('duel')
    .setDescription('Challenge another user to a wagered duel')
    .addSubcommand(sub =>
      sub
        .setName('challenge')
        .setDescription('Invite someone to duel for currency')
        .addUserOption(o => o.setName('user').setDescription('Who to challenge').setRequired(true))
        .addIntegerOption(o => o.setName('amount').setDescription('Amount to wager').setRequired(true).setMinValue(1))
    )
    .addSubcommand(sub =>
      sub.setName('accept').setDescription('Accept a pending duel'))
    .addSubcommand(sub =>
      sub.setName('decline').setDescription('Decline a pending duel')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const me = interaction.user;
    const guild = interaction.guild;

    // ─── CHALLENGE ─────────────────────────────────────────────────────────
    if (sub === 'challenge') {
      const target = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');

      if (target.id === me.id) {
        return interaction.reply({ content: '❌ You can\'t duel yourself!', flags: MessageFlags.Ephemeral });
      }

      // Check for existing pending duels in DB
      const existingDuels = await getPendingDuelsFor(target.id);
      if (existingDuels.length > 0) {
        return interaction.reply({ content: '❌ That user already has a pending duel.', flags: MessageFlags.Ephemeral });
      }

      const myBal = await getBalance(me.id);
      if (myBal < amount) {
        return interaction.reply({ content: `❌ You only have $${myBal}, cannot wager $${amount}.`, flags: MessageFlags.Ephemeral });
      }

      // Record the pending duel in DB (auto-expires via expires_at column)
      const duelTimeout = GAME_CONFIG.DUELS.DUEL_TIMEOUT;
      await createPendingDuel(me.id, target.id, amount, duelTimeout);

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('⚔️ Duel Challenge!')
            .setDescription(`${me} has challenged ${target} to a duel for **$${amount.toLocaleString()}**!\n\n` +
                            `Type \`/duel accept\` or \`/duel decline\` within ${duelTimeout / 1000} seconds.`)
            .setColor('Blue')
        ]
      });
    }

    // ─── ACCEPT ────────────────────────────────────────────────────────────
    if (sub === 'accept') {
      const duels = await getPendingDuelsFor(me.id);
      if (duels.length === 0) {
        return interaction.reply({ content: '❌ You have no pending duel to accept.', flags: MessageFlags.Ephemeral });
      }
      const duel = duels[0];
      await updateDuelStatus(duel.id, 'accepted');

      const challenger = await guild.members.fetch(duel.challenger_id);
      const amount = parseInt(duel.amount, 10);
      const balA = await getBalance(duel.challenger_id);
      const balB = await getBalance(me.id);

      // Check both players still have funds
      if (balA < amount) {
        await deleteDuel(duel.id);
        return interaction.reply({ content: `❌ ${challenger} no longer has enough funds.`, flags: MessageFlags.Ephemeral });
      }
      if (balB < amount) {
        await deleteDuel(duel.id);
        return interaction.reply({ content: '❌ You no longer have enough funds.', flags: MessageFlags.Ephemeral });
      }

      // Determine winner
      const challengerWins = Math.random() < 0.5;
      const winner = challengerWins ? challenger : interaction.member;
      const loser = challengerWins ? interaction.member : challenger;
      const winBal = challengerWins ? balA + amount : balB + amount;
      const loseBal = challengerWins ? balB - amount : balA - amount;

      // Update balances and mark duel completed
      await Promise.all([
        updateBalance(winner.id, winBal),
        updateBalance(loser.id, loseBal),
        updateDuelStatus(duel.id, 'completed'),
      ]);

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('🏆 Duel Result')
            .setDescription(
              `${winner} won **$${amount.toLocaleString()}** from ${loser}!\n\n` +
              `• ${winner.user.username}: $${winBal.toLocaleString()}\n` +
              `• ${loser.user.username}: $${loseBal.toLocaleString()}`
            )
            .setColor('Green')
        ]
      });
    }

    // ─── DECLINE ───────────────────────────────────────────────────────────
    if (sub === 'decline') {
      const duels = await getPendingDuelsFor(me.id);
      if (duels.length === 0) {
        return interaction.reply({ content: '❌ No duel to decline.', flags: MessageFlags.Ephemeral });
      }
      const duel = duels[0];
      await deleteDuel(duel.id);

      const challenger = await guild.members.fetch(duel.challenger_id);
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ Duel Declined')
            .setDescription(`${me} declined the duel request from ${challenger}.`)
            .setColor('DarkRed')
        ]
      });
    }
  }
};
