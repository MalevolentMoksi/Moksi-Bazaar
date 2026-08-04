// src/web/queries.js
/**
 * Read-only queries the dashboard needs and nothing else needs.
 *
 * Kept out of db.js on purpose: that file is the bot's data layer, and page
 * queries (LIMIT/OFFSET lists, filtered counts) would bloat it with functions
 * no command ever calls. Everything here is a SELECT; the dashboard's writes
 * go through joinGate/config.updateSettings like every other writer.
 */

const { pool } = require('../utils/db');

const clampLimit = (n, max = 100) => Math.min(max, Math.max(1, Number(n) || 25));
const clampOffset = n => Math.max(0, Number(n) || 0);

/** Most recent moderation actions, whole guild, newest first. */
async function recentModActions(guildId, { limit = 25, offset = 0, action = null, actorId = null, targetId = null, search = null } = {}) {
    const where = ['guild_id = $1'];
    const values = [guildId];

    if (action) { values.push(action); where.push(`action = $${values.length}`); }
    if (actorId) { values.push(actorId); where.push(`actor_id = $${values.length}`); }
    if (targetId) { values.push(targetId); where.push(`target_id = $${values.length}`); }
    if (search) {
        values.push(`%${search}%`);
        const like = `$${values.length}`;
        let clause = `(target_tag ILIKE ${like} OR actor_tag ILIKE ${like} OR reason ILIKE ${like}`;
        if (/^\d{17,20}$/.test(search)) {
            values.push(search);
            clause += ` OR target_id = $${values.length} OR actor_id = $${values.length}`;
        }
        where.push(clause + ')');
    }

    values.push(clampLimit(limit), clampOffset(offset));
    const { rows } = await pool.query(
        `SELECT id, audit_id, action, target_id, target_tag, actor_id, actor_tag, actor_is_bot, reason, at_ms,
                COUNT(*) OVER()::int AS total
           FROM mod_actions
          WHERE ${where.join(' AND ')}
          ORDER BY at_ms DESC
          LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values
    );
    return { rows, total: rows[0]?.total ?? 0 };
}

/** Actions per type, for filter chips with honest counts on them. */
async function modActionBreakdown(guildId) {
    const { rows } = await pool.query(
        `SELECT action, COUNT(*)::int AS count
           FROM mod_actions WHERE guild_id = $1
          GROUP BY action ORDER BY count DESC`,
        [guildId]
    );
    return rows;
}

/** Warns, newest first, optionally for one user. */
async function recentWarns(guildId, { limit = 25, offset = 0, userId = null, search = null } = {}) {
    const values = [guildId];
    const where = ['guild_id = $1'];
    if (userId) { values.push(userId); where.push(`user_id = $${values.length}`); }
    if (search) {
        values.push(`%${search}%`);
        const like = `$${values.length}`;
        let clause = `(user_label ILIKE ${like} OR moderator ILIKE ${like} OR reason ILIKE ${like}`;
        if (/^\d{17,20}$/.test(search)) {
            values.push(search);
            clause += ` OR user_id = $${values.length}`;
        }
        where.push(clause + ')');
    }
    values.push(clampLimit(limit), clampOffset(offset));
    const { rows } = await pool.query(
        `SELECT id, user_id, user_label, case_id, moderator, reason, source, created_at_ms,
                COUNT(*) OVER()::int AS total
           FROM warns
          WHERE ${where.join(' AND ')}
          ORDER BY created_at_ms DESC
          LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values
    );
    return { rows, total: rows[0]?.total ?? 0 };
}

/** Member activity, sortable, searchable by ID. */
async function memberActivity(guildId, { limit = 50, offset = 0, sort = 'last', userId = null } = {}) {
    const ORDER = {
        last: 'last_message_ms DESC',
        first: 'first_message_ms ASC',
        most: 'message_count DESC',
        least: 'message_count ASC',
    };
    const values = [guildId];
    let where = 'guild_id = $1';
    if (userId) { values.push(userId); where += ` AND user_id = $${values.length}`; }
    values.push(clampLimit(limit), clampOffset(offset));
    const { rows } = await pool.query(
        `SELECT user_id, message_count, first_message_ms, last_message_ms,
                COUNT(*) OVER()::int AS total
           FROM member_activity
          WHERE ${where}
          ORDER BY ${ORDER[sort] ?? ORDER.last}
          LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values
    );
    return { rows, total: rows[0]?.total ?? 0 };
}

/** One member's activity row, or null. */
async function memberActivityOne(guildId, userId) {
    const { rows } = await pool.query(
        'SELECT user_id, message_count, first_message_ms, last_message_ms FROM member_activity WHERE guild_id = $1 AND user_id = $2',
        [guildId, userId]
    );
    return rows[0] ?? null;
}

/** Join-gate rejoin attempts for a member (drives escalation). */
async function gateAttempts(guildId, userId) {
    const { rows } = await pool.query(
        'SELECT attempts, first_seen_ms, last_seen_ms, last_dm_ms FROM join_gate_attempts WHERE guild_id = $1 AND user_id = $2',
        [guildId, userId]
    );
    return rows[0] ?? null;
}

/** Pending temp-unbans, soonest first. */
async function pendingUnbans(guildId, { limit = 25 } = {}) {
    const { rows } = await pool.query(
        `SELECT user_id, unban_at_ms, kind FROM join_gate_pending_unbans
          WHERE guild_id = $1 ORDER BY unban_at_ms ASC LIMIT $2`,
        [guildId, clampLimit(limit)]
    );
    return rows;
}

module.exports = {
    recentModActions,
    modActionBreakdown,
    recentWarns,
    memberActivity,
    memberActivityOne,
    gateAttempts,
    pendingUnbans,
};
