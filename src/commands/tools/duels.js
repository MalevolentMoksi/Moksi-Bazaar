/**
 * Duel Command
 * Challenge other users to wagered duels with persistent DB-backed state
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
  getBalance,
  transferBalance,
  createPendingDuel,
  getPendingDuelsFor,
  getPendingDuelsFrom,
  updateDuelStatus,
  deleteDuel,
  recordGameResult,
} = require('../../utils/db');
const { ackPublic, replyPublic, replyPrivate } = require('../../utils/interactionAck');
const logger = require('../../utils/logger');
const { GAME_CONFIG } = require('../../utils/constants');
const { ui } = require('../../utils/ui/panel');

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

    // Every branch below opens with database work, and accept goes on to fetch
    // a member from the API and move money. Any of that can outlast Discord's
    // three-second window, which used to leave the wager transferred and both
    // players staring at "This interaction failed".
    await ackPublic(interaction);

    // ─── CHALLENGE ─────────────────────────────────────────────────────────
    if (sub === 'challenge') {
      const target = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');

      if (target.id === me.id) {
        return replyPrivate(interaction, '❌ You can\'t duel yourself!');
      }

      // Check for existing pending duels in DB, on both sides: the target
      // can only field one challenge, and a challenger cannot fan out
      // simultaneous wagers backed by the same money.
      const existingDuels = await getPendingDuelsFor(target.id);
      if (existingDuels.length > 0) {
        return replyPrivate(interaction, '❌ That user already has a pending duel.');
      }
      const myOutgoing = await getPendingDuelsFrom(me.id);
      if (myOutgoing.length > 0) {
        return replyPrivate(interaction, '❌ You already have an outgoing duel challenge. Wait for it to be answered or expire.');
      }

      const myBal = await getBalance(me.id);
      if (myBal < amount) {
        return replyPrivate(interaction, `❌ You only have $${myBal}, cannot wager $${amount}.`);
      }

      // Record the pending duel in DB (auto-expires via expires_at column)
      const duelTimeout = GAME_CONFIG.DUELS.DUEL_TIMEOUT;
      await createPendingDuel(me.id, target.id, amount, duelTimeout);

      const challenge = new EmbedBuilder()
        .setTitle('⚔️ Duel Challenge!')
        .setDescription(`${me} has challenged ${target} to a duel for **$${amount.toLocaleString()}**!\n\n` +
                        `Type \`/duel accept\` or \`/duel decline\` within ${duelTimeout / 1000} seconds.`)
        .setColor('Blue');

      return replyPublic(interaction, ui(challenge, [], { scope: 'casino' }));
    }

    // ─── ACCEPT ────────────────────────────────────────────────────────────
    if (sub === 'accept') {
      const duels = await getPendingDuelsFor(me.id);
      if (duels.length === 0) {
        return replyPrivate(interaction, '❌ You have no pending duel to accept.');
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
        return replyPrivate(interaction, `❌ ${challenger} no longer has enough funds.`);
      }
      if (balB < amount) {
        await deleteDuel(duel.id);
        return replyPrivate(interaction, '❌ You no longer have enough funds.');
      }

      // Determine winner
      const challengerWins = Math.random() < 0.5;
      const winner = challengerWins ? challenger : interaction.member;
      const loser = challengerWins ? interaction.member : challenger;

      // Settle both sides in one transaction; null means the loser's funds
      // moved between the check above and now.
      const transfer = await transferBalance(loser.id, winner.id, amount);
      if (!transfer) {
        await deleteDuel(duel.id);
        return replyPrivate(interaction, '❌ The duel could not be settled: the funds are no longer there.');
      }
      const winBal = transfer.toBalance;
      const loseBal = transfer.fromBalance;

      await updateDuelStatus(duel.id, 'completed');

      // Both sides staked the same amount; the winner gets theirs back plus
      // the loser's, which is what makes this a zero-sum entry in the books.
      recordGameResult(winner.id, 'duel', { wagered: amount, returned: amount * 2 }).catch(() => {});
      recordGameResult(loser.id, 'duel', { wagered: amount, returned: 0 }).catch(() => {});

      logger.info('Duel settled', { winner: winner.id, loser: loser.id, amount });

      const result = new EmbedBuilder()
        .setTitle('🏆 Duel Result')
        .setDescription(
          `${winner} won **$${amount.toLocaleString()}** from ${loser}!\n\n` +
          `• ${winner.user.username}: $${winBal.toLocaleString()}\n` +
          `• ${loser.user.username}: $${loseBal.toLocaleString()}`
        )
        .setColor('Green');

      return replyPublic(interaction, ui(result, [], { scope: 'casino' }));
    }

    // ─── DECLINE ───────────────────────────────────────────────────────────
    if (sub === 'decline') {
      const duels = await getPendingDuelsFor(me.id);
      if (duels.length === 0) {
        return replyPrivate(interaction, '❌ No duel to decline.');
      }
      const duel = duels[0];
      await deleteDuel(duel.id);

      const challenger = await guild.members.fetch(duel.challenger_id);
      const declined = new EmbedBuilder()
        .setTitle('❌ Duel Declined')
        .setDescription(`${me} declined the duel request from ${challenger}.`)
        .setColor('DarkRed');

      return replyPublic(interaction, ui(declined, [], { scope: 'casino' }));
    }
  }
};
