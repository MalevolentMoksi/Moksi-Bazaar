/**
 * Duel Command
 * Challenge other users to wagered duels with persistent state
 */

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const {
  getBalance,
  updateBalance,
  createPendingDuel,
  getPendingDuelsFor,
  updateDuelStatus,
} = require('../../utils/db');
const logger = require('../../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('duel')
    .setDescription('Challenge another user to a wagered duel')
    .addSubcommand(sub =>
      sub
        .setName('challenge')
        .setDescription('Invite someone to duel for currency')
        .addUserOption(o => o.setName('user').setDescription('Who to challenge').setRequired(true))
        .addIntegerOption(o => o.setName('amount').setDescription('Amount to wager').setRequired(true))
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
        return interaction.reply({ content: '❌ You can’t duel yourself!', flags: MessageFlags.Ephemeral});
      }
      if (pendingDuels.has(target.id)) {
        return interaction.reply({ content: '❌ That user already has a pending duel.', flags: MessageFlags.Ephemeral});
      }

      const myBal = await getBalance(me.id);
      if (myBal < amount) {
        return interaction.reply({ content: `❌ You only have $${myBal}, cannot wager $${amount}.`, flags: MessageFlags.Ephemeral});
      }

      // record the pending duel
      const timeout = setTimeout(() => {
        if (pendingDuels.has(target.id)) {
          pendingDuels.delete(target.id);
          guild.channels.cache
            .get(interaction.channelId)
            ?.send({ embeds: [
              new EmbedBuilder()
                .setTitle('⌛ Duel Expired')
                .setDescription(`${me}’s duel request to ${target} for $${amount.toLocaleString()} expired.`)
                .setColor('DarkRed')
            ]});
        }
      }, 60_000);

      pendingDuels.set(target.id, { challengerId: me.id, amount, timeout });

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('⚔️ Duel Challenge!')
            .setDescription(`${me} has challenged ${target} to a duel for **$${amount.toLocaleString()}**!\n\n` +
                            `Type \`/duel accept\` or \`/duel decline\` within 60 seconds.`)
            .setColor('Blue')
        ]
      });
    }

    // ─── ACCEPT ────────────────────────────────────────────────────────────
    if (sub === 'accept') {
      const duel = pendingDuels.get(me.id);
      if (!duel) {
        return interaction.reply({ content: '❌ You have no pending duel to accept.', flags: MessageFlags.Ephemeral});
      }
      clearTimeout(duel.timeout);
      pendingDuels.delete(me.id);

      const challenger = await guild.members.fetch(duel.challengerId);
      const amount = duel.amount;
      const balA = await getBalance(challenger.id);
      const balB = await getBalance(me.id);

      // determine winner
      const challengerWins = Math.random() < 0.5;
      const winner   = challengerWins ? challenger : interaction.member;
      const loser    = challengerWins ? interaction.member : challenger;
      const winBal   = challengerWins ? balA + amount : balB + amount;
      const loseBal  = challengerWins ? balB - amount : balA - amount;

      // update balances
      await updateBalance(winner.id, winBal);
      await updateBalance(loser.id, loseBal);

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('🏆 Duel Result')
            .setDescription(
              `${winner} won **$${amount.toLocaleString()}** from ${loser}!\n\n` +
              `• ${winner.user.tag}: $${winBal.toLocaleString()}\n` +
              `• ${loser.user.tag}: $${loseBal.toLocaleString()}`
            )
            .setColor('Green')
        ]
      });
    }

    // ─── DECLINE ───────────────────────────────────────────────────────────
    if (sub === 'decline') {
      const duel = pendingDuels.get(me.id);
      if (!duel) {
        return interaction.reply({ content: '❌ No duel to decline.', flags: MessageFlags.Ephemeral});
      }
      clearTimeout(duel.timeout);
      pendingDuels.delete(me.id);

      const challenger = await guild.members.fetch(duel.challengerId);
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
