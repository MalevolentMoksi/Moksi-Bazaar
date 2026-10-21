// src/commands/tools/slots.js
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
const { ackPublic, replyPublic, replyPrivate } = require('../../utils/interactionAck');
const { ui, retireControls } = require('../../utils/ui/panel');
const { money, signedMoney, parseAmount, AMOUNT_HINT } = require('../../utils/money');
const { EMBED_COLORS, GAME_CONFIG } = require('../../utils/constants');
const crypto = require('crypto');

// -- SYMBOL DEFINITIONS --------------------------------------------------
//
// The pair payouts are where the money went. A pair counts anywhere on the
// payline, so pairs land on roughly a third of all spins, and at 5x / 3x / 2x
// the machine handed back about $1.29 for every dollar fed into it. These are
// tuned to 95% (pinned by tests/casinoOdds.test.js): it still pays on the same
// third of spins, just less each time. Triples, wilds, scatters and Double-Up
// are as they were.
const baseSymbols = [
  { emoji: '🍒', weight: 15, payouts: { 2: 3, 3: 10 } },
  { emoji: '🍋', weight: 20, payouts: { 2: 1.75, 3: 5 } },
  { emoji: '🍊', weight: 30, payouts: { 2: 1.5, 3: 2.5 } },
  { emoji: '🔔', weight: 10, payouts: { 3: 20 } },
  { emoji: '💎', weight: 5, payouts: { 3: 100 } },
  { emoji: '7️⃣', weight: 8,  payouts: { 3: 75 } }
];
const wildSymbol    = { emoji: '🌟', weight: 4, payouts: { 3: 50 } };
const scatterSymbol = { emoji: '🎟️', weight: 5, payouts: {} };
const loseSymbol    = { emoji: '⬛', weight: 20, payouts: {} };

const ALL_SYMBOLS = [...baseSymbols, wildSymbol, scatterSymbol, loseSymbol];

// build the weighted pool
const weightedPool = ALL_SYMBOLS.flatMap(sym => Array(sym.weight).fill(sym));

const TIMEOUT = GAME_CONFIG.SLOTS.COLLECTOR_TIMEOUT;

function spinOne() {
  return weightedPool[crypto.randomInt(0, weightedPool.length)];
}

/** The best multiplier three symbols on a line pay, wilds standing in for anything. */
function lineMultiplier(line) {
  const wildCount = line.filter(s => s.emoji === wildSymbol.emoji).length;
  const baseCount = line
    .filter(s => s.emoji !== wildSymbol.emoji)
    .reduce((a, s) => (a[s.emoji] = (a[s.emoji] || 0) + 1, a), {});
  let best = 0;
  for (const sym of [...baseSymbols, wildSymbol]) {
    const p = sym.payouts[(baseCount[sym.emoji] || 0) + wildCount];
    if (p) best = Math.max(best, p);
  }
  return best;
}

function drawGrid(emojis) {
  return `${emojis[0]} ${emojis[1]} ${emojis[2]}\n`
    + `${emojis[3]} ${emojis[4]} ${emojis[5]}\n`
    + `${emojis[6]} ${emojis[7]} ${emojis[8]}`;
}

