// src/commands/tools/relationoverview.js - Refactored with New Utilities
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { pool } = require('../../utils/db.js');
const { callGroqAPI } = require('../../utils/apiHelpers');
const { createOverviewEmbed } = require('../../utils/embedBuilder');
const { handleCommandError } = require('../../utils/errorHandler');

// ── DATA GATHERING ────────────────────────────────────────────────────────────
async function getAllUserRelationships(limit = 20) {
  // Sort best-to-worst by sentiment (friendly → familiar → neutral → cautious → hostile),
  // tiebreak by interaction volume. Previous ORDER BY put hostile above neutral which
  // made the overview weirdly flag enemies before unknowns.
  const { rows } = await pool.query(`
    SELECT
      user_id,
      display_name,
      interaction_count,
      attitude_level,
      sentiment_score,
      last_seen
    FROM user_preferences
    WHERE interaction_count > 0
    ORDER BY sentiment_score DESC, interaction_count DESC
    LIMIT $1
  `, [limit]);

  return rows.map(row => ({
    userId: row.user_id,
    displayName: row.display_name,
    attitudeLevel: row.attitude_level || 'neutral',
    interactionCount: row.interaction_count || 0,
    sentimentScore: parseFloat(row.sentiment_score) || 0,
    lastSeen: row.last_seen,
    isActive: row.last_seen && (Date.now() - new Date(row.last_seen).getTime()) < (7 * 24 * 60 * 60 * 1000)
  }));
}

// ── AI SUMMARY GENERATOR ──────────────────────────────────────────────────────
async function generateRelationshipSummary(relationships) {
  if (relationships.length === 0) return "i don't really know anyone yet.";

  const countBy = lvl => relationships.filter(r => r.attitudeLevel === lvl).length;
  const stats = {
    total: relationships.length,
    friendly: countBy('friendly'),
    familiar: countBy('familiar'),
    neutral: countBy('neutral'),
    cautious: countBy('cautious'),
    hostile: countBy('hostile'),
    avgSentiment: relationships.reduce((sum, r) => sum + r.sentimentScore, 0) / relationships.length
  };

  // Favourites: friendly first, then familiar. Enemies: hostile first, then cautious.
  const favourites = [
    ...relationships.filter(r => r.attitudeLevel === 'friendly'),
    ...relationships.filter(r => r.attitudeLevel === 'familiar')
  ].slice(0, 3);
  const enemies = [
    ...relationships.filter(r => r.attitudeLevel === 'hostile'),
    ...relationships.filter(r => r.attitudeLevel === 'cautious')
  ].slice(0, 3);

  const overallMood = stats.avgSentiment >= 0.3 ? 'mostly warm'
    : stats.avgSentiment <= -0.2 ? 'mostly cold'
    : 'mixed';

  const prompt = `Summarize Cooler Moksi's social life in 2 lowercase sentences. Match the tone to the actual data — if it's mostly grim, be grim; if surprisingly warm, let a trace of that through, reluctantly.
Known users: ${stats.total}. Breakdown — friendly: ${stats.friendly}, familiar: ${stats.familiar}, neutral: ${stats.neutral}, cautious: ${stats.cautious}, hostile: ${stats.hostile}. Overall mood: ${overallMood}.
Favourites: ${favourites.map(u => u.displayName).join(', ') || 'none'}.
Enemies: ${enemies.map(u => u.displayName).join(', ') || 'none'}.
No zoomer slang. No standard emojis. If mentioning names, use them naturally in a sentence.`;

  // PRIMARY: Groq Llama 3.3 8B ($0.05/$0.08/M) — lightweight, cost-efficient
  // FALLBACK: Groq Llama 3.3 70B ($0.59/$0.79/M) — full power if 8B fails
  const response = await callGroqAPI(prompt, {
    model: 'meta-llama/llama-3.3-8b-instruct',
    maxTokens: 110,
    temperature: 0.7,
    fallbackModel: 'meta-llama/llama-3.3-70b-versatile'
  });

  const warmCount = stats.friendly + stats.familiar;
  return response || `i know ${stats.total} people. ${warmCount} are cool, the rest are testing my patience.`;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('relationoverview')
    .setDescription('Get an overview of all user relationships')
    .addIntegerOption(o => o.setName('limit').setDescription('Max users (5-50)').setMinValue(5).setMaxValue(50))
    .addBooleanOption(o => o.setName('summary').setDescription('Include AI summary (default: true)')),
    
  async execute(interaction) {
    await interaction.deferReply();
    
    try {
      const limit = interaction.options.getInteger('limit') || 20;
      const includeSummary = interaction.options.getBoolean('summary') !== false;
      
      const relationships = await getAllUserRelationships(limit);

      if (relationships.length === 0) {
        return await interaction.editReply('I know absolutely nobody.');
      }

      let summaryText = null;
      if (includeSummary) {
        summaryText = await generateRelationshipSummary(relationships);
      }

      // Pagination logic: 20 users per page
      const USERS_PER_PAGE = 20;
      const totalPages = Math.ceil(relationships.length / USERS_PER_PAGE);
      let currentPage = 1;
      
      const getPageData = (page) => {
        const start = (page - 1) * USERS_PER_PAGE;
        const end = start + USERS_PER_PAGE;
        return relationships.slice(start, end);
      };

      const embed = createOverviewEmbed(getPageData(currentPage), {
        summary: summaryText,
        page: currentPage,
        totalPages
      });

      if (totalPages > 1) {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('prev_page')
            .setLabel('Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
          new ButtonBuilder()
            .setCustomId('next_page')
            .setLabel('Next')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(totalPages === 1)
        );

        const message = await interaction.editReply({ embeds: [embed], components: [row] });

        const collector = message.createMessageComponentCollector({
          time: 120000 // 2 minutes
        });

        collector.on('collect', async i => {
          if (i.user.id !== interaction.user.id) {
            return i.reply({ content: 'This is not your menu!', ephemeral: true });
          }

          if (i.customId === 'next_page') currentPage++;
          if (i.customId === 'prev_page') currentPage--;

          const newEmbed = createOverviewEmbed(getPageData(currentPage), {
            summary: summaryText,
            page: currentPage,
            totalPages
          });

          row.components[0].setDisabled(currentPage === 1);
          row.components[1].setDisabled(currentPage === totalPages);

          await i.update({ embeds: [newEmbed], components: [row] });
        });

        collector.on('end', async () => {
          row.components.forEach(btn => btn.setDisabled(true));
          await message.edit({ components: [row] }).catch(() => {});
        });
      } else {
        await interaction.editReply({ embeds: [embed] });
      }
    } catch (error) {
      await handleCommandError(interaction, error);
    }
  }
};