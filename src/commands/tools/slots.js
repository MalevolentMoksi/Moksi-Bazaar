// src/commands/tools/slots.js
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getBalance, updateBalance } = require('../../utils/db');
const crypto = require('crypto');

// ─── Symbols ────────────────────────────────────────────────────────────────
const symbols = [
  { emoji: '🍒', name: 'Cherry', weight: 30, payouts: { 2: 2, 3: 20 } },
  { emoji: '🍋', name: 'Lemon', weight: 25, payouts: { 2: 1.5, 3: 10 } },
  { emoji: '🍉', name: 'Watermelon', weight: 20, payouts: { 3: 15 } },
  { emoji: '🍇', name: 'Grapes', weight: 15, payouts: { 3: 12 } },
  { emoji: '🥭', name: 'Mango', weight: 10, payouts: { 3: 8 } },
  { emoji: '💎', name: 'Diamond', weight: 5, payouts: { 3: 100 } },
  { emoji: 'BAR', name: 'Bar', weight: 8, payouts: { 3: 30 } },
];
const wild    = { emoji: '🌟', name: 'Wild',    weight: 5  }; // substitutes
const scatter = { emoji: '🎟️', name: 'Scatter', weight: 5  }; // free spins

const weightedPool = [
  ...symbols.flatMap(s => Array(s.weight).fill(s)),
  ...Array(wild.weight).fill(wild),
  ...Array(scatter.weight).fill(scatter)
];

// 5 paylines (middle, top, bottom, V, inverted V)
const paylines = [
  [[1,0],[1,1],[1,2],[1,3],[1,4]],
  [[0,0],[0,1],[0,2],[0,3],[0,4]],
  [[2,0],[2,1],[2,2],[2,3],[2,4]],
  [[0,0],[1,1],[2,2],[1,3],[0,4]],
  [[2,0],[1,1],[0,2],[1,3],[2,4]],
];

// Progressive jackpot pool
let jackpotPool = 0;

// ─── Helpers ────────────────────────────────────────────────────────────────
function spinReel() {
  return weightedPool[crypto.randomInt(0, weightedPool.length)];
}

function spinGrid() {
  const grid = [];
  for (let r = 0; r < 3; r++) {
    grid[r] = [];
    for (let c = 0; c < 5; c++) {
      grid[r][c] = spinReel();
    }
  }
  return grid;
}

function gridToString(grid) {
  return grid.map(row => row.map(cell => cell.emoji).join(' ')).join('\n');
}

/**
 * Evaluate line wins + diamond jackpot.
 * @param {Array} grid  3×5 array of symbol objects
 * @param {number} totalBet  bet after rake
 * @param {number} lines  how many paylines to use
 * @returns {number} payout amount
 */
function evaluateGrid(grid, totalBet, lines = paylines.length) {
  const betPerLine = totalBet / lines;
  let payout = 0;

  // Check each payline
  for (let i = 0; i < lines; i++) {
    const cells = paylines[i].map(([r,c]) => grid[r][c]);
    let bestLine = 0;

    // For each real symbol, count matches + wilds
    for (const sym of symbols) {
      const count = cells.filter(ch => ch === sym || ch === wild).length;
      if (sym.payouts[count]) {
        bestLine = Math.max(bestLine, sym.payouts[count]);
      }
    }
    payout += betPerLine * bestLine;
  }

  // Diamond jackpot: 5× Diamond on middle line
  const mid = paylines[0].map(([r,c]) => grid[r][c]);
  if (mid.every(ch => ch === symbols.find(s => s.name === 'Diamond'))) {
    payout += jackpotPool;
    jackpotPool = 0;
  }

  return payout;
}

