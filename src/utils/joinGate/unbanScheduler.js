// src/utils/joinGate/unbanScheduler.js
/**
 * Join Gate: automatic lifting of escalation temp-bans.
 *
 * The gate promises, in writing, that a temp-ban lifts the moment the account
 * is old enough. That promise has to survive a redeploy, a threshold change,
 * and the gate being switched off afterwards, so pending unbans live in the
 * database and this scheduler runs unconditionally, never consulting
 * `join_gate_settings.enabled`.
 *
 * Structure mirrors warnReminderScheduler.js: one timer for the next due row,
 * re-armed after every dispatch.
 */

const { SnowflakeUtil } = require('discord.js');
const { pool } = require('../db');
const logger = require('../logger');
const { getSettings } = require('./config');
const { logUnban } = require('./logging');

/** setTimeout saturates around 24.8 days; stay clear of it. */
const MAX_TIMEOUT_MS = 24 * 24 * 60 * 60 * 1000;
/** Discard attempt rows nobody has touched in this long. */
const ATTEMPT_RETENTION_MS = 90 * 86_400_000;

let schedulerTimer = null;
let scheduling = false;
let clientRef = null;

// ── DB helpers ──────────────────────────────────────────────────────────────

/**
 * @param {'age'|'timed'} kind 'age' bans are re-derived when the owner edits
 *   the age threshold; 'timed' bans are fixed cooldowns that must survive
 *   threshold edits untouched. On conflict the earlier unban wins, and the
 *   kind follows whichever date won so a timed ban can never be reclassified
 *   into a recomputable one by a later age-gate row (or vice versa).
 */
async function insertPendingUnban(guildId, userId, unbanAtMs, kind = 'age') {
    await pool.query(
        `INSERT INTO join_gate_pending_unbans (guild_id, user_id, unban_at_ms, banned_at_ms, kind)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET
            unban_at_ms  = LEAST(join_gate_pending_unbans.unban_at_ms, EXCLUDED.unban_at_ms),
            banned_at_ms = EXCLUDED.banned_at_ms,
            kind = CASE WHEN EXCLUDED.unban_at_ms <= join_gate_pending_unbans.unban_at_ms
                        THEN EXCLUDED.kind ELSE join_gate_pending_unbans.kind END`,
        [guildId, userId, String(Math.round(unbanAtMs)), String(Date.now()), kind]
    );
}

async function fetchNextPendingUnban() {
    const { rows } = await pool.query(
        `SELECT guild_id, user_id, unban_at_ms, banned_at_ms
         FROM join_gate_pending_unbans ORDER BY unban_at_ms ASC LIMIT 1`
    );
    return rows[0] || null;
}

async function refetchPendingUnban(guildId, userId) {
    const { rows } = await pool.query(
        `SELECT guild_id, user_id, unban_at_ms, banned_at_ms
         FROM join_gate_pending_unbans WHERE guild_id = $1 AND user_id = $2 LIMIT 1`,
        [guildId, userId]
    );
    return rows[0] || null;
}

async function deletePendingUnban(guildId, userId) {
    await pool.query(
        'DELETE FROM join_gate_pending_unbans WHERE guild_id = $1 AND user_id = $2',
        [guildId, userId]
    );
}

async function getPendingUnbans(guildId) {
    const { rows } = await pool.query(
        `SELECT guild_id, user_id, unban_at_ms, banned_at_ms, kind
         FROM join_gate_pending_unbans WHERE guild_id = $1 ORDER BY unban_at_ms ASC`,
        [guildId]
    );
    return rows;
}

/**
 * Re-derives every pending unban against a new threshold.
 *
 * Only ever shortens a ban. Raising the threshold must not silently extend a
 * punishment someone was already told the end date of; that would make the
 * DM a lie after the fact.
 *
 * The account creation time comes straight out of the snowflake, so this needs
 * no API calls and works even for users the bot can no longer see.
 *
 * @returns {Promise<number>} number of rows shortened
 */
