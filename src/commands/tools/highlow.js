// src/commands/tools/highlow.js
/**
 * High-Low, priced.
 *
 * It used to pay a flat 2x whatever card was showing, which made it the best
 * investment in the server: on a 3, "higher" wins 44 times in 51, and simply
 * picking the obvious side handed back $1.51 for every dollar staked. Now each
 * button carries its own price, set from the cards actually left in the deck
 * so that either choice returns 97% on average. The obvious side pays a
 * little, the long shot pays a lot, and the odds are written on the button.
 *
 * The face-up card is never a 2 or an Ace. On those the near-certain side
 * would have to pay under 1x to hold the edge, a "win" that loses money, and
 * the other side cannot win at all. Opening from 3 to King keeps every price
 * above 1x (the lowest is x1.05) and both buttons live, without touching the
 * rule people already know: a tie hands the bet back.
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
const { deductBet, resolveBet, notYourTable } = require('../../utils/gameHelpers');
const { considerHeckle } = require('../../utils/casinoHeckle');
const { replyPrivate } = require('../../utils/interactionAck');
const { ui, retireControls } = require('../../utils/ui/panel');
const { money, signedMoney, parseAmount, AMOUNT_HINT } = require('../../utils/money');
const { EMBED_COLORS } = require('../../utils/constants');

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

/** What either button returns on average, per dollar staked. */
const RTP = 0.97;

/** Never dealt face up; see the header. The next card can still be anything. */
const NEVER_OPENS = new Set(['2', 'A']);

const TIMEOUT = 60_000;

function createShuffledDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push({ rank: r, suit: s });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardValue(card) {
  return RANKS.indexOf(card.rank) + 2;
}

function format(card) {
  return `${card.rank}${card.suit}`;
}

/** Takes the face-up card out of the deck: the first one that is not a 2 or an Ace. */
function dealOpening(deck) {
  const index = deck.findIndex(card => !NEVER_OPENS.has(card.rank));
  return deck.splice(index, 1)[0];
}

/**
 * The multiplier a correct call pays, for the cards still in the deck.
 *
 * Solves  P(win) * m + P(tie) * 1 = RTP  for m, ties being a refund, then
 * rounds DOWN to the cent shown on the button, so the price on screen is
 * exactly what is paid and never a hair more than the edge allows.
 *
 * @returns {number|null} null when no card left can win this call
 */
function priceFor(winners, ties, remaining) {
  if (winners <= 0) return null;
  const fair = (RTP * remaining - ties) / winners;
  return Math.floor(fair * 100) / 100;
}

/** Both prices for the card showing. */
function pricesFor(current, deck) {
  const value = cardValue(current);
  const higher = deck.filter(c => cardValue(c) > value).length;
  const lower = deck.filter(c => cardValue(c) < value).length;
  const ties = deck.length - higher - lower;
  return {
    higher: priceFor(higher, ties, deck.length),
    lower: priceFor(lower, ties, deck.length),
  };
}

/**
 * What a correct call returns, stake included. At least a dollar of profit:
 * x1.05 on a $5 bet would otherwise round down to a win worth nothing.
 */
function winReturn(bet, multiplier) {
  return Math.max(bet + 1, Math.floor(bet * multiplier));
}

