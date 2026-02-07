// src/commands/tools/relationoverview.js - Refactored with New Utilities
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { pool } = require('../../utils/db.js');
const { callGroqAPI } = require('../../utils/apiHelpers');
const { createOverviewEmbed } = require('../../utils/embedBuilder');
const { handleCommandError } = require('../../utils/errorHandler');

// ── DATA GATHERING ────────────────────────────────────────────────────────────
async function getAllUserRelationships(limit = 20) {
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
    ORDER BY 
      CASE attitude_level
        WHEN 'familiar' THEN 5
        WHEN 'friendly' THEN 4  
        WHEN 'hostile' THEN 3
        WHEN 'cautious' THEN 2
        ELSE 1
      END DESC,
      interaction_count DESC
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

  const stats = {
    total: relationships.length,
    familiar: relationships.filter(r => r.attitudeLevel === 'familiar').length,
    friendly: relationships.filter(r => r.attitudeLevel === 'friendly').length,
    neutral: relationships.filter(r => r.attitudeLevel === 'neutral').length,
    hostile: relationships.filter(r => r.attitudeLevel === 'hostile' || r.attitudeLevel === 'cautious').length,
    avgSentiment: relationships.reduce((sum, r) => sum + r.sentimentScore, 0) / relationships.length
  };

  const topFriends = relationships.filter(r => r.attitudeLevel === 'familiar').slice(0, 3);
  const enemies = relationships.filter(r => r.attitudeLevel === 'hostile').slice(0, 3);

  const prompt = `Summarize Cooler Moksi's social life.
Stats: ${stats.total} known users. ${stats.familiar} close friends. ${stats.hostile} enemies. Avg Sentiment: ${stats.avgSentiment.toFixed(2)}.
Best Friends: ${topFriends.map(u => u.displayName).join(', ') || 'None'}.
Enemies: ${enemies.map(u => u.displayName).join(', ') || 'None'}.

Write 2 sentences. Be cynical and casual.`;

  const response = await callGroqAPI(prompt, {
    maxTokens: 100,
    temperature: 0.7
  });

  return response || `i know ${stats.total} people. ${stats.familiar} are cool, the rest are testing my patience.`;
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