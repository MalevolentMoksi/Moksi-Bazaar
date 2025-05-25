// src/commands/tools/gacha.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getBalance, updateBalance } = require('../../utils/db');

// In‐memory cooldown map: userId → { last: timestamp, cooldown: ms }
const cooldowns = new Map();

module.exports = {
  data: new SlashCommandBuilder()
    .setName('gacha')
    .setDescription('Open a loot box (once every 10 minutes)'),
    
  async execute(interaction) {
    const userId = interaction.user.id;
    const now = Date.now();

    // Get last pull and cooldown for this user
    const cooldownData = cooldowns.get(userId) || { last: 0, cooldown: 0 };
    const { last, cooldown } = cooldownData;

    if (now - last < cooldown) {
      const remaining = cooldown - (now - last);
      const mins = Math.floor(remaining / 1000 / 60);
      const secs = Math.floor((remaining / 1000) % 60);
      return interaction.reply({
        content: `⏳ Please wait **${mins}m ${secs}s** before opening another loot box.`,
        ephemeral: false
      });
    }
    // Set a random cooldown between 2 and 10 minutes (in ms)
    const randomCooldown = (Math.floor(Math.random() * (10 - 2 + 1)) + 2) * 60 * 1000;
    cooldowns.set(userId, { last: now, cooldown: randomCooldown });

    // Define rarities with weights, embed colors, and reward ranges
    const tiers = [
      { name: 'Common',    weight: 40, color: 0x95a5a6, range: [100,  300] },
      { name: 'Uncommon',  weight: 30, color: 0x2ecc71, range: [500, 1500] },
      { name: 'Rare',      weight: 15, color: 0x3498db, range: [1500,3000] },
      { name: 'Epic',      weight: 10, color: 0x9b59b6, range: [3000,6000] },
      { name: 'Legendary', weight: 5, color: 0xf1c40f, range: [10000,20000] }
    ];

    // Weighted random selection
    const totalWeight = tiers.reduce((sum, t) => sum + t.weight, 0);
    let roll = Math.random() * totalWeight;
    let chosen = tiers.find(t => {
      if (roll < t.weight) return true;
      roll -= t.weight;
      return false;
    });

    // Pick a random reward within the chosen tier’s range
    const [min, max] = chosen.range;
    const reward = Math.floor(Math.random() * (max - min + 1)) + min;

    // Update the user’s balance
    const current = await getBalance(userId);
    const updated = current + reward;
    await updateBalance(userId, updated);

    // Build and send an embed result
    const embed = new EmbedBuilder()
      .setTitle(`🎁 ${chosen.name} Loot Box`)
      .setColor(chosen.color)
      .setDescription(`You won **$${reward}**!\nYour new balance is **$${updated}**.`);

    await interaction.reply({ embeds: [embed] });
  }
};
