// src/utils/interactionAck.js
/**
 * Acknowledge Discord before doing anything that costs the user something.
 *
 * Discord invalidates an interaction token three seconds after it is created.
 * Several commands ran a database round trip first and replied second, which
 * on a slow query produced the worst combination available: the bet already
 * deducted or the cooldown already spent, and the player looking at "This
 * interaction failed" with nothing to show for it. Acknowledging first costs
 * one API call and removes the whole class of failure.
 *
 * The wrinkle is visibility. A deferred reply's public-or-private choice is
 * fixed at defer time and cannot be changed afterwards, but these commands
 * answer publicly on success and privately on refusal ("you only have $12").
 * So the refusal path deletes the public placeholder and follows up
 * privately, which lands exactly where the old ephemeral reply did.
 */

const { MessageFlags } = require('discord.js');
const logger = require('./logger');

/** Accepts the string-or-payload shape every call site already uses. */
function toPayload(content) {
    return typeof content === 'string' ? { content } : { ...content };
}

/**
 * Claims the interaction before any slow work. Safe to call twice.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function ackPublic(interaction) {
    if (interaction.replied || interaction.deferred) return;
    try {
        await interaction.deferReply();
    } catch (error) {
        // Already dead, or Discord refused. The command can still try to
        // answer; there is nothing useful to do here but say so.
        logger.warn('Could not acknowledge interaction', {
            commandName: interaction.commandName, error: error.message,
        });
    }
}

/** The public answer, whichever way the interaction was acknowledged. */
async function replyPublic(interaction, content) {
    const payload = toPayload(content);
    if (interaction.deferred && !interaction.replied) {
        // editReply hands back the message unconditionally; the flag only
        // means anything on reply(), and call sites still pass it.
        delete payload.fetchReply;
        return interaction.editReply(payload);
    }
    if (interaction.replied) return interaction.followUp(payload);
    return interaction.reply(payload);
}

/**
 * The private answer: refusals stay between the bot and the player, even when
 * the interaction was already acknowledged publicly.
 */
async function replyPrivate(interaction, content) {
    const payload = toPayload(content);
    payload.flags = MessageFlags.Ephemeral;

    if (interaction.deferred && !interaction.replied) {
        try {
            // The placeholder is public; it cannot become private, so it goes.
            await interaction.deleteReply();
            return await interaction.followUp(payload);
        } catch (error) {
            logger.debug('Private follow-up failed, answering in place', { error: error.message });
            // The flag is ignored on an edit, so this is public. Still better
            // than the player getting no answer at all.
            delete payload.flags;
            return interaction.editReply(payload).catch(() => null);
        }
    }
    if (interaction.replied) return interaction.followUp(payload);
    return interaction.reply(payload);
}

module.exports = { ackPublic, replyPublic, replyPrivate };
