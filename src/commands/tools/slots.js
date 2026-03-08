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
const { getBalance, updateBalance } = require('../../utils/db');
const crypto = require('crypto');

// -- SYMBOL DEFINITIONS --------------------------------------------------
const baseSymbols = [
  { emoji: '🍒', weight: 15, payouts: { 2: 5, 3: 10 } },
  { emoji: '🍋', weight: 20, payouts: { 2: 3, 3: 5 } },
  { emoji: '🍊', weight: 30, payouts: { 2: 2, 3: 2.5 } },
  { emoji: '🔔', weight: 10, payouts: { 3: 20 } },
  { emoji: '💎', weight: 5, payouts: { 3: 100 } },
  { emoji: '7️⃣', weight: 8,  payouts: { 3: 75 } }
];
const wildSymbol    = { emoji: '🌟', weight: 4, payouts: { 3: 50 } };
const scatterSymbol = { emoji: '🎟️', weight: 5, payouts: {} };
const loseSymbol    = { emoji: '⬛', weight: 20, payouts: {} };

// build the weighted pool
const weightedPool = [
  ...baseSymbols,
  wildSymbol,
  scatterSymbol,
  loseSymbol    // ← added lose symbol to pool
].flatMap(sym => Array(sym.weight).fill(sym));

function spinOne() {
  return weightedPool[crypto.randomInt(0, weightedPool.length)];
}

