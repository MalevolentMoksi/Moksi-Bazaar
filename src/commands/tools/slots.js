// src/commands/tools/slots.js
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType
} = require('discord.js');
const { getBalance, updateBalance } = require('../../utils/db');
const crypto = require('crypto');

// -- SYMBOL DEFINITIONS --------------------------------------------------
const baseSymbols = [
  { emoji: '🍒', weight: 30, payouts: { 2: 2, 3: 20 } },
  { emoji: '🍋', weight: 25, payouts: { 2: 1.5, 3: 10 } },
  { emoji: '🍊', weight: 25, payouts: { 2: 1.2, 3: 5 } },
  { emoji: '🔔', weight: 20, payouts: { 3: 25 } },
  { emoji: '💎', weight: 15, payouts: { 3: 50 } },
  { emoji: '7️⃣', weight: 5, payouts: { 3: 100 } }
];
const wildSymbol    = { emoji: '🌟', weight: 5,  payouts: { 3: 50 } };
const scatterSymbol = { emoji: '🎟️', weight: 5, payouts: { 3: 'freespins' } };

// Build weighted pool
const weightedPool = [
  ...baseSymbols,
  wildSymbol,
  scatterSymbol
].flatMap(sym => Array(sym.weight).fill(sym));

function spinOne() {
  return weightedPool[crypto.randomInt(0, weightedPool.length)];
}

async function handleSpin(msg, spinEmbed, bet, userId, balanceAfterBet) {
  // … your existing 3-step animation …

  // — Step 4) Final spin & compute winnings —
  const finalGrid = Array(9).fill().map(() => spinOne());
  const emojis    = finalGrid.map(s => s.emoji);
  const displayGrid =
    `${emojis[0]} ${emojis[1]} ${emojis[2]}\n` +
    `${emojis[3]} ${emojis[4]} ${emojis[5]}\n` +
    `${emojis[6]} ${emojis[7]} ${emojis[8]}`;

  const scatterCount = finalGrid.filter(s => s.emoji === scatterSymbol.emoji).length;
  const freeSpins    = scatterCount >= 3 ? 5 : 0;

  const payline   = finalGrid.slice(3, 6);
  const wildCount = payline.filter(s => s.emoji === wildSymbol.emoji).length;
  const baseCount = payline
    .filter(s => s.emoji !== wildSymbol.emoji)
    .reduce((a, s) => (a[s.emoji] = (a[s.emoji] || 0) + 1, a), {});

  // find best multiplier
  let lineMultiplier = 0;
  for (const sym of [...baseSymbols, wildSymbol]) {
    const cnt = (baseCount[sym.emoji] || 0) + wildCount;
    const p   = sym.payouts[cnt];
    if (p && p !== 'freespins') lineMultiplier = Math.max(lineMultiplier, p);
  }

  // --- ROUND ALL WIN AMOUNTS TO INTEGERS ---
  let lineWin = Math.round(bet * lineMultiplier);
  let freeWin = 0;
  if (freeSpins) {
    for (let i = 0; i < freeSpins; i++) {
      const mini = [spinOne(), spinOne(), spinOne()];
      const wc   = mini.filter(s => s.emoji === wildSymbol.emoji).length;
      const bc   = mini
        .filter(s => s.emoji !== wildSymbol.emoji)
        .reduce((a, s) => (a[s.emoji] = (a[s.emoji] || 0) + 1, a), {});
      let m = 0;
      for (const sym of [...baseSymbols, wildSymbol]) {
        const cnt = (bc[sym.emoji] || 0) + wc;
        const p   = sym.payouts[cnt];
        if (p && p !== 'freespins') m = Math.max(m, p);
      }
      freeWin += Math.round(bet * m);
    }
  }

  const payout = Math.round(lineWin + freeWin);
  let collected = false;

  // — Step 6) Build result embed + buttons —
  const resultEmbed = new EmbedBuilder()
    .setTitle('🎰 Slot Results')
    .setColor(lineMultiplier > 1 ? 0x2ECC71 : 0xE74C3C)
    .addFields(
      { name: 'Grid',        value: displayGrid, inline: false },
      { name: 'Bet',         value: `$${bet}`,     inline: true },
      { name: 'Payline',     value: lineMultiplier > 0
          ? `${lineMultiplier}× → $${lineWin}`
          : 'No match',     inline: true },
      { name: 'Free Spins',  value: freeSpins
          ? `${freeSpins} spins → $${freeWin}`
          : 'None',         inline: true },
      { name: '\u200B',      value: payout > 0
          ? `Net win **$${payout}**\n\n▶️ **Double-Up?** Or play again.`
          : `You lost $${bet}.\nBetter luck next time!\n\n▶️ Play again?`,
        inline: false }
    );

  // … the rest of your button logic remains unchanged … 
  // but when you update the embed on Collect/Double-Up, use:
  //    resultEmbed.data.fields[4].value = payout > 0
  //      ? `💰 You collected **$${payout}**.`
  //      : '💥 You busted! You get nothing.';
  // and your footer/new balance can stay as:
  //    resultEmbed.setFooter({ text: `New balance: $${finalBalance.toFixed(2)}` });

  // … collector, play again, double-up logic …
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('slots')
    .setDescription('🎰 Spin a 3×3 slot machine')
    .addIntegerOption(opt =>
      opt.setName('amount')
         .setDescription('How much to bet')
         .setRequired(true)
         .setMinValue(1)
    ),

  async execute(interaction) {
    // … unchanged …
    await handleSpin(msg, spinEmbed, bet, userId, balanceAfterBet);
  }
};
