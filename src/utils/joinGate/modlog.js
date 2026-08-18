// src/utils/joinGate/modlog.js
/**
 * A durable record of who was banned, kicked or timed out, and by whom.
 *
 * Discord keeps its audit log for 45 days and then throws it away. The other
 * copy of this server's moderation history lives on Dyno's servers. Neither is
 * ours, and neither answers "has this person been in trouble before" a year
 * later, which is exactly when the question gets asked.
 *
 * Read from the audit log, so an action taken through Dyno is captured with
 * Dyno named as the actor. Nothing here is inferred: if Discord does not say
 * who did it, this does not guess.
 *
 * RECORDING, NOT WATCHING. Nothing in this file feeds the guard's thresholds or
 * raises an alert. The guard deliberately does not watch moderation at all, so
 * that clearing out a batch of accounts through Dyno trips nothing; this writes
 * a row and stops.
 */

const { AuditLogEvent } = require('discord.js');
const { recordModAction } = require('../db');
const logger = require('../logger');

/**
 * Turns an audit-log entry into a row, or null when it is not moderation.
 *
 * Timeouts are the awkward one: Discord files them as a generic MemberUpdate
 * and the only thing distinguishing a timeout from a nickname change is a
 * communication_disabled_until key in the changes. A cleared timeout has a null
 * new value, which is a different event worth recording separately.
 */
function describe(entry) {
    switch (entry.action) {
        case AuditLogEvent.MemberBanAdd:
            return { action: 'ban' };
        case AuditLogEvent.MemberBanRemove:
            return { action: 'unban' };
        case AuditLogEvent.MemberKick:
            return { action: 'kick' };
        case AuditLogEvent.MemberUpdate: {
            const change = (entry.changes ?? []).find(c => c.key === 'communication_disabled_until');
            if (!change) return null;
            return { action: change.new ? 'timeout' : 'timeout_cleared', until: change.new ?? null };
        }
        default:
            return null;
    }
}

/**
 * Records an audit entry if it is a moderation action.
 *
 * @returns {Promise<string|null>} the action recorded, or null
 */
async function record(guild, entry) {
    const described = describe(entry);
    if (!described) return null;

    const targetId = entry.targetId ?? entry.target?.id;
    if (!targetId) return null;

    const executor = entry.executor ?? null;
    // The end time always survives. It used to be a fallback for a missing
    // reason, so any timeout that CARRIED a reason lost its duration: the one
    // fact distinguishing a ten-minute mute from a week silently dropped.
    const trimmedReason = `${entry.reason ?? ''}`.trim();
    const reason = described.until
        ? (trimmedReason ? `${trimmedReason} (until ${described.until})` : `timed out until ${described.until}`)
        : entry.reason ?? null;

    try {
        const written = await recordModAction({
            guildId: guild.id,
            auditId: entry.id ?? null,
            action: described.action,
            targetId,
            targetTag: entry.target?.username ?? null,
            actorId: executor?.id ?? entry.executorId ?? null,
            actorTag: executor?.username ?? null,
            actorIsBot: Boolean(executor?.bot),
            reason,
            atMs: entry.createdTimestamp ?? Date.now(),
        });
        if (written) {
            logger.debug('[MODLOG] Recorded', {
                guildId: guild.id, action: described.action, targetId,
                actor: executor?.username ?? entry.executorId ?? 'unknown',
            });
        }
        return described.action;
    } catch (error) {
        // Never let bookkeeping break the guard that runs alongside it.
        logger.warn('[MODLOG] Could not record action', { guildId: guild.id, error: error.message });
        return null;
    }
}

module.exports = { describe, record };
