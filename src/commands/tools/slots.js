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
// Each entry has an emoji, a relative weight for the draw pool,
// and a payouts table mapping “count in payline” → multiplier.
const baseSymbols = [
  { emoji: '🍒', weight: 30, payouts: { 2: 2,   3: 20  } },
  { emoji: '🍋', weight: 25, payouts: { 2: 1.5, 3: 10  } },
  { emoji: '🍊', weight: 25, payouts: { 2: 1.2, 3: 5   } },
  { emoji: '🔔', weight: 20, payouts: {           3: 25  } },
  { emoji: '💎', weight: 15, payouts: {           3: 50  } },
  { emoji: '7️⃣', weight: 5,  payouts: {           3: 100 } }
];

// Wild substitutes any symbol on the payline
const wildSymbol = { emoji: '🌟', weight: 5, payouts: { 3: 50 } };

// Scatter pays nowhere in lines, but 3 anywhere → 5 free spins
const scatterSymbol = { emoji: '🎟️', weight: 5, payouts: { 3: 'freespins' } };

// Build one big weighted pool for drawing 9 symbols
const weightedPool = [
  ...baseSymbols,
  wildSymbol,
  scatterSymbol
].flatMap(sym => Array(sym.weight).fill(sym));

// Draw one random entry
function spinOne() {
  return weightedPool[crypto.randomInt(0, weightedPool.length)];
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

    // 1) FETCH & VERIFY BALANCE
    const originalBalance = await getBalance(userId);
    if (bet > originalBalance) {
      return interaction.reply({
        content: `❌ You only have $${originalBalance} to bet.`,
        ephemeral: true
      });
    }

    // We'll only write back once (after collect/double-up)
    const balanceAfterBet = originalBalance - bet;

    // 2) INITIAL “SPINNING” EMBED
    const spinEmbed = new EmbedBuilder()
      .setTitle('🎰 Spinning the Reels...')
      .setColor(0xF1C40F)
      .addFields(
        { name: 'Bet', value: `$${bet}`, inline: true },
        { name: 'Payline', value: '― • ― • ―\n(middle row)', inline: true },
        { name: '\u200B', value: 'Please wait…', inline: false }
      );

    // Send & grab the Message so we can edit it
    const msg = await interaction.reply({
      embeds: [spinEmbed],
      fetchReply: true
    });

    // 3) SIMPLE 3-STEP “ANIMATION” (replace grid 3 times)
    for (let i = 0; i < 3; i++) {
      // build a random 3×3
      const preview = Array(9).fill(null).map(() => spinOne().emoji);
      const gridText = 
        `${preview[0]} ${preview[1]} ${preview[2]}\n` +
        `${preview[3]} ${preview[4]} ${preview[5]}\n` +
        `${preview[6]} ${preview[7]} ${preview[8]}`;
      spinEmbed.data.fields[2].value = gridText;  // overwrite “Please wait…”
      await msg.edit({ embeds: [spinEmbed] });
      await new Promise(r => setTimeout(r, 500));
    }

    // 4) FINAL SPIN & EVALUATION
    const finalGrid = Array(9).fill(null).map(() => spinOne());
    const emojis = finalGrid.map(s => s.emoji);
    const displayGrid = 
      `${emojis[0]} ${emojis[1]} ${emojis[2]}\n` +
      `${emojis[3]} ${emojis[4]} ${emojis[5]}\n` +
      `${emojis[6]} ${emojis[7]} ${emojis[8]}`;

    // Count scatter **anywhere** for free spins
    const scatterCount = finalGrid.filter(s => s.emoji === scatterSymbol.emoji).length;
    const freeSpins = scatterCount >= 3 ? 5 : 0;

    // Evaluate **middle row payline** at indices [3,4,5]
    const payline = finalGrid.slice(3, 6);
    const wildCount = payline.filter(s => s.emoji === wildSymbol.emoji).length;
    const baseCount = payline
      .filter(s => s.emoji !== wildSymbol.emoji)
      .reduce((acc, s) => {
        acc[s.emoji] = (acc[s.emoji]||0) + 1;
        return acc;
      }, {});

    // Find best multiplier among symbols + wilds
    let lineMultiplier = 0;
    for (const sym of [...baseSymbols, wildSymbol]) {
      const count = (baseCount[sym.emoji]||0) + wildCount;
      const payout = sym.payouts[count];
      if (payout && payout !== 'freespins') {
        lineMultiplier = Math.max(lineMultiplier, payout);
      }
    }

    // Base line win
    const lineWin = bet * lineMultiplier;

    // 5) RUN FREE SPINS AUTOMATICALLY (no extra buttons)
    let freeWin = 0;
    if (freeSpins) {
      for (let i = 0; i < freeSpins; i++) {
        // spin 3 for middle row only
        const mini = [spinOne(), spinOne(), spinOne()];
        const wc = mini.filter(s => s.emoji === wildSymbol.emoji).length;
        const bc = mini
          .filter(s => s.emoji !== wildSymbol.emoji)
          .reduce((a,s)=>(a[s.emoji]=(a[s.emoji]||0)+1,a), {});
        let m = 0;
        for (const sym of [...baseSymbols, wildSymbol]) {
          const cnt = (bc[sym.emoji]||0) + wc;
          const p = sym.payouts[cnt];
          if (p && p !== 'freespins') m = Math.max(m, p);
        }
        freeWin += bet * m;
      }
    }

    // TOTAL potential payout (including stake returns)
    let payout = lineWin + freeWin;
    let collected = false;    // track if user has “collected” yet

    // 6) FINAL EMBED + BUTTONS
    const resultEmbed = new EmbedBuilder()
      .setTitle('🎰 Slot Results')
      .setColor(lineMultiplier>1 ? 0x2ECC71 : 0xE74C3C)
      .addFields(
        { name: 'Grid',     value: displayGrid, inline: false },
        { name: 'Bet',      value: `$${bet}`,           inline: true },
        { name: 'Payline',  value: lineMultiplier>0
            ? `${lineMultiplier}× → $${lineWin.toFixed(2)}`
            : 'No match',         inline: true },
        { name: 'Free Spins',value: freeSpins
            ? `${freeSpins} spins → $${freeWin.toFixed(2)}`
            : 'None',             inline: true },
        { name: '\u200B',   value:
            payout > 0
              ? `Net win **$${payout.toFixed(2)}**\n\n▶️ **Double-Up?** Click below to try doubling (or collect now).`
              : `You lost $${bet}.\nBetter luck next time!`,
          inline: false
        }
      );

    // Only show buttons if there’s something to gamble
    const row = new ActionRowBuilder();
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

    // Edit the original “spinning” message
    await msg.edit({ embeds: [resultEmbed], components: row.components.length ? [row] : [] });

    // 7) COLLECTOR FOR DOUBLE-UP
    if (payout > 0) {
      const collector = msg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 20000
      });

      collector.on('collect', async i => {
        if (i.user.id !== userId) {
          return i.reply({ content: '❌ Not your game!', ephemeral: true });
        }
        if (collected) return;
        collected = true;
        collector.stop();

        if (i.customId === 'double') {
          // 50/50 chance
          if (crypto.randomInt(0, 2) === 1) {
            payout *= 2;
          } else {
            payout = 0;
          }
        }
        // Final balance write
        const finalBalance = balanceAfterBet + payout;
        await updateBalance(userId, finalBalance);

        // Update embed to show final result & disable buttons
        resultEmbed.data.fields[4].value = payout > 0
          ? (i.customId === 'double'
              ? `🎉 You ${payout > lineWin+freeWin ? 'doubled' : 'busted'} to **$${payout.toFixed(2)}**!`
              : `💰 You collected **$${payout.toFixed(2)}**.`)
          : '💥 You busted! You get nothing.';
        resultEmbed.setFooter({ text: `New balance: $${finalBalance.toFixed(2)}` });

        // disable buttons
        row.components.forEach(b => b.setDisabled(true));
        await i.update({ embeds: [resultEmbed], components: [row] });
      });

      collector.on('end', async () => {
        if (!collected) {
          // Timeout → auto‐collect
          collected = true;
          const finalBalance = balanceAfterBet + payout;
          await updateBalance(userId, finalBalance);
          resultEmbed.data.fields[4].value = `⏰ Time’s up—auto-collected **$${payout.toFixed(2)}**.`;
          resultEmbed.setFooter({ text: `New balance: $${finalBalance.toFixed(2)}` });
          row.components.forEach(b => b.setDisabled(true));
          await msg.edit({ embeds: [resultEmbed], components: [row] });
        }
      });
    } else {
      // No win ⇒ write back immediately
      await updateBalance(userId, balanceAfterBet);
    }
  }
};
