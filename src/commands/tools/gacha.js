// src/commands/tools/gacha.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getBalance, updateBalance } = require('../../utils/db');

// In-memory cooldown map: userId → { last: timestamp, cooldown: ms }
const cooldowns = new Map();

module.exports = {
  data: new SlashCommandBuilder()
    .setName('gacha')
    .setDescription('Open a loot box (once per tier-based cooldown)'),

  async execute(interaction) {
    const userId = interaction.user.id;
    const now = Date.now();

    // Get last pull and cooldown for this user
    const { last = 0, cooldown = 0 } = cooldowns.get(userId) || {};

    if (now - last < cooldown) {
      const remaining = cooldown - (now - last);
      const mins = Math.floor(remaining / 1000 / 60);
      const secs = Math.floor((remaining / 1000) % 60);
      return interaction.reply({
        content: `⏳ Please wait **${mins}m ${secs}s** before opening another loot box.`,
        ephemeral: false
      });
    }

    // Define rarities with weights, embed colors, reward ranges, etc.
    const tiers = [
      { name: 'Common',    weight: 40, color: 0x95a5a6, range: [100,  300] },
      { name: 'Uncommon',  weight: 30, color: 0x2ecc71, range: [500, 1500] },
      { name: 'Rare',      weight: 15, color: 0x3498db, range: [1500,3000] },
      { name: 'Epic',      weight: 10, color: 0x9b59b6, range: [3000,6000] },
      { name: 'Legendary', weight: 5,  color: 0xf1c40f, range: [10000,20000] }
    ];

    // Weighted random selection of tier
    const totalWeight = tiers.reduce((sum, t) => sum + t.weight, 0);
    let roll = Math.random() * totalWeight;
    const chosen = tiers.find(t => {
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

    // ────────────────────────────────────────────────
    // Tier-based cooldown logic starts here
    // ────────────────────────────────────────────────

    // Base cooldown in minutes for each tier
    const baseCooldownMinutes = {
      Common:    2,
      Uncommon:  5,
      Rare:      8,
      Epic:     12,
      Legendary: 15
    };

    const baseMin = baseCooldownMinutes[chosen.name] ?? 5;
    const randomSeconds = Math.floor(Math.random() * 60); // 0–59s jitter
    const cooldownMs = (baseMin * 60 + randomSeconds) * 1000;

    // Save new cooldown
    cooldowns.set(userId, { last: now, cooldown: cooldownMs });

    // Compute next availability for embed
    const nextMins = Math.floor(cooldownMs / 1000 / 60);
    const nextSecs = Math.floor((cooldownMs / 1000) % 60);

    // ────────────────────────────────────────────────
    // Build and send embed
    // ────────────────────────────────────────────────

    const emojis = {
      Common:    '📦',
      Uncommon:  '🛍️',
      Rare:      '💰',
      Epic:      '💎',
      Legendary: '🐉'
    };
    const emoji = emojis[chosen.name] || '🎁';

    const embed = new EmbedBuilder()
      .setTitle(`${emoji} ${chosen.name} Loot Box`)
      .setColor(chosen.color)
      .setDescription(`You won **$${reward}**!\nYour new balance is **$${updated}**.`)
      .addFields({
        name: 'Next Loot Box',
        value: `Available in **${nextMins}m ${nextSecs}s**`,
        inline: false
      });

    await interaction.reply({ embeds: [embed] });
  }
};
