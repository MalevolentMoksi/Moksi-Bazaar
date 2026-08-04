// src/commands/tools/bj.js
/**
 * Blackjack. The rules live in utils/blackjack.js; this file owns the buttons,
 * the embeds and the money.
 *
 * Money rule, inherited from the casino repair pass: every wager leaves the
 * balance through adjustBalance the instant it is committed, and every payout
 * returns through adjustBalance exactly once at settlement. A round is settled
 * behind a flag so no sequence of clicks can pay twice.
 */

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ComponentType, MessageFlags,
} = require('discord.js');
const { getBalance, adjustBalance, recordGameResult } = require('../../utils/db');
const { deductBet } = require('../../utils/gameHelpers');
const { considerHeckle } = require('../../utils/casinoHeckle');
const logger = require('../../utils/logger');
const { GAME_CONFIG } = require('../../utils/constants');
const BJ = require('../../utils/blackjack');

const TIMEOUT = GAME_CONFIG.BLACKJACK.COLLECTOR_TIMEOUT;

/** Accepts a plain number, or `all`/`max`/`half` measured against the balance. */
function parseBet(raw, balance) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (text === 'all' || text === 'max') return balance;
  if (text === 'half') return Math.floor(balance / 2);
  const n = Number(text.replace(/[,_\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.floor(n);
}

const money = n => `$${Number(n).toLocaleString()}`;

/** Signed, so a losing session reads as a loss rather than as a small number. */
function signedMoney(n) {
  const v = Number(n);
  return `${v > 0 ? '+' : v < 0 ? '-' : ''}${money(Math.abs(v))}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bj')
    .setDescription('Play a round of Blackjack')
    .addSubcommand(sub => sub
      .setName('start')
      .setDescription('Start a new game')
      .addStringOption(opt => opt
        .setName('bet')
        .setDescription('Amount to bet, or all / half / max')
        .setRequired(true)
      )
    ),

  async execute(interaction) {
    if (interaction.options.getSubcommand() !== 'start') return;
    const userId = interaction.user.id;

    // Shape check first, while a private rejection is still possible.
    const rawBet = interaction.options.getString('bet');
    if (parseBet(rawBet, 0) === null) {
      return interaction.reply({
        content: '💰 Bet a whole number of dollars, or `all`, `half`, or `max`.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Deferred before any money moves. If the interaction is going to fail,
    // it fails while the balance is still untouched.
    await interaction.deferReply();

    const startingBalance = await getBalance(userId);
    const openingBet = parseBet(rawBet, startingBalance);
    if (openingBet < 1) {
      return interaction.editReply('💰 That comes to nothing. Bet something you have.');
    }

    const opening = await deductBet(userId, openingBet);
    if (!opening.success) {
      return interaction.editReply(`💰 ${opening.error}`);
    }

    let balance = opening.newBalance;
    // Everything staked and everything returned across this /bj session, so the
    // footer can show what the seat has actually cost.
    const session = { wagered: openingBet, returned: 0 };

    let roundCollector = null;
    let endCollector = null;
    /**
     * The board, held across rounds.
     *
     * Every update after the first goes through Message#edit rather than
     * interaction.editReply: the interaction token dies after fifteen minutes
     * and a seat can easily outlast that, at which point every further edit
     * would throw and the table would freeze mid-hand.
     */
    let gameMessage = null;

    /** Collector callbacks are not covered by the command error handler. */
    const safe = fn => async (...args) => {
      try {
        await fn(...args);
      } catch (error) {
        logger.error('Blackjack interaction failed', {
          userId, error: error.message, stack: error.stack,
        });
      }
    };

    // ── Rendering ───────────────────────────────────────────────────────────

    function buildEmbed(state, { reveal = false, description = null } = {}) {
      const { hands, dealerCards, activeIndex } = state;
      const embed = new EmbedBuilder().setTitle('🎲 Blackjack');

      if (reveal) {
        embed.addFields({
          name: `Dealer (${BJ.formatValue(dealerCards)})`,
          value: BJ.formatCards(dealerCards),
        });
      } else {
        const up = dealerCards[0];
        embed.addFields({
          name: `Dealer (showing ${up.rank})`,
          value: `${up.rank}${up.suit} 🂠`,
        });
      }

      for (const [i, hand] of hands.entries()) {
        const marker = hands.length > 1 && i === activeIndex && !reveal ? ' ▶' : '';
        const label = hands.length > 1 ? `Hand ${i + 1}` : 'Your hand';
        const extras = [];
        if (hand.doubled) extras.push('doubled');
        if (hand.splitAces) extras.push('split ace');
        const suffix = extras.length ? ` [${extras.join(', ')}]` : '';
        const outcome = hand.outcome ? `\n${BJ.OUTCOME_TEXT[hand.outcome]}` : '';
        embed.addFields({
          name: `${label} (${BJ.formatValue(hand.cards)})${marker}`,
          value: `${BJ.formatCards(hand.cards)} · ${money(hand.bet)}${suffix}${outcome}`,
        });
      }

      const staked = hands.reduce((sum, h) => sum + h.bet, 0);
      embed.addFields(
        { name: 'On the table', value: money(staked), inline: true },
        { name: 'Balance', value: money(balance), inline: true },
      );

      if (description) embed.setDescription(description);

      const net = session.returned - session.wagered;
      embed.setFooter({ text: `This session: ${signedMoney(net)}` });

      if (reveal) {
        const anyWin = hands.some(h => ['natural', 'even_money', 'win'].includes(h.outcome));
        const anyLoss = hands.some(h => ['lose', 'bust', 'dealer_natural'].includes(h.outcome));
        if (hands.some(h => h.outcome === 'natural')) {
          embed.setColor(GAME_CONFIG.BLACKJACK.COLOR_BLACKJACK);
        } else if (anyWin && !anyLoss) {
          embed.setColor(GAME_CONFIG.BLACKJACK.COLOR_WIN);
        } else if (anyLoss && !anyWin) {
          embed.setColor(GAME_CONFIG.BLACKJACK.COLOR_LOSS);
        }
      }
      return embed;
    }

    const BUTTONS = {
      hit: ['bj_hit', 'Hit', ButtonStyle.Success],
      stand: ['bj_stand', 'Stand', ButtonStyle.Danger],
      double: ['bj_double', 'Double', ButtonStyle.Primary],
      split: ['bj_split', 'Split', ButtonStyle.Primary],
      surrender: ['bj_surrender', 'Surrender', ButtonStyle.Secondary],
    };

    function actionRow(actions) {
      const row = new ActionRowBuilder();
      for (const action of actions) {
        const [id, label, style] = BUTTONS[action];
        row.addComponents(new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style));
      }
      return [row];
    }

    function rebetRow(lastBet) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('bj_again_same')
          .setLabel(`Again (${money(lastBet)})`).setStyle(ButtonStyle.Success),
      );
      if (balance >= lastBet * 2) {
        row.addComponents(new ButtonBuilder().setCustomId('bj_again_double')
          .setLabel(`Double (${money(lastBet * 2)})`).setStyle(ButtonStyle.Primary));
      }
      if (lastBet >= 2) {
        row.addComponents(new ButtonBuilder().setCustomId('bj_again_half')
          .setLabel(`Half (${money(Math.floor(lastBet / 2))})`).setStyle(ButtonStyle.Secondary));
      }
      row.addComponents(new ButtonBuilder().setCustomId('bj_exit')
        .setLabel('Cash out').setStyle(ButtonStyle.Danger));
      return [row];
    }

    // ── Round ───────────────────────────────────────────────────────────────

    async function runRound(bet) {
      if (roundCollector) { roundCollector.stop('superseded'); roundCollector = null; }
      if (endCollector) { endCollector.stop('superseded'); endCollector = null; }

      const deck = BJ.createShuffledDeck();
      const state = {
        deck,
        dealerCards: [BJ.drawCard(deck), BJ.drawCard(deck)],
        hands: [],
        activeIndex: 0,
        settled: false,
      };
      state.hands.push(BJ.makeHand([BJ.drawCard(deck), BJ.drawCard(deck)], bet));

      const dealerNatural = BJ.isNatural(state.dealerCards);
      const playerNatural = state.hands[0].natural;
      const upcard = state.dealerCards[0];

      const board = { embeds: [buildEmbed(state)], components: [] };
      if (gameMessage) await gameMessage.edit(board);
      else gameMessage = await interaction.editReply(board);
      const message = gameMessage;

      // Even money: offered before the peek, because hedging after you already
      // know the hole card would not be a hedge.
      if (playerNatural && upcard.rank === 'A') {
        return offerEvenMoney(state, message);
      }

      // The peek. A dealer natural ends the round here, which is the whole
      // point: it can only ever take the opening bet.
      if (dealerNatural || playerNatural) {
        return settle(state, message);
      }

      return playHand(state, message);
    }

    async function offerEvenMoney(state, message) {
      const bet = state.hands[0].bet;
      const natural = Math.floor(bet * BJ.NATURAL_RETURN_MULTIPLIER) - bet;
      const description =
        `**You have blackjack and the dealer shows an Ace.**\n`
        + `Take even money for a certain **${money(bet)}**, or play it out: `
        + `**${money(natural)}** if the dealer has no blackjack, **nothing** if they do.`;

      await message.edit({
        embeds: [buildEmbed(state, { description })],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('bj_even_yes')
            .setLabel(`Take ${money(bet)}`).setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('bj_even_no')
            .setLabel('Play it out').setStyle(ButtonStyle.Secondary),
        )],
      });

      const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button, time: TIMEOUT,
      });
      roundCollector = collector;

      collector.on('collect', safe(async btn => {
        if (btn.user.id !== userId) {
          return btn.reply({ content: 'This is not your game.', flags: MessageFlags.Ephemeral });
        }
        await btn.deferUpdate();
        if (btn.customId === 'bj_even_yes') state.hands[0].evenMoney = true;
        collector.stop('chosen');
        return settle(state, message);
      }));

      collector.on('end', async (_c, reason) => {
        if (reason !== 'time') return;
        // A timed-out choice is not a free option: declining is the default,
        // and the hand resolves on its own rather than stranding the stake.
        try { await settle(state, message); } catch { /* message may be gone */ }
      });
    }

    async function playHand(state, message) {
      const hand = state.hands[state.activeIndex];
      const actions = BJ.legalActions(hand, { handCount: state.hands.length, balance });

      if (actions.length === 0) {
        hand.done = true;
        return advance(state, message);
      }

      await message.edit({ embeds: [buildEmbed(state)], components: actionRow(actions) });

      if (roundCollector) roundCollector.stop('superseded');
      const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button, time: TIMEOUT,
      });
      roundCollector = collector;

      collector.on('collect', safe(async btn => {
        if (btn.user.id !== userId) {
          return btn.reply({ content: 'This is not your game.', flags: MessageFlags.Ephemeral });
        }
        await btn.deferUpdate();
        collector.stop('acted');

        const current = state.hands[state.activeIndex];

        if (btn.customId === 'bj_hit') {
          current.cards.push(BJ.drawCard(state.deck));
          if (BJ.handValue(current.cards).total >= 21) current.done = true;
        } else if (btn.customId === 'bj_stand') {
          current.done = true;
        } else if (btn.customId === 'bj_surrender') {
          current.surrendered = true;
          current.done = true;
        } else if (btn.customId === 'bj_double') {
          const after = await adjustBalance(userId, -current.bet);
          if (after === null) {
            await btn.followUp({ content: 'Not enough to double.', flags: MessageFlags.Ephemeral });
            return playHand(state, message);
          }
          balance = after;
          session.wagered += current.bet;
          current.bet *= 2;
          current.doubled = true;
          current.cards.push(BJ.drawCard(state.deck));
          current.done = true;
        } else if (btn.customId === 'bj_split') {
          const after = await adjustBalance(userId, -current.bet);
          if (after === null) {
            await btn.followUp({ content: 'Not enough to split.', flags: MessageFlags.Ephemeral });
            return playHand(state, message);
          }
          balance = after;
          session.wagered += current.bet;
          const aces = current.cards[0].rank === 'A';
          const left = BJ.makeHand(
            [current.cards[0], BJ.drawCard(state.deck)], current.bet,
            { fromSplit: true, splitAces: aces }
          );
          const right = BJ.makeHand(
            [current.cards[1], BJ.drawCard(state.deck)], current.bet,
            { fromSplit: true, splitAces: aces }
          );
          state.hands.splice(state.activeIndex, 1, left, right);
        }

        return advance(state, message);
      }));

      collector.on('end', async (_c, reason) => {
        if (reason !== 'time') return;
        // Standing is the safe default for an abandoned hand: it never adds
        // money to the table and never busts a hand the player might have won.
        try {
          for (const h of state.hands) h.done = true;
          await settle(state, message);
        } catch { /* message may be gone */ }
      });
    }

    /** Moves to the next unfinished hand, or settles when there are none. */
    async function advance(state, message) {
      const next = state.hands.findIndex(h => !h.done);
      if (next === -1) return settle(state, message);
      state.activeIndex = next;
      return playHand(state, message);
    }

    async function settle(state, message) {
      if (state.settled) return;
      state.settled = true;
      if (roundCollector) { roundCollector.stop('settled'); roundCollector = null; }

      const dealerNatural = BJ.isNatural(state.dealerCards);
      // The dealer only draws when a hand can still be beaten. Against nothing
      // but busts and surrenders there is no hand to make.
      const live = state.hands.some(h =>
        !h.surrendered && !h.evenMoney && BJ.handValue(h.cards).total <= 21);
      if (live && !dealerNatural) BJ.playDealer(state.dealerCards, state.deck);

      let returned = 0;
      for (const hand of state.hands) {
        const result = BJ.settleHand(hand, state.dealerCards, dealerNatural);
        hand.outcome = result.outcome;
        hand.returned = result.returned;
        returned += result.returned;
      }

      if (returned > 0) {
        const after = await adjustBalance(userId, returned);
        if (after !== null) balance = after;
      }
      session.returned += returned;

      const staked = state.hands.reduce((sum, h) => sum + h.bet, 0);
      const net = returned - staked;
      const description = `**${signedMoney(net)}** on this hand.`;

      logger.info('Blackjack round settled', {
        userId, staked, returned, net, hands: state.hands.length,
        outcomes: state.hands.map(h => h.outcome),
      });
      // Best-effort: a statistics write is never worth failing a payout over.
      recordGameResult(userId, 'blackjack', { wagered: staked, returned }).catch(() => {});
      // Not awaited on purpose: a payout must never wait on a language model.
      considerHeckle({
        channel: interaction.channel,
        userId,
        username: interaction.user.username,
        game: 'blackjack',
        wagered: staked,
        returned,
      });

      const lastBet = state.hands[0].doubled ? state.hands[0].bet / 2 : state.hands[0].bet;
      await message.edit({
        embeds: [buildEmbed(state, { reveal: true, description })],
        components: rebetRow(lastBet),
      });
      return handleRebet(message, lastBet);
    }

    // ── Between rounds ──────────────────────────────────────────────────────

    function handleRebet(message, lastBet) {
      if (endCollector) endCollector.stop('superseded');
      const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button, time: TIMEOUT,
      });
      endCollector = collector;

      collector.on('collect', safe(async btn => {
        if (btn.user.id !== userId) {
          return btn.reply({ content: 'This is not your game.', flags: MessageFlags.Ephemeral });
        }
        await btn.deferUpdate();

        if (btn.customId === 'bj_exit') {
          collector.stop('cashed_out');
          const net = session.returned - session.wagered;
          const summary = new EmbedBuilder()
            .setTitle('🎲 Blackjack')
            .setDescription(`Seat closed. **${signedMoney(net)}** across the session.`)
            .addFields({ name: 'Balance', value: money(balance), inline: true });
          logger.info('Blackjack: player cashed out', { userId, net, balance });
          return message.edit({ embeds: [summary], components: [] });
        }

        const next = btn.customId === 'bj_again_double' ? lastBet * 2
          : btn.customId === 'bj_again_half' ? Math.max(1, Math.floor(lastBet / 2))
            : lastBet;

        const deducted = await deductBet(userId, next);
        if (!deducted.success) {
          return btn.followUp({ content: `💰 ${deducted.error}`, flags: MessageFlags.Ephemeral });
        }
        balance = deducted.newBalance;
        session.wagered += next;
        collector.stop('next_round');
        logger.info('Blackjack: next round', { userId, bet: next });
        return runRound(next);
      }));

      collector.on('end', async (_c, reason) => {
        if (reason !== 'time') return;
        try { await message.edit({ components: [] }); } catch { /* message may be gone */ }
      });
    }

    await runRound(openingBet);
  },
};
