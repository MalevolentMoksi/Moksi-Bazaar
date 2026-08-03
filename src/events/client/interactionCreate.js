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
        } else if (interaction.isButton() || interaction.isAnySelectMenu()) {
            // Collectors own components: a live collector acks these well before
            // the timer below fires. If nothing claims the interaction (the
            // collector expired but the message is still up), answer it ourselves
            // instead of letting Discord show its raw 'This interaction failed'.
            logger.debug('Component interaction received', { customId: interaction.customId, userId: interaction.user.id });

            // 2.5s, not 3s: Discord invalidates the token three seconds after
            // the interaction was created, and some of that is already spent on
            // gateway delivery before this handler ever runs. Landing late just
            // means the reply is rejected and the user sees the same failure
            // notice they would have seen anyway, so erring early costs nothing.
            const fallbackTimer = setTimeout(async () => {
                if (interaction.replied || interaction.deferred) return;
                try {
                    await interaction.reply({
                        content: 'That one\'s dead. Whatever you just pressed expired a while ago; run the command again.',
                        flags: MessageFlags.Ephemeral,
                    });
                } catch {
                    // The token may have expired or a collector acked mid-flight; nothing to salvage.
                }
            }, 2500);
            // Fires at most once; unref so a pending timer never holds the process open.
            fallbackTimer.unref();
        }
    }
};
