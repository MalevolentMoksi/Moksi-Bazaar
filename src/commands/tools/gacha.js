/**
 * Gacha/Loot Box Command
 * Open randomized loot boxes with tier-based cooldowns (persistent)
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
  getBalance,
  adjustBalance,
  getUserCooldownRemaining,
  setUserCooldown,
} = require('../../utils/db');
const { ackPublic, replyPublic } = require('../../utils/interactionAck');
const logger = require('../../utils/logger');
const { GAME_CONFIG } = require('../../utils/constants');
const { ui } = require('../../utils/ui/panel');

function getTierRewardBounds(tier) {
  if (Array.isArray(tier?.range) && tier.range.length >= 2) {
    return [tier.range[0], tier.range[1]];
  }

  if (tier?.rewards && Number.isFinite(tier.rewards.min) && Number.isFinite(tier.rewards.max)) {
    return [tier.rewards.min, tier.rewards.max];
  }

  return null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('gacha')
    .setDescription('Open a loot box (once per tier-based cooldown)'),

  async execute(interaction) {
    const userId = interaction.user.id;

    // Claimed before the cooldown read. A slow query used to mean the cooldown
    // was spent and the box never opened, which is the same loss as a stolen
    // bet: the player pays and gets nothing.
    await ackPublic(interaction);

    // Check if user is on cooldown (from database)
    const remaining = await getUserCooldownRemaining(userId, 'gacha');
    if (remaining > 0) {
      const mins = Math.floor(remaining / 1000 / 60);
      const secs = Math.floor((remaining / 1000) % 60);
      return replyPublic(interaction, {
        content: `⏳ Please wait **${mins}m ${secs}s** before opening another loot box.`,
      });
    }

    // Define rarities with weights, embed colors, reward ranges
    const tiers = GAME_CONFIG.GACHA.TIERS;

    // Weighted random selection of tier
    const totalWeight = tiers.reduce((sum, t) => sum + t.weight, 0);
    let roll = Math.random() * totalWeight;
    const chosen = tiers.find(t => {
      if (roll < t.weight) return true;
      roll -= t.weight;
      return false;
    });

    if (!chosen) {
      logger.error('Gacha tier selection failed', { userId, totalWeight, tiersCount: tiers.length });
      return replyPublic(interaction, {
        content: 'Loot box generation failed. Please try again in a moment.',
      });
    }

    // Pick a random reward within the chosen tier’s reward range
    const bounds = getTierRewardBounds(chosen);
    if (!bounds) {
      logger.error('Invalid gacha tier reward configuration', { userId, tier: chosen.name, chosen });
      return replyPublic(interaction, {
        content: 'Loot table is misconfigured. Please contact an admin.',
      });
    }

    const [min, max] = bounds;
    const reward = Math.floor(Math.random() * (max - min + 1)) + min;

    // Credit the reward atomically. This read the balance, added locally and
    // wrote the absolute result back, so a bet settling in the same instant
    // was silently overwritten by a stale number.
    const updated = (await adjustBalance(userId, reward)) ?? (await getBalance(userId));

    // ────────────────────────────────────────────────
    // Tier-based cooldown logic (now persistent in DB)
    // ────────────────────────────────────────────────

    const randomMs = Math.floor(Math.random() * GAME_CONFIG.GACHA.JITTER_MAX);
    const cooldownMs = chosen.cooldown + randomMs;

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

    await replyPublic(interaction, ui(embed, [], { scope: 'casino' }));
  }
};
