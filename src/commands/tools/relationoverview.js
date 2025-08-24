// src/commands/admin/relationoverview.js

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getAllUserRelationships } = require('../../utils/db.js');

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
                return `${index + 1}. ${emoji} **${name}** - ${rel.attitudeLevel} (${rel.interactionCount} interactions, score: ${rel.negativeScore.toFixed(2)})`;
            }).join('\n');
            
            const embed = {
                title: 'Cooler Moksi\'s Relationship Overview',
                description: relationshipText,
                color: 0x00AAFF,
                footer: {
                    text: `Showing top ${relationships.length} users by negative score and interactions`,
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
        case 'friendly': return '😊';
        case 'familiar': return '💚';
        default: return '⚪';
    }
}
