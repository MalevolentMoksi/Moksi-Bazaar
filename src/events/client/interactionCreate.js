/**
 * Interaction Create Event Handler
 * Routes slash commands and buttons to their respective handlers
 */

const { MessageFlags, InteractionType } = require('discord.js');
const logger = require('../../utils/logger');

/** Enums arrive as numbers; a log line saying "2" helps nobody. */
const TYPE_NAME = Object.fromEntries(
    Object.entries(InteractionType).filter(([, v]) => typeof v === 'number').map(([k, v]) => [v, k]));

module.exports = {
    name: 'interactionCreate',
    async execute(interaction, client) {
        // Every interaction announces itself before any branching. Without
        // this, an interaction that arrives and matches no branch below is
        // indistinguishable in the logs from one that never arrived at all,
        // and those two have completely different causes: the first is a bug
        // in here, the second is Discord not delivering to the gateway.
        logger.info('[INTERACTION] Received', {
            type: TYPE_NAME[interaction.type] ?? interaction.type,
            name: interaction.commandName ?? interaction.customId ?? null,
            userId: interaction.user?.id,
            guildId: interaction.guildId,
        });

        // Context-menu entries ("right click a user, Apps, Lookup") are
        // commands too, but they are not chat input commands. Without this
        // they fell past every branch below and the user was told the button
        // had expired.
        if (interaction.isChatInputCommand() || interaction.isContextMenuCommand()) {
            const { commands } = client;
            const { commandName } = interaction;
            const command = commands.get(commandName);

            if (!command) {
                // Returning silently here left the command spinning in the
                // client forever, which looks identical to a hung bot and
                // names nothing. Discord offers a command the bot does not
                // know only when registration and the loaded set have drifted
                // apart, so say that out loud instead.
                logger.warn('Unknown command attempted', { commandName, userId: interaction.user.id });
                try {
                    await interaction.reply({
                        content: `\`/${commandName}\` is registered with Discord but is not loaded in the bot `
                            + 'right now, so nothing can answer it. This is a bot-side fault, not your doing; '
                            + 'the boot logs name the file that failed.',
                        flags: MessageFlags.Ephemeral,
                    });
                } catch (error) {
                    logger.error('Could not answer an unknown command', { commandName, error: error.message });
                }
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
                        // Do not assert it expired: collectors live in memory,
                        // so a deploy kills every live game mid-hand and the
                        // button dies seconds old. Claiming it timed out sends
                        // the owner hunting a cooldown bug that is not there.
                        content: 'That one\'s dead. Either it timed out, or the bot restarted and forgot '
                            + 'the game (a deploy does that). Run the command again.',
                        flags: MessageFlags.Ephemeral,
                    });
                } catch {
                    // The token may have expired or a collector acked mid-flight; nothing to salvage.
                }
            }, 2500);
            // Fires at most once; unref so a pending timer never holds the process open.
            fallbackTimer.unref();
        } else {
            // Autocomplete and modal submissions land here. Neither is used
            // yet, but silently dropping an interaction type is precisely the
            // failure that looks like a hung bot, so it gets said out loud.
            logger.warn('[INTERACTION] No branch handled this', {
                type: TYPE_NAME[interaction.type] ?? interaction.type,
            });
        }
    }
};
