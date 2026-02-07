/**
 * Gacha/Loot Box Command
 * Open randomized loot boxes with tier-based cooldowns (persistent)
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
  getBalance,
  updateBalance,
  getUserCooldownRemaining,
  setUserCooldown,
} = require('../../utils/db');
const logger = require('../../utils/logger');
const config = require('../../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('gacha')
    .setDescription('Open a loot box (once per tier-based cooldown)'),

  async execute(interaction) {
    const userId = interaction.user.id;

    // Check if user is on cooldown (from database)
    const remaining = await getUserCooldownRemaining(userId, 'gacha');
    if (remaining > 0) {
      const mins = Math.floor(remaining / 1000 / 60);
      const secs = Math.floor((remaining / 1000) % 60);
      return interaction.reply({
        content: `⏳ Please wait **${mins}m ${secs}s** before opening another loot box.`,
      });
    }

    // Define rarities with weights, embed colors, reward ranges
    const tiers = config.GAMES.GACHA.TIERS;

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
    // Tier-based cooldown logic (now persistent in DB)
    // ────────────────────────────────────────────────

    // Base cooldown in minutes for each tier  
    const baseCooldownMinutes = {
      Common: 1,
      Rare: 3,
      Epic: 10,
      Legendary: 24 * 60,
      Mythic: 24 * 60,
    };

    const baseMin = baseCooldownMinutes[chosen.name] ?? 5;
    const randomMs = Math.floor(Math.random() * config.GAMES.GACHA.JITTER_MAX);
    const cooldownMs = baseMin * 60 * 1000 + randomMs;

    // Save cooldown to database (persistent across bot restarts)
    await setUserCooldown(userId, 'gacha', cooldownMs);

    const nextMins = Math.floor(cooldownMs / 1000 / 60);
    const nextSecs = Math.floor((cooldownMs / 1000) % 60);

    logger.info('Gacha loot box opened', {
      userId,
      tier: chosen.name,
      reward,
      newBalance: updated,
      cooldownMs,
    });

    // ────────────────────────────────────────────────
    // Build and send embed
    // ────────────────────────────────────────────────

    const emojis = {
      Common:    '📦',
      Rare:      '💰',
      Epic:      '💎',
      Legendary: '🐉',
      Mythic:    '👑'
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
