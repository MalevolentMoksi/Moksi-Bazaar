const { pool } = require('./db');
const { randomUUID } = require('crypto');

const WARN_REMINDER_DAYS = 30;
const MAX_TIMEOUT_MS = 24 * 24 * 60 * 60 * 1000;
let schedulerTimer = null;
let schedulerScheduling = false;
let clientRef = null;

// ---- DB helpers ----------------------------------------------------------------

async function insertWarnReminder(channelId, guildId, warnedUser, dueAtMs, warnId = null) {
    const id = randomUUID();
    await pool.query(
        `INSERT INTO warn_reminders (id, channel_id, guild_id, warned_user, warn_ids, warn_count, due_at_utc_ms, created_at_utc_ms)
         VALUES ($1,$2,$3,$4,$5,1,$6,$7)`,
        [id, channelId, guildId, warnedUser, warnId || null, String(dueAtMs), String(Date.now())]
    );
    return id;
}

async function findRecentWarnReminderForUser(warnedUser, windowMs = 60_000) {
    const cutoff = String(Date.now() - windowMs);
    const { rows } = await pool.query(
        `SELECT id, warn_count FROM warn_reminders
         WHERE warned_user = $1 AND created_at_utc_ms > $2
         ORDER BY created_at_utc_ms DESC LIMIT 1`,
        [warnedUser, cutoff]
    );
    return rows[0] || null;
}

async function appendWarnToReminder(id, warnId) {
    await pool.query(
        `UPDATE warn_reminders
         SET warn_count = warn_count + 1,
             warn_ids = CASE
                WHEN $2::TEXT IS NULL THEN warn_ids
                WHEN warn_ids IS NULL THEN $2
                ELSE warn_ids || ',' || $2
             END
         WHERE id = $1`,
        [id, warnId || null]
    );
}

async function fetchNextWarnReminder() {
    const { rows } = await pool.query(`
        SELECT id, channel_id, guild_id, warned_user, warn_ids, warn_count, due_at_utc_ms
        FROM warn_reminders ORDER BY due_at_utc_ms ASC LIMIT 1
    `);
    return rows[0] || null;
}

async function refetchWarnReminderById(id) {
    const { rows } = await pool.query(
        `SELECT id, channel_id, guild_id, warned_user, warn_ids, warn_count, due_at_utc_ms
         FROM warn_reminders WHERE id = $1 LIMIT 1`, [id]
    );
    return rows[0] || null;
}

async function deleteWarnReminder(id) {
    await pool.query(`DELETE FROM warn_reminders WHERE id = $1`, [id]);
}

async function getAllWarnReminders() {
    const { rows } = await pool.query(`
        SELECT id, channel_id, guild_id, warned_user, warn_ids, warn_count, due_at_utc_ms, created_at_utc_ms
        FROM warn_reminders ORDER BY due_at_utc_ms ASC
    `);
    return rows;
}

// ---- Messaging -----------------------------------------------------------------

function buildReminderText(reminder) {
    const count = reminder.warn_count || 1;
    const ids = reminder.warn_ids ? reminder.warn_ids.split(',') : [];
    const idText = ids.length ? ` (Case${ids.length > 1 ? 's' : ''} ${ids.map(i => `#${i}`).join(', ')})` : '';

    if (count === 1) {
        return `**Staff reminder:** It has been ${WARN_REMINDER_DAYS} days since **${reminder.warned_user}** was warned${idText}. If the warning is no longer needed, consider removing it with \`?delwarn\`.`;
    }

    return `**Staff reminder:** **${reminder.warned_user}** received ${count} warnings over the past ${WARN_REMINDER_DAYS} days${idText}. Consider reviewing and removing any that are no longer needed with \`?delwarn\`.`;
}

async function sendWarnReminderMessage(client, reminder) {
    const channel = await client.channels.fetch(reminder.channel_id).catch(() => null);
    if (!channel) return;
    await channel.send(buildReminderText(reminder));
}

// ---- Scheduler (mirrors remind.js exactly) ------------------------------------

async function scheduleNext(client) {
    if (schedulerScheduling) return;
    schedulerScheduling = true;
    try {
        const next = await fetchNextWarnReminder();
        if (!next) {
            if (schedulerTimer) { clearTimeout(schedulerTimer); schedulerTimer = null; }
            schedulerScheduling = false;
            return;
        }
        if (schedulerTimer) { clearTimeout(schedulerTimer); schedulerTimer = null; }
        const delay = Math.max(0, Number(next.due_at_utc_ms) - Date.now());
        const actualDelay = Math.min(delay, MAX_TIMEOUT_MS);
        console.log(`[WARN-REMINDER] Next check in ${(actualDelay / 3_600_000).toFixed(2)}h`);
        schedulerTimer = setTimeout(async () => {
            try {
                const again = await refetchWarnReminderById(next.id);
                if (!again) {
                    schedulerScheduling = false;
                    scheduleNext(client).catch(e => console.error('warn scheduleNext error:', e));
                    return;
                }
                if (Number(again.due_at_utc_ms) <= Date.now()) {
                    await sendWarnReminderMessage(client, again);
                    await deleteWarnReminder(again.id);
                } else {
                    console.log('[WARN-REMINDER] Intermediate check - not yet due, re-scheduling');
                }
            } catch (err) {
                console.error('[WARN-REMINDER] Dispatch error:', err);
            } finally {
                schedulerScheduling = false;
                scheduleNext(client).catch(e => console.error('warn scheduleNext error:', e));
            }
        }, actualDelay);
        schedulerScheduling = false;
    } catch (e) {
        console.error('[WARN-REMINDER] scheduleNext failed:', e);
        schedulerScheduling = false;
        setTimeout(() => scheduleNext(client).catch(() => {}), 10_000);
    }
}

async function initWarnReminderScheduler(client) {
    if (clientRef) return;
    clientRef = client;
    await scheduleNext(clientRef);
}

module.exports = {
    WARN_REMINDER_DAYS,
    initWarnReminderScheduler,
    scheduleNext,
    insertWarnReminder,
    findRecentWarnReminderForUser,
    appendWarnToReminder,
    deleteWarnReminder,
    getAllWarnReminders,
};