const times = m => `×${m.toFixed(2)}`;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('highlow')
    .setDescription('Guess if the next card is higher or lower; each side shows its payout')
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

    // Deferred before the money moves, and deducted atomically. This used to
    // read the balance, subtract locally and write the absolute result back,
    // which quietly clobbers any other command that touched the same balance
    // in between.
    await interaction.deferReply();

    let bet = await resolveBet(userId, spec);
    const originalBet = bet;
    const opening = await deductBet(userId, bet, { game: 'highlow' });
    if (!opening.success) {
      return replyPrivate(interaction, opening.error);
    }
    let balance = opening.newBalance;
    // The longest a wager sits unresolved anywhere in the casino: the bet is
    // gone the moment the cards appear and the answer waits on a button for a
    // full minute. Settled on every path below, forfeit included.
    let stake = opening.stake;

    await runRound();

    async function runRound() {
      const deck = createShuffledDeck();
      const current = dealOpening(deck);
      const prices = pricesFor(current, deck);

      const promptEmbed = new EmbedBuilder()
        .setTitle('🃏 High-Low')
        .setColor(EMBED_COLORS.INFO)
        .setDescription(
          `**${format(current)}** is showing. Higher or lower?\n`
          + '-# Each side pays what its button says. A tie hands the bet back.'
        )
        .addFields(
          { name: 'Bet', value: money(bet), inline: true },
          { name: 'Balance', value: money(balance), inline: true }
        );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('higher')
          .setLabel(`Higher ${times(prices.higher)}`).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('lower')
          .setLabel(`Lower ${times(prices.lower)}`).setStyle(ButtonStyle.Danger)
      );

      const opened = ui(promptEmbed, [row], { scope: 'casino' });
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(opened);
      } else {
        await interaction.reply(opened);
      }

      const message = await interaction.fetchReply();
      const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: TIMEOUT
      });

      collector.on('end', async (_collected, reason) => {
        if (reason === 'time') {
          // Walking away forfeits the bet, which is the existing rule. Settle
          // it so a later restart does not hand back an abandoned wager.
          await stake?.settle();
          await message.edit(retireControls(message)).catch(() => {});
        }
      });

      collector.on('collect', async btnInt => {
        if (btnInt.user.id !== userId) {
          return btnInt.reply({ content: notYourTable('highlow'), flags: MessageFlags.Ephemeral });
        }
        await btnInt.deferUpdate();
        collector.stop();

        const next = deck.pop();
        const diff = cardValue(next) - cardValue(current);
        const guessHigh = btnInt.customId === 'higher';
        const multiplier = guessHigh ? prices.higher : prices.lower;
        const side = guessHigh ? 'Higher' : 'Lower';

        let resultText;
        let payout = 0;
        if (diff === 0) {
          payout = bet;
          resultText = `**${format(next)}**, a tie. Bet handed back.`;
        } else if ((diff > 0) === guessHigh) {
          payout = winReturn(bet, multiplier);
          resultText = `**${format(next)}**. ${side} at ${times(multiplier)} pays `
            + `**${money(payout)}** (${signedMoney(payout - bet)}).`;
        } else {
          resultText = `**${format(next)}**. ${side} was wrong; ${money(bet)} gone.`;
        }

        if (payout > 0) {
          const after = await adjustBalance(userId, payout);
          if (after !== null) balance = after;
        }
        await stake?.settle();
        recordGameResult(userId, 'highlow', { wagered: bet, returned: payout }).catch(() => {});
        considerHeckle({
          channel: interaction.channel,
          userId,
          username: interaction.user.username,
          game: 'highlow',
          wagered: bet,
          returned: payout,
        });

        const resultEmbed = new EmbedBuilder()
          .setTitle('🃏 High-Low')
          .setColor(payout > bet ? EMBED_COLORS.WIN : payout === 0 ? EMBED_COLORS.LOSE : EMBED_COLORS.NEUTRAL)
          .setDescription(`${format(current)} was showing.\n${resultText}`)
          .addFields(
            { name: 'Bet', value: money(bet), inline: true },
            { name: 'Balance', value: money(balance), inline: true }
          );

        const againRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('play_again')
            .setLabel(`Play again (${money(originalBet)})`).setStyle(ButtonStyle.Primary)
        );

        await interaction.editReply(ui(resultEmbed, [againRow], { like: message }));

        const againCollector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: TIMEOUT });

        againCollector.on('end', async (_collected, reason) => {
          if (reason === 'time') {
            await message.edit(retireControls(message)).catch(() => {});
          }
        });

        againCollector.on('collect', async b => {
          if (b.user.id !== userId) {
            return b.reply({ content: notYourTable('highlow'), flags: MessageFlags.Ephemeral });
          }
          await b.deferUpdate();
          if (b.customId !== 'play_again') return;
          const again = await deductBet(userId, originalBet, { game: 'highlow' });
          if (!again.success) {
            return b.followUp({ content: again.error, flags: MessageFlags.Ephemeral });
          }
          balance = again.newBalance;
          stake = again.stake;
          bet = originalBet;
          againCollector.stop();
          await runRound();
        });
      });
    }
  },

  // Exported for tests/casinoOdds.test.js, which prices every opening card.
  _odds: { RTP, RANKS, NEVER_OPENS, priceFor, pricesFor, winReturn, cardValue },
};