async function recomputePendingUnbans(guildId, newThresholdMs) {
    const rows = await getPendingUnbans(guildId);
    let shortened = 0;

    for (const row of rows) {
        // Timed bans are fixed cooldowns from the moment of the ban; the age
        // threshold has nothing to say about them. Recomputing one against
        // account age would date the unban in the past and release it.
        if (row.kind === 'timed') continue;
        let createdAt;
        try {
            createdAt = Number(SnowflakeUtil.timestampFrom(row.user_id));
        } catch {
            continue;
        }
        const candidate = createdAt + newThresholdMs;
        if (candidate < Number(row.unban_at_ms)) {
            await pool.query(
                `UPDATE join_gate_pending_unbans SET unban_at_ms = $3
                 WHERE guild_id = $1 AND user_id = $2`,
                [row.guild_id, row.user_id, String(Math.round(candidate))]
            );
            shortened++;
        }
    }

    if (shortened > 0 && clientRef) {
        scheduleNext(clientRef).catch(e => logger.error('[JOIN-GATE] reschedule failed', { error: e.message }));
    }
    return shortened;
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Lifts one ban. Treats "already not banned" as success: the owner unbanning
 * by hand is a perfectly normal way for a pending row to become obsolete.
 */
async function dispatchUnban(client, row) {
    const guild = await client.guilds.fetch(row.guild_id).catch(() => null);
    if (!guild) {
        // Bot is no longer in the guild, so the row can never be actioned.
        logger.warn('[JOIN-GATE] Dropping pending unban for unreachable guild', { guildId: row.guild_id });
        await deletePendingUnban(row.guild_id, row.user_id);
        return;
    }

    let ok = false;
    let error = null;
    try {
        await guild.bans.remove(row.user_id, 'Join gate: account is now old enough');
        ok = true;
    } catch (err) {
        // 10026 Unknown Ban: already lifted elsewhere. Nothing to report.
        if (err?.code === 10026) {
            ok = true;
        } else {
            error = err.message;
            logger.error('[JOIN-GATE] Unban failed', {
                guildId: row.guild_id, userId: row.user_id, error: err.message, code: err.code,
            });
        }
    }

    await deletePendingUnban(row.guild_id, row.user_id);

    try {
        const settings = await getSettings(row.guild_id);
        await logUnban(guild, settings, {
            userId: row.user_id,
            bannedAtMs: Number(row.banned_at_ms),
            ok,
            error,
        });
    } catch (err) {
        logger.warn('[JOIN-GATE] Unban logging failed', { error: err.message });
    }
}

async function scheduleNext(client) {
    if (scheduling) return;
    scheduling = true;
    try {
        const next = await fetchNextPendingUnban();
        if (schedulerTimer) { clearTimeout(schedulerTimer); schedulerTimer = null; }
        if (!next) { scheduling = false; return; }

        const delay = Math.max(0, Number(next.unban_at_ms) - Date.now());
        const actualDelay = Math.min(delay, MAX_TIMEOUT_MS);
        logger.debug('[JOIN-GATE] Next unban check', {
            guildId: next.guild_id, userId: next.user_id, inHours: (actualDelay / 3_600_000).toFixed(2),
        });

        schedulerTimer = setTimeout(async () => {
            try {
                // Re-read: the row may have been shortened, lifted manually, or removed.
                const again = await refetchPendingUnban(next.guild_id, next.user_id);
                if (again && Number(again.unban_at_ms) <= Date.now()) {
                    await dispatchUnban(client, again);
                }
            } catch (err) {
                logger.error('[JOIN-GATE] Unban dispatch error', { error: err.message });
            } finally {
                scheduling = false;
                scheduleNext(client).catch(e =>
                    logger.error('[JOIN-GATE] scheduleNext error', { error: e.message }));
            }
        }, actualDelay);

        scheduling = false;
    } catch (error) {
        logger.error('[JOIN-GATE] scheduleNext failed', { error: error.message });
        scheduling = false;
        setTimeout(() => scheduleNext(client).catch(() => {}), 10_000);
    }
}

/** Housekeeping for rejoin counters nobody will ever look at again. */
async function pruneStaleAttempts() {
    try {
        const cutoff = String(Date.now() - ATTEMPT_RETENTION_MS);
        const { rowCount } = await pool.query(
            'DELETE FROM join_gate_attempts WHERE last_seen_ms < $1', [cutoff]
        );
        if (rowCount > 0) logger.info('[JOIN-GATE] Pruned stale attempt rows', { rowCount });
    } catch (error) {
        logger.warn('[JOIN-GATE] Attempt pruning failed', { error: error.message });
    }
}

async function initUnbanScheduler(client) {
    if (clientRef) return;
    clientRef = client;
    await pruneStaleAttempts();
    await scheduleNext(clientRef);
}

module.exports = {
    initUnbanScheduler,
    scheduleNext,
    insertPendingUnban,
    deletePendingUnban,
    getPendingUnbans,
    recomputePendingUnbans,
};