// ─── Command ────────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('slots')
    .setDescription('5-reel slots with wilds, scatters=free-spins, gamble & progressive jackpot')
    .addIntegerOption(opt =>
      opt.setName('amount')
         .setDescription('Your total bet')
         .setRequired(true)
         .setMinValue(1)
    ),

  async execute(interaction) {
    const userId = interaction.user.id;
    const bet    = interaction.options.getInteger('amount');
    const bal    = await getBalance(userId);
    if (bet > bal) {
      return interaction.reply({ content: `❌ You only have $${bal}.`, ephemeral: true });
    }

    // Deduct bet + rake 1% into jackpot
    let newBal = bal - bet;
    const rake = bet * 0.01; 
    jackpotPool += rake;
    const effBet = bet - rake;

    // Simple spin animation (5 quick reels)
    const initialMsg = await interaction.reply({ content: '🎰 Spinning...', fetchReply: true });
    for (let i = 0; i < 5; i++) {
      const tmp = spinGrid();
      await initialMsg.edit({ content: gridToString(tmp) });
      await new Promise(res => setTimeout(res, 300));
    }

    // Final spin
    const finalGrid = spinGrid();
    const face      = gridToString(finalGrid);

    // Check for scatters → free spins
    const allCells     = finalGrid.flat();
    const scattersCount = allCells.filter(c => c === scatter).length;
    if (scattersCount >= 3) {
      const freeSpins = scattersCount * 2;
      let freeWin = 0;

      // Run free spins (no further animation for brevity)
      for (let i = 0; i < freeSpins; i++) {
        const g = spinGrid();
        freeWin += evaluateGrid(g, effBet);
      }
      newBal += freeWin;
      await updateBalance(userId, newBal);

      // Embed for free spins
      const eb = new EmbedBuilder()
        .setTitle('🎟️ Free Spins!')
        .setColor(0x9b59b6)
        .addFields(
          { name: 'Base Result',       value: face,                         inline: false },
          { name: 'Scatters',          value: `${scattersCount} → ${freeSpins} free spins`, inline: false },
          { name: 'Free Spins Winnings', value: `$${freeWin.toFixed(2)}`,  inline: true },
          { name: 'New Balance',        value: `$${newBal.toFixed(2)}`,     inline: true },
          { name: 'Jackpot Pool',       value: `$${jackpotPool.toFixed(2)}`, inline: true }
        );

      // Gamble button on free-spin wins
      if (freeWin > 0) {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('slots_gamble_free')
            .setLabel('🎲 Double or Nothing')
            .setStyle(ButtonStyle.Primary)
        );
        await interaction.followUp({ embeds: [eb], components: [row] });

        const filter = i => i.user.id === userId && i.customId === 'slots_gamble_free';
        const col    = initialMsg.channel.createMessageComponentCollector({ filter, time: 30_000, max: 1 });
        col.on('collect', async btn => {
          const win = crypto.randomInt(0,2) === 1;
          let text;
          if (win) {
            newBal += freeWin;
            text = `✅ You doubled your free spins winnings! New balance: $${newBal.toFixed(2)}`;
          } else {
            newBal -= freeWin;
            text = `🔴 You lost your free spins winnings. New balance: $${newBal.toFixed(2)}`;
          }
          await updateBalance(userId, newBal);
          await btn.update({ content: text, embeds: [], components: [] });
        });
      } else {
        await interaction.followUp({ embeds: [eb] });
      }

      return;
    }

    // No free spins → normal payout
    const win = evaluateGrid(finalGrid, effBet);
    newBal += win;
    await updateBalance(userId, newBal);

    // Standard result embed
    const eb = new EmbedBuilder()
      .setTitle('🎰 Slots Result')
      .setColor(0xF1C40F)
      .addFields(
        { name: 'Grid',      value: face,                      inline: false },
        { name: 'Bet',       value: `$${bet}`,                 inline: true  },
        { name: 'Winnings',  value: `$${win.toFixed(2)}`,      inline: true  },
        { name: 'New Balance', value: `$${newBal.toFixed(2)}`, inline: true  },
        { name: 'Jackpot Pool',value: `$${jackpotPool.toFixed(2)}`           , inline: true }
      );

    // Gamble button on base-game wins
    if (win > 0) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('slots_gamble')
          .setLabel('🎲 Double or Nothing')
          .setStyle(ButtonStyle.Primary)
      );
      await interaction.followUp({ embeds: [eb], components: [row] });

      const filter = i => i.user.id === userId && i.customId === 'slots_gamble';
      const col    = initialMsg.channel.createMessageComponentCollector({ filter, time: 30_000, max: 1 });
      col.on('collect', async btn => {
        const dbl = crypto.randomInt(0,2) === 1;
        let txt;
        if (dbl) {
          newBal += win;
          txt = `✅ You doubled it! New balance: $${newBal.toFixed(2)}`;
        } else {
          newBal -= win;
          txt = `🔴 You lost it. New balance: $${newBal.toFixed(2)}`;
        }
        await updateBalance(userId, newBal);
        await btn.update({ content: txt, embeds: [], components: [] });
      });
    } else {
      await interaction.followUp({ embeds: [eb] });
    }
  }
};