async function handleSpin(msg, spinEmbed, bet, userId, balanceAfterBet) {
  // — Step 3) 3× animation (omitted here for brevity) —
  for (let i = 0; i < 3; i++) {
    const preview = Array(9).fill().map(() => spinOne().emoji);
    const grid =
      `${preview[0]} ${preview[1]} ${preview[2]}\n` +
      `${preview[3]} ${preview[4]} ${preview[5]}\n` +
      `${preview[6]} ${preview[7]} ${preview[8]}`;
    spinEmbed.data.fields[2].value = grid;
    spinEmbed.setFooter({ text: `Balance: $${balanceAfterBet}` });
    await msg.edit({ embeds: [spinEmbed], components: [] });
    await new Promise(r => setTimeout(r, 400));
  }

  // — Step 4) Final spin & compute winnings —
  const finalGrid = Array(9).fill().map(() => spinOne());
  const emojis    = finalGrid.map(s => s.emoji);
  const displayGrid =
    `${emojis[0]} ${emojis[1]} ${emojis[2]}\n` +
    `${emojis[3]} ${emojis[4]} ${emojis[5]}\n` +
    `${emojis[6]} ${emojis[7]} ${emojis[8]}`;

  const scatterCount = finalGrid.filter(s => s.emoji === scatterSymbol.emoji).length;
  const freeSpins    = Math.floor(scatterCount / 2);  // ← two scatters = one free spin

  const payline   = finalGrid.slice(3, 6);
  const wildCount = payline.filter(s => s.emoji === wildSymbol.emoji).length;
  const baseCount = payline
    .filter(s => s.emoji !== wildSymbol.emoji)
    .reduce((a, s) => (a[s.emoji] = (a[s.emoji] || 0) + 1, a), {});

  let lineMultiplier = 0;
  for (const sym of [...baseSymbols, wildSymbol]) {
    const cnt = (baseCount[sym.emoji] || 0) + wildCount;
    const p   = sym.payouts[cnt];
    if (p && p !== 'freespins') lineMultiplier = Math.max(lineMultiplier, p);
  }

  // — Round all wins to integers —
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
        const cnt2 = (bc[sym.emoji] || 0) + wc;
        const p    = sym.payouts[cnt2];
        if (p && p !== 'freespins') m = Math.max(m, p);
      }
      freeWin += Math.round(bet * m);
    }
  }

  const payout = Math.round(lineWin + freeWin);
  let collected = false;
  let spinLock = false;

  // — Step 6) Build result embed & buttons —
  const resultEmbed = new EmbedBuilder()
    .setTitle('🎰 Slot Results')
    .setColor(lineMultiplier > 1 ? 0x2ECC71 : 0xE74C3C)
    .addFields(
      { name: 'Grid',       value: displayGrid, inline: false },
      { name: 'Bet',        value: `$${bet}`,    inline: true },
      { name: 'Payline',    value: lineMultiplier > 0
          ? `${lineMultiplier}× → $${lineWin}`
          : 'No match',    inline: true },
      { name: 'Free Spins', value: freeSpins > 0
          ? `${freeSpins} spin${freeSpins>1?'s':''} → $${freeWin}`
          : 'None',        inline: true },
      { name: '\u200B',     value: payout > 0
          ? `Net win **$${payout}**\n\n▶️ **Double-Up?** Or play again.`
          : `You lost $${bet}.\nBetter luck next time!\n\n▶️ Play again?`,
        inline: false }
    );

  const row = new ActionRowBuilder();
  if (payout > 0) {
    row.addComponents(
      new ButtonBuilder().setCustomId('double').setLabel('Double-Up').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('collect').setLabel('Collect').setStyle(ButtonStyle.Primary)
    );
  } else {
    row.addComponents(
      new ButtonBuilder().setCustomId('play_again').setLabel('Play Again').setStyle(ButtonStyle.Success)
    );
  }

  await msg.edit({ embeds: [resultEmbed], components: [row] });

  // — Step 7) Collector for Double/Collect/Play Again —
  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 20000
  });

  collector.on('collect', async i => {
    if (i.user.id !== userId) {
      return i.reply({ content: '❌ Not your game!', flags: MessageFlags.Ephemeral});
    }
    await i.deferUpdate();

    if (i.customId === 'play_again') {
      if (spinLock) return;
      spinLock = true;
      collector.stop();
      const currentBal = await getBalance(userId);
      if (currentBal < bet) {
        return i.followUp({ content: `❌ You need $${bet} to play again.`, flags: MessageFlags.Ephemeral});
      }
      const newBal = currentBal - bet;
      await updateBalance(userId, newBal);
      for (const btn of row.components) btn.setDisabled(true);
      await msg.edit({ components: [row] });
      return handleSpin(msg, spinEmbed, bet, userId, newBal);
    }

    if (collected && i.customId !== 'play_again') return;
    if (['double','collect'].includes(i.customId)) collected = true;

    let finalPayout = payout;
    if (i.customId === 'double') {
      finalPayout = crypto.randomInt(0, 2) === 1 ? payout * 2 : 0;
    }
    const finalBal = balanceAfterBet + finalPayout;
    await updateBalance(userId, finalBal);

    resultEmbed.data.fields[4].value = finalPayout > 0
      ? (i.customId === 'double'
        ? `🎉 You ${finalPayout > lineWin+freeWin ? 'doubled' : 'busted'} to **$${finalPayout}**!`
        : `💰 You collected **$${finalPayout}**.`)
      : '💥 You busted! You get nothing.';
    resultEmbed.setFooter({ text: `New balance: $${finalBal}` });

    const againRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('play_again').setLabel('Play Again').setStyle(ButtonStyle.Success)
    );
    await msg.edit({ embeds: [resultEmbed], components: [againRow] });
  });

  collector.on('end', async (_, reason) => {
    if (reason !== 'time') return;
    try { await msg.edit({ components: [] }); } catch {}
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
    const bet    = interaction.options.getInteger('amount');

    const balance = await getBalance(userId);
    if (bet > balance) {
      return interaction.reply({ content: `❌ You only have $${balance}.`, flags: MessageFlags.Ephemeral});
    }

    const balanceAfterBet = balance - bet;
    await updateBalance(userId, balanceAfterBet);

    const spinEmbed = new EmbedBuilder()
      .setTitle('🎰 Spinning the Reels...')
      .setColor(0xF1C40F)
      .addFields(
        { name: 'Bet',     value: `$${bet}`,     inline: true },
        { name: 'Payline', value: '― • ― • ―\n(middle row)', inline: true },
        { name: '\u200B',   value: 'Please wait…', inline: false }
      );

    // define msg here so handleSpin() can use it
    const msg = await interaction.reply({ embeds: [spinEmbed], fetchReply: true });
    await handleSpin(msg, spinEmbed, bet, userId, balanceAfterBet);
  }
};
