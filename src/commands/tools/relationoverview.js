// src/commands/admin/relationoverview.js
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getEnhancedUserContext, pool } = require('../../utils/db.js');

// Simple function that gets all users and uses the unified system
async function getAllUserRelationships(limit = 20) {
    // Get all users with interactions
    const { rows } = await pool.query(`
        SELECT user_id, display_name 
        FROM user_preferences 
        WHERE interaction_count > 0 
        ORDER BY interaction_count DESC 
        LIMIT $1
    `, [limit]);
    
    // Use the same system that speak.js uses
    const relationships = [];
    for (const row of rows) {
        const context = await getEnhancedUserContext(row.user_id);
        relationships.push({
            userId: row.user_id,
            displayName: row.display_name,
            attitudeLevel: context.attitudeLevel,
            friendshipLevel: context.friendshipLevel,
            interactionCount: context.interactionCount,
            qualityScore: context.relationshipStats.qualityScore,
            negativeScore: context.negativeScore,
            positiveScore: context.positiveScore
        });
    }
    
    // Sort by relationship quality
    return relationships.sort((a, b) => b.qualityScore - a.qualityScore);
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
                const levelIndicator = rel.friendshipLevel > 0 ? `Lv.${rel.friendshipLevel}` : 
                                     rel.friendshipLevel < 0 ? `Lv.${rel.friendshipLevel}` : 'Lv.0';
                const qualityPercent = (rel.qualityScore * 100).toFixed(0);
                
                return `${index + 1}. ${emoji} **${name}** - ${rel.attitudeLevel} ${levelIndicator} (${rel.interactionCount} interactions, ${qualityPercent}% quality)`;
            }).join('\n');

            const embed = {
                title: 'Cooler Moksi\'s Relationships',
                description: relationshipText,
                color: 0x00AAFF,
                footer: {
                    text: `Showing top ${relationships.length} users by relationship quality`,
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

function getEmojiForAttitude(attitudeLevel) {
    switch (attitudeLevel) {
        case 'hostile': return '🔥';
        case 'harsh': return '😠';
        case 'wary': return '🤨';
        case 'cautious': return '😐';
        case 'familiar': return '💚';
        case 'friendly': return '😊';
        case 'warm': return '🙂';
        case 'welcoming': return '👋';
        case 'approachable': return '🫡';
        default: return '⚪';
    }
}
