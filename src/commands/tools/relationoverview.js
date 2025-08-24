// src/commands/admin/relationoverview.js

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { pool } = require('../../utils/db.js');

// Enhanced function to get all relationships with new metrics
async function getEnhancedAllUserRelationships(limit = 20) {
    const { rows } = await pool.query(`
        SELECT 
            user_id,
            display_name,
            interaction_count,
            negative_score,
            positive_score,
            hostile_interactions,
            positive_interactions,
            relationship_quality_score,
            warmth_level,
            trust_level,
            comfort_level,
            connection_depth,
            meaningful_exchanges,
            last_positive_interaction
        FROM user_preferences
        WHERE interaction_count > 0
        ORDER BY
            relationship_quality_score DESC,
            positive_score DESC,
            interaction_count DESC
        LIMIT $1
    `, [limit]);

    return rows.map(row => {
        const negScore = parseFloat(row.negative_score) || 0;
        const posScore = parseFloat(row.positive_score) || 0;
        const interactionCount = row.interaction_count || 0;
        const qualityScore = parseFloat(row.relationship_quality_score) || 0;
        const netSentiment = posScore - negScore;
        const positivityRatio = row.positive_interactions / Math.max(interactionCount, 1);

        // Determine attitude level using same logic as getEnhancedUserContext
        let attitudeLevel = 'neutral';
        let friendshipLevel = 0;

        if (negScore > 0.6 || netSentiment < -0.8) {
            attitudeLevel = 'hostile';
            friendshipLevel = -3;
        } else if (negScore > 0.3 || netSentiment < -0.5) {
            attitudeLevel = 'harsh';
            friendshipLevel = -2;
        } else if (negScore > 0.15 || netSentiment < -0.2) {
            attitudeLevel = 'wary';
            friendshipLevel = -1;
        } else if (negScore > 0.05 || netSentiment < -0.1) {
            attitudeLevel = 'cautious';
            friendshipLevel = 0;
        } else if (negScore <= 0.05 && netSentiment >= 0) {
            if (qualityScore >= 0.85 && interactionCount >= 15 && positivityRatio > 0.8) {
                attitudeLevel = 'devoted';
                friendshipLevel = 10;
            } else if (qualityScore >= 0.75 && interactionCount >= 12 && positivityRatio > 0.7) {
                attitudeLevel = 'adoring';
                friendshipLevel = 9;
            } else if (qualityScore >= 0.65 && interactionCount >= 10 && positivityRatio > 0.65) {
                attitudeLevel = 'loving';
                friendshipLevel = 8;
            } else if (qualityScore >= 0.55 && interactionCount >= 8 && positivityRatio > 0.6) {
                attitudeLevel = 'affectionate';
                friendshipLevel = 7;
            } else if (qualityScore >= 0.45 && interactionCount >= 6 && positivityRatio > 0.55) {
                attitudeLevel = 'warm';
                friendshipLevel = 6;
            } else if (qualityScore >= 0.35 && interactionCount >= 5 && positivityRatio > 0.5) {
                attitudeLevel = 'fond';
                friendshipLevel = 5;
            } else if (qualityScore >= 0.25 && interactionCount >= 4 && positivityRatio > 0.4) {
                attitudeLevel = 'friendly';
                friendshipLevel = 4;
            } else if (qualityScore >= 0.15 && interactionCount >= 3 && positivityRatio > 0.3) {
                attitudeLevel = 'welcoming';
                friendshipLevel = 3;
            } else if (qualityScore >= 0.08 && interactionCount >= 2 && positivityRatio > 0.2) {
                attitudeLevel = 'approachable';
                friendshipLevel = 2;
            } else if (interactionCount >= 1 && netSentiment > 0) {
                attitudeLevel = 'polite';
                friendshipLevel = 1;
            }
        }

        return {
            userId: row.user_id,
            displayName: row.display_name,
            attitudeLevel: attitudeLevel,
            friendshipLevel: friendshipLevel,
            interactionCount: interactionCount,
            qualityScore: qualityScore,
            negativeScore: negScore,
            positiveScore: posScore,
            positivityRatio: positivityRatio
        };
    });
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
            const relationships = await getEnhancedAllUserRelationships(limit);

            if (relationships.length === 0) {
                return await interaction.editReply('No user relationships found.');
            }

            const relationshipText = relationships.map((rel, index) => {
                const emoji = getEmojiForAttitude(rel.attitudeLevel);
                const name = rel.displayName || `User ${rel.userId.slice(-4)}`;
                const levelIndicator = rel.friendshipLevel > 0 ? `Lv.${rel.friendshipLevel}` : rel.friendshipLevel < 0 ? `Lv.${rel.friendshipLevel}` : 'Lv.0';
                const qualityPercent = (rel.qualityScore * 100).toFixed(0);
                
                return `${index + 1}. ${emoji} **${name}** - ${rel.attitudeLevel} ${levelIndicator} (${rel.interactionCount} interactions, ${qualityPercent}% quality)`;
            }).join('\n');

            // Split into multiple embeds if too long
            const maxLength = 4000;
            if (relationshipText.length > maxLength) {
                const halfLength = Math.ceil(relationships.length / 2);
                const firstHalf = relationships.slice(0, halfLength);
                const secondHalf = relationships.slice(halfLength);

                const firstText = firstHalf.map((rel, index) => {
                    const emoji = getEmojiForAttitude(rel.attitudeLevel);
                    const name = rel.displayName || `User ${rel.userId.slice(-4)}`;
                    const levelIndicator = rel.friendshipLevel > 0 ? `Lv.${rel.friendshipLevel}` : rel.friendshipLevel < 0 ? `Lv.${rel.friendshipLevel}` : 'Lv.0';
                    const qualityPercent = (rel.qualityScore * 100).toFixed(0);
                    return `${index + 1}. ${emoji} **${name}** - ${rel.attitudeLevel} ${levelIndicator} (${rel.interactionCount} interactions, ${qualityPercent}% quality)`;
                }).join('\n');

                const secondText = secondHalf.map((rel, index) => {
                    const emoji = getEmojiForAttitude(rel.attitudeLevel);
                    const name = rel.displayName || `User ${rel.userId.slice(-4)}`;
                    const levelIndicator = rel.friendshipLevel > 0 ? `Lv.${rel.friendshipLevel}` : rel.friendshipLevel < 0 ? `Lv.${rel.friendshipLevel}` : 'Lv.0';
                    const qualityPercent = (rel.qualityScore * 100).toFixed(0);
                    return `${halfLength + index + 1}. ${emoji} **${name}** - ${rel.attitudeLevel} ${levelIndicator} (${rel.interactionCount} interactions, ${qualityPercent}% quality)`;
                }).join('\n');

                const embeds = [
                    {
                        title: 'Cooler Moksi\'s Enhanced Relationships (Part 1)',
                        description: firstText,
                        color: 0x00AAFF,
                        footer: {
                            text: `Part 1 of 2 - Sorted by relationship quality`,
                            icon_url: interaction.client.user.avatarURL()
                        }
                    },
                    {
                        title: 'Cooler Moksi\'s Enhanced Relationships (Part 2)', 
                        description: secondText,
                        color: 0x00AAFF,
                        footer: {
                            text: `Part 2 of 2 - Total: ${relationships.length} users`,
                            icon_url: interaction.client.user.avatarURL()
                        },
                        timestamp: new Date()
                    }
                ];

                await interaction.editReply({ embeds: embeds });
            } else {
                const embed = {
                    title: 'Cooler Moksi\'s Enhanced Relationships',
                    description: relationshipText,
                    color: 0x00AAFF,
                    footer: {
                        text: `Showing top ${relationships.length} users by relationship quality`,
                        icon_url: interaction.client.user.avatarURL()
                    },
                    timestamp: new Date()
                };

                await interaction.editReply({ embeds: [embed] });
            }

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
        case 'devoted': return '💖';
        case 'adoring': return '🥰';
        case 'loving': return '💕';
        case 'affectionate': return '😍';
        case 'warm': return '😊';
        case 'fond': return '🙂';
        case 'friendly': return '😄';
        case 'welcoming': return '👋';
        case 'approachable': return '🫡';
        case 'polite': return '😌';
        default: return '⚪';
    }
}
