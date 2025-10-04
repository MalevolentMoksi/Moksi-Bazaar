// src/commands/admin/relationoverview.js - Enhanced with AI Insights
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getUserContext, pool } = require('../../utils/db.js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const LANGUAGE_API_KEY = process.env.LANGUAGE_API_KEY;

// ── ENHANCED RELATIONSHIP DATA GATHERING ──────────────────────────────────────
async function getAllUserRelationships(limit = 20) {
  // Get all users with enhanced data
  const { rows } = await pool.query(`
    SELECT 
      user_id, 
      display_name, 
      interaction_count, 
      attitude_level,
      sentiment_score,
      last_seen,
      recent_interactions,
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

  // Process and enhance the data
  const relationships = rows.map(row => {
    const recentInteractions = row.recent_interactions || [];
    const avgRecentSentiment = recentInteractions.length > 0 
      ? recentInteractions.reduce((sum, i) => sum + i.sentiment, 0) / recentInteractions.length
      : (parseFloat(row.sentiment_score) || 0);

    return {
      userId: row.user_id,
      displayName: row.display_name,
      attitudeLevel: row.attitude_level || 'neutral',
      interactionCount: row.interaction_count || 0,
      sentimentScore: parseFloat(row.sentiment_score) || 0,
      recentSentiment: avgRecentSentiment,
      lastSeen: row.last_seen,
      recentInteractionCount: recentInteractions.length,
      isActive: row.last_seen && (Date.now() - new Date(row.last_seen).getTime()) < (7 * 24 * 60 * 60 * 1000) // Active within 7 days
    };
  });

  return relationships;
}

// ── AI RELATIONSHIP SUMMARY GENERATOR ─────────────────────────────────────────
async function generateRelationshipSummary(relationships) {
  if (relationships.length === 0) {
    return "i don't really know anyone yet, pretty lonely tbh";
  }

  // Prepare summary stats
  const stats = {
    total: relationships.length,
    familiar: relationships.filter(r => r.attitudeLevel === 'familiar').length,
    friendly: relationships.filter(r => r.attitudeLevel === 'friendly').length,
    neutral: relationships.filter(r => r.attitudeLevel === 'neutral').length,
    cautious: relationships.filter(r => r.attitudeLevel === 'cautious').length,
    hostile: relationships.filter(r => r.attitudeLevel === 'hostile').length,
    active: relationships.filter(r => r.isActive).length,
    totalInteractions: relationships.reduce((sum, r) => sum + r.interactionCount, 0),
    avgSentiment: relationships.reduce((sum, r) => sum + r.sentimentScore, 0) / relationships.length
  };

  // Get notable users
  const topFriends = relationships.filter(r => r.attitudeLevel === 'familiar' || r.attitudeLevel === 'friendly').slice(0, 3);
  const problemUsers = relationships.filter(r => r.attitudeLevel === 'hostile' || r.attitudeLevel === 'cautious').slice(0, 2);
  const mostActive = relationships.sort((a, b) => b.interactionCount - a.interactionCount).slice(0, 3);

  const prompt = `You are Cooler Moksi. Someone asked for an overview of your relationships with users. Give a brief, authentic summary of your social situation.

RELATIONSHIP STATS:
- Total users: ${stats.total}
- Familiar friends: ${stats.familiar}
- Friendly users: ${stats.friendly}  
- Neutral users: ${stats.neutral}
- Cautious about: ${stats.cautious}
- Hostile toward: ${stats.hostile}
- Active recently: ${stats.active}
- Total interactions: ${stats.totalInteractions}
- Average sentiment: ${stats.avgSentiment.toFixed(2)}

TOP FRIENDS: ${topFriends.map(u => `${u.displayName} (${u.attitudeLevel})`).join(', ') || 'none'}
PROBLEM USERS: ${problemUsers.map(u => `${u.displayName} (${u.attitudeLevel})`).join(', ') || 'none'}  
MOST ACTIVE: ${mostActive.map(u => `${u.displayName} (${u.interactionCount} interactions)`).join(', ')}

Write 2-3 sentences as Moksi reflecting on your social life. Be authentic, slightly cynical, and mention specific details that stand out. Use lowercase and casual language.`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LANGUAGE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 150,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      console.error('AI summary generation failed:', await response.text());
      return generateFallbackSummary(stats, topFriends, problemUsers);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || generateFallbackSummary(stats, topFriends, problemUsers);

  } catch (error) {
    console.error('Error generating relationship summary:', error);
    return generateFallbackSummary(stats, topFriends, problemUsers);
  }
}

function generateFallbackSummary(stats, topFriends, problemUsers) {
  let summary = `i know ${stats.total} people, `;

  if (stats.familiar > 0) {
    summary += `${stats.familiar} of them are actually pretty cool. `;
  }

  if (stats.hostile > 0) {
    summary += `${stats.hostile} are genuinely annoying though. `;
  }

  if (stats.neutral > stats.friendly + stats.familiar) {
    summary += `most people are just... meh, nothing special.`;
  } else {
    summary += `overall not terrible, could be worse.`;
  }

  return summary;
}

// ── EMOJI MAPPING ─────────────────────────────────────────────────────────────
function getEmojiForAttitude(attitudeLevel) {
  switch (attitudeLevel) {
    case 'familiar': return '💚';
    case 'friendly': return '😊';
    case 'neutral': return '😐';
    case 'cautious': return '🤨';
    case 'hostile': return '😡';
    default: return '❓';
  }
}

function formatRelationshipEntry(relationship, index) {
  const emoji = getEmojiForAttitude(relationship.attitudeLevel);
  const name = relationship.displayName || `User-${relationship.userId.slice(-4)}`;

  // Build status indicators
  const indicators = [];
  if (relationship.isActive) indicators.push('🟢');
  if (relationship.sentimentScore > 0.5) indicators.push('📈');
  if (relationship.sentimentScore < -0.5) indicators.push('📉');
  if (relationship.interactionCount > 100) indicators.push('💬');

  const statusStr = indicators.length > 0 ? ` ${indicators.join('')}` : '';

  // Format the line
  const sentimentStr = relationship.sentimentScore !== 0 ? ` (${relationship.sentimentScore > 0 ? '+' : ''}${relationship.sentimentScore.toFixed(2)})` : '';

  return `${index + 1}. ${emoji} **${name}** - ${relationship.attitudeLevel} | ${relationship.interactionCount} interactions${sentimentStr}${statusStr}`;
}

// ── MAIN COMMAND HANDLER ──────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('relationoverview')
    .setDescription('Get an overview of all user relationships with AI insights')
    .addIntegerOption(option =>
      option
        .setName('limit')
        .setDescription('How many users to show (default: 15, max: 30)')
        .setRequired(false)
        .setMinValue(5)
        .setMaxValue(30)
    )
    .addBooleanOption(option =>
      option
        .setName('summary')
        .setDescription('Include AI-generated relationship summary')
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({});

    try {
      const limit = interaction.options.getInteger('limit') || 15;
      const includeSummary = interaction.options.getBoolean('summary') !== false; // Default true

      const relationships = await getAllUserRelationships(limit);

      if (relationships.length === 0) {
        return await interaction.editReply('No user relationships found. Moksi hasn\'t met anyone yet!');
      }

      // Generate AI summary if requested
      let summaryText = '';
      if (includeSummary) {
        summaryText = await generateRelationshipSummary(relationships);
      }

      // Format relationship list
      const relationshipText = relationships
        .map((rel, index) => formatRelationshipEntry(rel, index))
        .join('\n');

      // Create stats summary
      const stats = {
        familiar: relationships.filter(r => r.attitudeLevel === 'familiar').length,
        friendly: relationships.filter(r => r.attitudeLevel === 'friendly').length,
        neutral: relationships.filter(r => r.attitudeLevel === 'neutral').length,
        cautious: relationships.filter(r => r.attitudeLevel === 'cautious').length,
        hostile: relationships.filter(r => r.attitudeLevel === 'hostile').length,
        active: relationships.filter(r => r.isActive).length,
      };

      const statsText = `💚 ${stats.familiar} | 😊 ${stats.friendly} | 😐 ${stats.neutral} | 🤨 ${stats.cautious} | 😠 ${stats.hostile} | 🟢 ${stats.active} active`;

      // Build embed
      const embed = {
        title: 'Cooler Moksi\'s Relationship Overview',
        description: summaryText ? `*"${summaryText}"*\n\n${relationshipText}` : relationshipText,
        color: 0x00AAFF,
        fields: [{
          name: 'Statistics',
          value: statsText,
          inline: false
        }],
        footer: {
          text: `Showing ${relationships.length} users | 🟢 Active (7 days) | 📈 Positive trend | 📉 Negative trend | 💬 Very active`,
          icon_url: interaction.client.user.avatarURL()
        },
        timestamp: new Date()
      };

      await interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('Error in relationoverview command:', error);
      await interaction.editReply('Error getting relationship overview: ' + error.message);
    }
  },
};