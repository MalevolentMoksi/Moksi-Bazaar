// src/commands/admin/relationoverview.js
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getUserContext, pool } = require('../../utils/db.js');

// Simple function that gets all users using the clean system
async function getAllUserRelationships(limit = 20) {
  // Get all users with interactions
  const { rows } = await pool.query(`
    SELECT user_id, display_name, interaction_count, attitude_level
    FROM user_preferences
    WHERE interaction_count > 0
    ORDER BY interaction_count DESC
    LIMIT $1
  `, [limit]);

  // Map to clean relationship data
  const relationships = rows.map(row => ({
    userId: row.user_id,
    displayName: row.display_name,
    attitudeLevel: row.attitude_level || 'neutral',
    interactionCount: row.interaction_count || 0
  }));

  // Sort by interaction count (since we don't have complex quality scores anymore)
  return relationships.sort((a, b) => {
    // Prioritize by attitude level first, then interaction count
    const attitudePriority = {
      'familiar': 5,
      'friendly': 4,
      'neutral': 3,
      'cautious': 2,
      'hostile': 1
    };

    const aPriority = attitudePriority[a.attitudeLevel] || 3;
    const bPriority = attitudePriority[b.attitudeLevel] || 3;

    if (aPriority !== bPriority) {
      return bPriority - aPriority; // Higher priority first
    }

    return b.interactionCount - a.interactionCount;
  });
}

function getEmojiForAttitude(attitudeLevel) {
  switch (attitudeLevel) {
    case 'hostile': return '🔥';
    case 'cautious': return '😐';
    case 'neutral': return '⚪';
    case 'friendly': return '😊';
    case 'familiar': return '💚';
    default: return '❓';
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('relationoverview')
    .setDescription('Get an overview of all user relationships')
    .addIntegerOption(option =>
      option
        .setName('limit')
        .setDescription('How many users to show (default: 15)')
        .setRequired(false)
        .setMinValue(5)
        .setMaxValue(50)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({});

    try {
      const limit = interaction.options.getInteger('limit') || 15;
      const relationships = await getAllUserRelationships(limit);

      if (relationships.length === 0) {
        return await interaction.editReply('No user relationships found.');
      }

      const relationshipText = relationships.map((rel, index) => {
        const emoji = getEmojiForAttitude(rel.attitudeLevel);
        const name = rel.displayName || `User ${rel.userId.slice(-4)}`;

        return `${index + 1}. ${emoji} **${name}** - ${rel.attitudeLevel} (${rel.interactionCount} interactions)`;
      }).join('\n');

      const embed = {
        title: 'Cooler Moksi\'s Relationships',
        description: relationshipText,
        color: 0x00AAFF,
        footer: {
          text: `Showing ${relationships.length} users sorted by relationship quality`,
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