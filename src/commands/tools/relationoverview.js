// src/commands/admin/relationoverview.js - FIXED SCHEMA
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { pool } = require('../../utils/db.js'); // Ensure path matches your structure
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const LANGUAGE_API_KEY = process.env.LANGUAGE_API_KEY;

// ── DATA GATHERING ────────────────────────────────────────────────────────────
async function getAllUserRelationships(limit = 20) {
  // FIXED: Removed 'recent_interactions' from query as it does not exist in DB
  const { rows } = await pool.query(`
    SELECT 
      user_id, 
      display_name, 
      interaction_count, 
      attitude_level,
      sentiment_score,
      last_seen,
      updated_at
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
    // recentSentiment removed as we don't store JSON interactions anymore
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

  try {
    // Fallback to rules if API fails, but try API first
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${LANGUAGE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'meta-llama/llama-3.3-70b-versatile', // Use the smart model
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 100,
        temperature: 0.7,
      }),
    });

    if (response.ok) {
        const data = await response.json();
        return data.choices?.[0]?.message?.content?.trim();
    }
  } catch (e) { console.error(e); }

  return `i know ${stats.total} people. ${stats.familiar} are cool, the rest are testing my patience.`;
}

// ── FORMATTING ────────────────────────────────────────────────────────────────
function getEmojiForAttitude(attitudeLevel) {
  switch (attitudeLevel) {
    case 'familiar': return '💚';
    case 'friendly': return '😊';
    case 'neutral': return '😐';
    case 'cautious': return '🤨';
    case 'hostile': return '🖕';
    default: return '❓';
  }
}

function formatRelationshipEntry(rel, index) {
  const emoji = getEmojiForAttitude(rel.attitudeLevel);
  const name = rel.displayName || `User-${rel.userId.slice(-4)}`;
  const sentimentStr = rel.sentimentScore !== 0 ? ` (${rel.sentimentScore > 0 ? '+' : ''}${rel.sentimentScore.toFixed(2)})` : '';
  const activeIcon = rel.isActive ? '🟢' : '';

  return `${index + 1}. ${emoji} **${name}** - ${rel.attitudeLevel} | ${rel.interactionCount} msgs ${sentimentStr} ${activeIcon}`;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('relationoverview')
    .setDescription('Get an overview of all user relationships')
    .addIntegerOption(o => o.setName('limit').setDescription('Max users (5-30)').setMinValue(5).setMaxValue(30))
    .addBooleanOption(o => o.setName('summary').setDescription('Include AI summary')),
    
  async execute(interaction) {
    await interaction.deferReply();
    try {
      const limit = interaction.options.getInteger('limit') || 15;
      const includeSummary = interaction.options.getBoolean('summary') !== false;
      
      const relationships = await getAllUserRelationships(limit);

      if (relationships.length === 0) return await interaction.editReply('I know absolutely nobody.');

      let summaryText = '';
      if (includeSummary) summaryText = await generateRelationshipSummary(relationships);

      const list = relationships.map((r, i) => formatRelationshipEntry(r, i)).join('\n');
      
      const embed = {
        title: 'Social Battery Status',
        description: summaryText ? `*"${summaryText}"*\n\n${list}` : list,
        color: 0x00AAFF,
        footer: { text: `Tracking ${relationships.length} users` }
      };

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error(error);
      await interaction.editReply('Database blew up. Tell the dev.');
    }
  }
};