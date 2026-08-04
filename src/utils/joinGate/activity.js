// src/utils/joinGate/activity.js
/**
 * Join Gate: how much each member has actually said.
 *
 * Membership tenure used to forgive on presence alone. Past the grace window a
 * member got the full damping whether they had been part of the server for a
 * year or had joined, gone quiet, and never come back. A dormant account is the
 * cheaper half of a bulk registration and the whole point of a sleeper, so the
 * rule was rewarding exactly the behaviour it should have been suspicious of.
 *
 * This is the other half of the input. It counts messages and nothing else: no
 * content, no channels, no timestamps beyond first and last seen.
 *
 * Writes are buffered. A busy channel must not become one database round trip
 * per message, and losing a few counts to a restart costs nothing, because the
 * threshold this feeds is deliberately low.
 */

const { pool, getSpeakConfigValue, setSpeakConfigValue } = require('../db');
const logger = require('../logger');

/** `${guildId}:${userId}` -> {guildId, userId, count, first, last} */
const buffer = new Map();

const FLUSH_INTERVAL_MS = 60_000;
let flushTimer = null;
let flushInFlight = false;

/**
 * The moment counting began, cached after the first read.
 *
 * Nobody can be judged on messages from before this, so a member who joined
 * earlier is measured from here rather than from their join date.
 */
const SINCE_KEY = 'member_activity_since';
let sinceMs = null;

async function trackingSince() {
    if (sinceMs !== null) return sinceMs;
    const stored = Number(await getSpeakConfigValue(SINCE_KEY, 0));
    sinceMs = Number.isFinite(stored) && stored > 0 ? stored : 0;
    return sinceMs;
}

/** Stamps the start of tracking the first time anything is ever recorded. */
async function ensureSince(now) {
    if (await trackingSince()) return;
    sinceMs = now;
    await setSpeakConfigValue(SINCE_KEY, now);
    logger.info('[JOIN-GATE] Member activity tracking started', { at: now });
}

/** Buffers one message. Cheap enough to call on every message in the guild. */
function noteMessage(guildId, userId, now = Date.now()) {
    if (!guildId || !userId) return;
    const key = `${guildId}:${userId}`;
    const entry = buffer.get(key);
    if (entry) {
        entry.count++;
        entry.last = now;
    } else {
        buffer.set(key, { guildId, userId, count: 1, first: now, last: now });
    }
    startAutoFlush();
}

async function flush() {
    if (flushInFlight || buffer.size === 0) return 0;
    flushInFlight = true;

    // Take the whole buffer and let new messages accumulate into a fresh one,
    // so a slow write cannot drop counts that arrive while it runs.
    const pending = [...buffer.values()];
    buffer.clear();

    try {
        // reduce, not Math.min(...spread): the buffer can hold thousands of
        // entries after a failed flush, and a spread that wide overflows.
        await ensureSince(pending.reduce((min, e) => (e.first < min ? e.first : min), pending[0].first));
        for (const entry of pending) {
            await pool.query(`
                INSERT INTO member_activity (guild_id, user_id, message_count, first_message_ms, last_message_ms)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (guild_id, user_id) DO UPDATE SET
                    message_count    = member_activity.message_count + EXCLUDED.message_count,
                    first_message_ms = LEAST(member_activity.first_message_ms, EXCLUDED.first_message_ms),
                    last_message_ms  = GREATEST(member_activity.last_message_ms, EXCLUDED.last_message_ms)
            `, [entry.guildId, entry.userId, entry.count, entry.first, entry.last]);
        }
        return pending.length;
    } catch (error) {
        // Put them back rather than losing them, unless the buffer has already
        // grown large, in which case the database is the problem and hoarding
        // rows in memory would only add to it.
        logger.warn('[JOIN-GATE] Activity flush failed', { error: error.message, rows: pending.length });
        if (buffer.size < 5000) {
            for (const entry of pending) {
                const existing = buffer.get(`${entry.guildId}:${entry.userId}`);
                if (existing) {
                    existing.count += entry.count;
                    existing.first = Math.min(existing.first, entry.first);
                    existing.last = Math.max(existing.last, entry.last);
                } else {
                    buffer.set(`${entry.guildId}:${entry.userId}`, entry);
                }
            }
        }
        return 0;
    } finally {
        flushInFlight = false;
    }
}

function startAutoFlush() {
    if (flushTimer) return;
    flushTimer = setInterval(() => {
        flush().catch(e => logger.warn('[JOIN-GATE] Activity auto-flush failed', { error: e.message }));
    }, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
}

function stopAutoFlush() {
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
}

/**
 * Message counts for a whole guild, as a Map of userId -> count.
 *
 * The backtest scores every member at once, so this is one query rather than
 * 1600. Buffered counts not yet written are folded in, so a member who spoke a
 * minute ago is not read back as silent.
 */
async function countsForGuild(guildId) {
    const counts = new Map();
    try {
        const { rows } = await pool.query(
            'SELECT user_id, message_count FROM member_activity WHERE guild_id = $1', [guildId]);
        for (const row of rows) counts.set(row.user_id, Number(row.message_count));
    } catch (error) {
        logger.warn('[JOIN-GATE] Activity read failed', { guildId, error: error.message });
        return counts;
    }
    for (const entry of buffer.values()) {
        if (entry.guildId !== guildId) continue;
        counts.set(entry.userId, (counts.get(entry.userId) ?? 0) + entry.count);
    }
    return counts;
}

/** One member's count, for the single-account paths (/lookup, a live join). */
async function countFor(guildId, userId) {
    const buffered = buffer.get(`${guildId}:${userId}`)?.count ?? 0;
    try {
        const { rows } = await pool.query(
            'SELECT message_count FROM member_activity WHERE guild_id = $1 AND user_id = $2',
            [guildId, userId]);
        return Number(rows[0]?.message_count ?? 0) + buffered;
    } catch (error) {
        logger.warn('[JOIN-GATE] Activity read failed', { guildId, userId, error: error.message });
        return buffered;
    }
}

/** Test seam. */
function reset() {
    buffer.clear();
    sinceMs = null;
    stopAutoFlush();
}

module.exports = {
    noteMessage,
    flush,
    stopAutoFlush,
    trackingSince,
    countsForGuild,
    countFor,
    reset,
    FLUSH_INTERVAL_MS,
};
