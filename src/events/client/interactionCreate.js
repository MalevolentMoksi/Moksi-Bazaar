/**
 * Interaction Create Event Handler
 * Routes slash commands and buttons to their respective handlers
 */

const { MessageFlags } = require('discord.js');
const logger = require('../../utils/logger');

module.exports = {
    name: 'interactionCreate',
    async execute(interaction, client) {
        if (interaction.isChatInputCommand()) {
            const { commands } = client;
            const { commandName } = interaction;
            const command = commands.get(commandName);

            if (!command) {
                logger.warn('Unknown command attempted', { commandName, userId: interaction.user.id });
                return;
            }

            try {
                logger.info('Executing command', { commandName, userId: interaction.user.id, guildId: interaction.guildId });
                await command.execute(interaction, client);
            } catch (error) {
                logger.error('Command execution failed', {
                    commandName,
                    userId: interaction.user.id,
                    guildId: interaction.guildId,
                    error: error.message,
                    stack: error.stack,
                });

                // Try to reply with error message
                try {
                    if (interaction.replied || interaction.deferred) {
                        await interaction.followUp({
                            content: 'There was an error while executing this command!',
                            flags: MessageFlags.Ephemeral,
                        });
                    } else {
                        await interaction.reply({
                            content: 'There was an error while executing this command!',
                            flags: MessageFlags.Ephemeral,
                        });
                    }
                } catch (replyError) {
                    logger.error('Failed to send error reply', {
                        commandName,
                        userId: interaction.user.id,
                        error: replyError.message,
                    });
                }
            }
        } else if (interaction.isButton()) {
            // Buttons are handled by their respective command collectors
            // This prevents double-acknowledgment
            logger.debug('Button interaction received', { customId: interaction.customId, userId: interaction.user.id });
            return;
        } else if (interaction.isStringSelectMenu() || interaction.isRoleSelectMenu()) {
            // Future: Add select menu handling if needed
            logger.debug('Select menu interaction received', { customId: interaction.customId, userId: interaction.user.id });
        }
    }
};
