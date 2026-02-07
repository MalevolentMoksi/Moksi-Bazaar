// src/commands/tools/mystats.js - View your own relationship stats
const { SlashCommandBuilder,  MessageFlags } = require('discord.js');
const { getUserContext, getRecentMemories, pool } = require('../../utils/db.js');
const { createStatsEmbed } = require('../../utils/embedBuilder');
const { handleCommandError } = require('../../utils/errorHandler');


module.exports = {
    data: new SlashCommandBuilder()
        .setName('mystats')
        .setDescription('View your own relationship stats with Cooler Moksi'),

    async execute(interaction) {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        try {
            const userId = interaction.user.id;

            // Fetch user context and recent sentiment trend
            const [userContext, recentMemories] = await Promise.all([
                getUserContext(userId),
                pool.query(`
                    SELECT sentiment_score 
                    FROM conversation_memories 
                    WHERE user_id = $1 
                    ORDER BY timestamp DESC 
                    LIMIT 10
                `, [userId])
            ]);

            // If user is completely new
            if (userContext.isNewUser) {
                return await interaction.editReply({
                    content: 'You haven\'t talked with me yet. Use `/speak` to start a conversation!',
                    ephemeral: true
                });
            }

            // Extract recent sentiment scores
            const recentSentiments = recentMemories.rows.map(r => parseFloat(r.sentiment_score) || 0);

            const embed = createStatsEmbed(userContext, interaction.user, recentSentiments);

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            await handleCommandError(interaction, error);
        }
    }
};