async function handleSpin(interaction, msg, spinEmbed, bet, balanceAfterBet, stake) {
  const userId = interaction.user.id;

  // A few frames of reels going round before the result lands.
  for (let i = 0; i < 3; i++) {
    spinEmbed.data.fields[2].value = drawGrid(Array(9).fill().map(() => spinOne().emoji));
    spinEmbed.setFooter({ text: `Balance ${money(balanceAfterBet)}` });
    await msg.edit(ui(spinEmbed, [], { like: msg }));
    await new Promise(r => setTimeout(r, 400));
  }

  const finalGrid = Array(9).fill().map(() => spinOne());
  const displayGrid = drawGrid(finalGrid.map(s => s.emoji));

  const scatterCount = finalGrid.filter(s => s.emoji === scatterSymbol.emoji).length;
  const freeSpins = Math.floor(scatterCount / 2); // two scatters = one free spin

  const multiplier = lineMultiplier(finalGrid.slice(3, 6));
  const lineWin = Math.round(bet * multiplier);
  let freeWin = 0;
  for (let i = 0; i < freeSpins; i++) {
    freeWin += Math.round(bet * lineMultiplier([spinOne(), spinOne(), spinOne()]));
  }

  const payout = lineWin + freeWin;
  let collected = false;
  let spinLock = false;

  // Winnings are banked the moment the spin resolves. Double-Up then wagers
  // the already-credited amount; Collect and a timeout leave the balance alone,
  // so walking away can never lose a win.
  let balanceAfterSpin = balanceAfterBet;
  if (payout > 0) {
    balanceAfterSpin = await adjustBalance(userId, payout);
  }
  recordGameResult(userId, 'slots', { wagered: bet, returned: payout }).catch(() => {});
  // The spin has been paid out either way, so the wager is no longer owed
  // back. Everything below stakes money that is already banked.
  await stake?.settle();
  // Not awaited: a payout never waits on a language model.
  considerHeckle({
    channel: interaction.channel,
    userId,
    username: interaction.user.username,
    game: 'slots',
    wagered: bet,
    returned: payout,
  });

  const resultEmbed = new EmbedBuilder()
    .setTitle('🎰 Slots')
    .setColor(payout > 0 ? EMBED_COLORS.WIN : EMBED_COLORS.LOSE)
    .addFields(
      { name: 'Grid',       value: displayGrid, inline: false },
      { name: 'Bet',        value: money(bet),  inline: true },
      { name: 'Payline',    value: multiplier > 0
          ? `${multiplier}× → ${money(lineWin)}`
          : 'No match',    inline: true },
      { name: 'Free Spins', value: freeSpins > 0
          ? `${freeSpins} spin${freeSpins > 1 ? 's' : ''} → ${money(freeWin)}`
          : 'None',        inline: true },
      { name: '​',     value: payout > 0
          ? `Paid **${money(payout)}** (${signedMoney(payout - bet)}). Double it on a coin flip, or keep it.`
          : `Nothing. ${money(bet)} gone.`,
        inline: false }
    )
    .setFooter({ text: `Balance ${money(balanceAfterSpin)}` });

  const row = new ActionRowBuilder();
  if (payout > 0) {
    row.addComponents(
      new ButtonBuilder().setCustomId('double').setLabel(`Double-Up (${money(payout)})`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('collect').setLabel('Collect').setStyle(ButtonStyle.Primary)
    );
  } else {
    row.addComponents(
      new ButtonBuilder().setCustomId('play_again').setLabel(`Spin again (${money(bet)})`).setStyle(ButtonStyle.Success)
    );
  }

  await msg.edit(ui(resultEmbed, [row], { like: msg }));

  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: TIMEOUT,
  });

  collector.on('collect', async i => {
    if (i.user.id !== userId) {
      return i.reply({ content: notYourTable('slots'), flags: MessageFlags.Ephemeral });
    }
    await i.deferUpdate();

    if (i.customId === 'play_again') {
      if (spinLock) return;
      spinLock = true;
      const again = await deductBet(userId, bet, { game: 'slots' });
      if (!again.success) {
        spinLock = false;
        return i.followUp({ content: again.error, flags: MessageFlags.Ephemeral });
      }
      collector.stop('superseded');
      await msg.edit(retireControls(msg));
      return handleSpin(interaction, msg, spinEmbed, bet, again.newBalance, again.stake);
    }

    if (collected) return;
    if (!['double', 'collect'].includes(i.customId)) return;
    collected = true;

    let finalPayout = payout;
    let finalBal = balanceAfterSpin;
    if (i.customId === 'double') {
      // Stake the banked winnings; null means they were spent elsewhere
      const afterStake = await adjustBalance(userId, -payout);
      if (afterStake === null) {
        collected = false;
        return i.followUp({ content: 'Those winnings are already spent, so there is nothing to double.', flags: MessageFlags.Ephemeral });
      }
      finalPayout = crypto.randomInt(0, 2) === 1 ? payout * 2 : 0;
      finalBal = finalPayout > 0
        ? await adjustBalance(userId, finalPayout)
        : afterStake;
      // A separate wager on its own terms: the winnings were already banked,
      // and this stakes them again on a coin flip.
      recordGameResult(userId, 'slots', { wagered: payout, returned: finalPayout }).catch(() => {});
    }

    resultEmbed.data.fields[4].value = i.customId === 'double'
      ? (finalPayout > 0
        ? `🎉 Doubled to **${money(finalPayout)}**.`
        : `💥 Lost the flip. The ${money(payout)} went with it.`)
      : `💰 Collected **${money(finalPayout)}**.`;
    resultEmbed
      .setColor(finalPayout > 0 ? EMBED_COLORS.WIN : EMBED_COLORS.LOSE)
      .setFooter({ text: `Balance ${money(finalBal)}` });

    const againRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('play_again').setLabel(`Spin again (${money(bet)})`).setStyle(ButtonStyle.Success)
    );
    await msg.edit(ui(resultEmbed, [againRow], { like: msg }));
  });

  collector.on('end', async (_, reason) => {
    if (reason !== 'time') return;
    try { await msg.edit(retireControls(msg)); } catch { /* message may be gone */ }
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('slots')
    .setDescription('Spin a 3×3 slot machine')
    .addStringOption(opt =>
      opt.setName('bet')
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

    // Claim the interaction before the money moves: a slow query used to mean
    // the bet was taken and the reply arrived too late to show the spin.
    await ackPublic(interaction);

    // Through deductBet like every other game, so the house limits set in
    // /casino config apply here too. Slots used to place its stake directly
    // and was the one game a max bet did not reach.
    const bet = await resolveBet(userId, spec);
    const opening = await deductBet(userId, bet, { game: 'slots' });
    if (!opening.success) {
      return replyPrivate(interaction, opening.error);
    }

    const spinEmbed = new EmbedBuilder()
      .setTitle('🎰 Slots')
      .setColor(EMBED_COLORS.INFO)
      .addFields(
        { name: 'Bet',     value: money(bet), inline: true },
        { name: 'Payline', value: 'the middle row', inline: true },
        { name: '​',  value: 'Spinning…', inline: false }
      );

    const msg = await replyPublic(interaction, { ...ui(spinEmbed, [], { scope: 'casino' }), fetchReply: true });
    await handleSpin(interaction, msg, spinEmbed, bet, opening.newBalance, opening.stake);
  },

  // Exported for tests/casinoOdds.test.js, which prices the machine exactly.
  _odds: { ALL_SYMBOLS, scatterSymbol, lineMultiplier },
};
