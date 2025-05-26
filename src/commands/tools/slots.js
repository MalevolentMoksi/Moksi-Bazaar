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
// emoji, relative weight for the pool, and payouts: count→multiplier
const baseSymbols = [
  { emoji: '🍒', weight: 30, payouts: { 2: 2, 3: 20 } },
  { emoji: '🍋', weight: 25, payouts: { 2: 1.5, 3: 10 } },
  { emoji: '🍊', weight: 25, payouts: { 2: 1.2, 3: 5 } },
  { emoji: '🔔', weight: 20, payouts: { 3: 25 } },
  { emoji: '💎', weight: 15, payouts: { 3: 50 } },
  { emoji: '7️⃣', weight: 5, payouts: { 3: 100 } }
];
const wildSymbol = { emoji: '🌟', weight: 5, payouts: { 3: 50 } };          // substitutes any payline symbol
const scatterSymbol = { emoji: '🎟️', weight: 5, payouts: { 3: 'freespins' } }; // 3 anywhere → free spins

// Build weighted pool
const weightedPool = [
  ...baseSymbols,
  wildSymbol,
  scatterSymbol
].flatMap(sym => Array(sym.weight).fill(sym));

// Draw one random entry
function spinOne() {
  return weightedPool[crypto.randomInt(0, weightedPool.length)];
}

/**
 * Performs the 3-step animation, final spin, evaluation,
 * button display, and component collector.  
 * On “Double” / “Collect” it writes your final balance.
 * On “Play Again” it deducts the bet again and **recurses**.
 */
async function handleSpin(msg, spinEmbed, bet, userId, balanceAfterBet) {
  // — Step 3) 3× animation —
  for (let i = 0; i < 3; i++) {
    const preview = Array(9).fill().map(() => spinOne().emoji);
    const grid =
      `${preview[0]} ${preview[1]} ${preview[2]}\n` +
      `${preview[3]} ${preview[4]} ${preview[5]}\n` +
      `${preview[6]} ${preview[7]} ${preview[8]}`;
    spinEmbed.data.fields[2].value = grid;
    // show the *potential* new balance immediately
    spinEmbed.setFooter({
      text: `Balance: $${balanceAfterBet.toFixed(2)}`
    });

    await msg.edit({ embeds: [spinEmbed] });
    await new Promise(r => setTimeout(r, 400));
  }

  // — Step 4) Final spin & compute winnings —
  const finalGrid = Array(9).fill().map(() => spinOne());
  const emojis = finalGrid.map(s => s.emoji);
  const displayGrid =
    `${emojis[0]} ${emojis[1]} ${emojis[2]}\n` +
    `${emojis[3]} ${emojis[4]} ${emojis[5]}\n` +
    `${emojis[6]} ${emojis[7]} ${emojis[8]}`;

  // free spins
  const scatterCount = finalGrid.filter(s => s.emoji === scatterSymbol.emoji).length;
  const freeSpins = scatterCount >= 3 ? 5 : 0;

  // middle payline [3,4,5]
  const payline = finalGrid.slice(3, 6);
  const wildCount = payline.filter(s => s.emoji === wildSymbol.emoji).length;
  const baseCount = payline
    .filter(s => s.emoji !== wildSymbol.emoji)
    .reduce((a, s) => (a[s.emoji] = (a[s.emoji] || 0) + 1, a), {});

  // find best multiplier
  let lineMultiplier = 0;
  for (const sym of [...baseSymbols, wildSymbol]) {
    const cnt = (baseCount[sym.emoji] || 0) + wildCount;
    const p = sym.payouts[cnt];
    if (p && p !== 'freespins') lineMultiplier = Math.max(lineMultiplier, p);
  }

  const lineWin = bet * lineMultiplier;
  let freeWin = 0;
  if (freeSpins) {
    for (let i = 0; i < freeSpins; i++) {
      const mini = [spinOne(), spinOne(), spinOne()];
      const wc = mini.filter(s => s.emoji === wildSymbol.emoji).length;
      const bc = mini
        .filter(s => s.emoji !== wildSymbol.emoji)
        .reduce((a, s) => (a[s.emoji] = (a[s.emoji] || 0) + 1, a), {});
      let m = 0;
      for (const sym of [...baseSymbols, wildSymbol]) {
        const cnt = (bc[sym.emoji] || 0) + wc;
        const p = sym.payouts[cnt];
        if (p && p !== 'freespins') m = Math.max(m, p);
      }
      freeWin += bet * m;
    }
  }

  let payout = lineWin + freeWin;
  let collected = false;

  // — Step 6) Build result embed + buttons —
  const resultEmbed = new EmbedBuilder()
    .setTitle('🎰 Slot Results')
    .setColor(lineMultiplier > 1 ? 0x2ECC71 : 0xE74C3C)
    .addFields(
      { name: 'Grid', value: displayGrid, inline: false },
      { name: 'Bet', value: `$${bet}`, inline: true },
      {
        name: 'Payline', value: lineMultiplier > 0
          ? `${lineMultiplier}× → $${lineWin.toFixed(2)}`
          : 'No match', inline: true
      },
      {
        name: 'Free Spins', value: freeSpins
          ? `${freeSpins} spins → $${freeWin.toFixed(2)}`
          : 'None', inline: true
      },
      {
        name: '\u200B', value: payout > 0
          ? `Net win **$${payout.toFixed(2)}**\n\n▶️ **Double-Up?** Or play again.`
          : `You lost $${bet}.\nBetter luck next time!\n\n▶️ Play again?`,
        inline: false
      }
    );

  // always add “Play Again”
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('play_again')
        .setLabel('Play Again')
        .setStyle(ButtonStyle.Success)
    );

  // only if you have a win do we add double/collect
  if (payout > 0) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('double')
        .setLabel('Double-Up')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('collect')
        .setLabel('Collect')
        .setStyle(ButtonStyle.Primary)
    );
  }

  await msg.edit({ embeds: [resultEmbed], components: [row] });

  // — Step 7) Collector for all three buttons —
  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 20000
  });

  collector.on('collect', async i => {
    if (i.user.id !== userId) {
      return i.reply({ content: '❌ Not your game!', ephemeral: true });
    }
    if (collected) return;  // guard double-handles
    collected = true;
    collector.stop();

    // ── PLAY AGAIN ──
    if (i.customId === 'play_again') {
      // re-check balance
      const currentBal = await getBalance(userId);
      if (currentBal < bet) {
        return i.reply({ content: `❌ You need $${bet} to play again, you have $${currentBal}.`, ephemeral: true });
      }
      // deduct again
      const newBalAfterBet = currentBal - bet;
      await updateBalance(userId, newBalAfterBet);

      // clear buttons while spinning
      row.components.forEach(b => b.setDisabled(true));
      await i.update({ components: [row] });

      // recurse into another spin
      return handleSpin(msg, spinEmbed, bet, userId, newBalAfterBet);
    }

    // ── DOUBLE-UP or COLLECT ──
    if (i.customId === 'double') {
      // 50/50 chance: randomInt(0,2) yields 0 or 1
      if (crypto.randomInt(0, 2) === 1) {
        payout *= 2;
      } else {
        payout = 0;
      }
    }
    // compute & write final balance
    const finalBalance = balanceAfterBet + payout;
    await updateBalance(userId, finalBalance);

    // update embed text
    resultEmbed.data.fields[4].value = payout > 0
      ? (i.customId === 'double'
        ? `🎉 You ${payout > lineWin + freeWin ? 'doubled' : 'busted'} to **$${payout.toFixed(2)}**!`
        : `💰 You collected **$${payout.toFixed(2)}**.`)
      : '💥 You busted! You get nothing.';

    resultEmbed.setFooter({ text: `New balance: $${finalBalance.toFixed(2)}` });
    // disable all buttons
    row.components.forEach(b => b.setDisabled(true));
    await i.update({ embeds: [resultEmbed], components: [row] });
  });
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
    const userId = interaction.user.id;
    const bet = interaction.options.getInteger('amount');

    // 1) Deduct the bet immediately
    const balance = await getBalance(userId);
    if (bet > balance) {
      return interaction.reply({ content: `❌ You only have $${balance}.`, ephemeral: true });
    }
    const balanceAfterBet = balance - bet;
    await updateBalance(userId, balanceAfterBet);

    // 2) Send the initial “spinning…” embed
    const spinEmbed = new EmbedBuilder()
      .setTitle('🎰 Spinning the Reels...')
      .setColor(0xF1C40F)
      .addFields(
        { name: 'Bet', value: `$${bet}`, inline: true },
        { name: 'Payline', value: '― • ― • ―\n(middle row)', inline: true },
        { name: '\u200B', value: 'Please wait…', inline: false }
      );

    const msg = await interaction.reply({ embeds: [spinEmbed], fetchReply: true });
    // now hand off to our helper
    await handleSpin(msg, spinEmbed, bet, userId, balanceAfterBet);
  }
};
