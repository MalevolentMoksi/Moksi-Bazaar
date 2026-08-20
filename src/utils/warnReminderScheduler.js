const { pool } = require('./db');
const { randomUUID } = require('crypto');

const WARN_REMINDER_DAYS = 30;
const MAX_TIMEOUT_MS = 24 * 24 * 60 * 60 * 1000;

/**
 * Delivery failure handling. A reminder that cannot be sent used to retry at
 * full speed forever: the row was only deleted on the success path, so a
 * failed send rescheduled against a still-overdue row, computed a delay of
 * zero, and went again. Two queries, a channel fetch and a rejected send per
 * iteration, until the process died or the channel came back.
 *
 * Now a failed delivery pushes the row's due date forward (persisted, so a
 * restart does not resume the hot loop), backing off up to six hours, and
 * after enough attempts the reminder is dropped WITH a log line saying whose
 * reminder was lost and where it could not be delivered. The silent version
 * of that drop was the other bug.
 */
const RETRY_BASE_MS = 5 * 60_000;
const RETRY_MAX_MS = 6 * 60 * 60_000;
const MAX_DELIVERY_ATTEMPTS = 8;
/** reminder id -> failed sends this process. In-memory: a restart just re-earns them. */
const deliveryFailures = new Map();

let schedulerTimer = null;
let schedulerScheduling = false;
let clientRef = null;

// ---- DB helpers ----------------------------------------------------------------

async function insertWarnReminder(channelId, guildId, warnedUser, dueAtMs, warnId = null, userId = null) {
    const id = randomUUID();
    await pool.query(
        `INSERT INTO warn_reminders (id, channel_id, guild_id, warned_user, warn_ids, warn_count, due_at_utc_ms, created_at_utc_ms, user_id)
         VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8)`,
        [id, channelId, guildId, warnedUser, warnId || null, String(dueAtMs), String(Date.now()), userId || null]
    );
    return id;
}

/**
 * The recent reminder a fresh warn should coalesce onto, if any.
 *
 * Scoped to the guild: matching on the display name alone meant two people
 * with the same name in different servers could share one reminder, with the
 * second warn silently folded into the wrong server's message.
 */
async function findRecentWarnReminderForUser(warnedUser, guildId, windowMs = 60_000) {
    const cutoff = String(Date.now() - windowMs);
    const { rows } = await pool.query(
        `SELECT id, warn_count FROM warn_reminders
         WHERE warned_user = $1 AND guild_id = $2 AND created_at_utc_ms > $3
         ORDER BY created_at_utc_ms DESC LIMIT 1`,
        [warnedUser, guildId, cutoff]
    );
    return rows[0] || null;
}

async function appendWarnToReminder(id, warnId, userId = null) {
    await pool.query(
        `UPDATE warn_reminders
         SET warn_count = warn_count + 1,
             warn_ids = CASE
                WHEN $2::TEXT IS NULL THEN warn_ids
                WHEN warn_ids IS NULL THEN $2
                ELSE warn_ids || ',' || $2
             END,
             -- A later warn may resolve an account the first one could not.
             user_id = COALESCE(warn_reminders.user_id, $3)
         WHERE id = $1`,
        [id, warnId || null, userId || null]
    );
}

async function fetchNextWarnReminder() {
    const { rows } = await pool.query(`
        SELECT id, channel_id, guild_id, warned_user, warn_ids, warn_count, due_at_utc_ms, user_id
        FROM warn_reminders ORDER BY due_at_utc_ms ASC LIMIT 1
    `);
    return rows[0] || null;
}

async function refetchWarnReminderById(id) {
    const { rows } = await pool.query(
        `SELECT id, channel_id, guild_id, warned_user, warn_ids, warn_count, due_at_utc_ms, user_id
         FROM warn_reminders WHERE id = $1 LIMIT 1`, [id]
    );
    return rows[0] || null;
}

async function deleteWarnReminder(id) {
    await pool.query(`DELETE FROM warn_reminders WHERE id = $1`, [id]);
}

async function getAllWarnReminders(guildId = null) {
    const { rows } = await pool.query(
        `SELECT id, channel_id, guild_id, warned_user, warn_ids, warn_count, due_at_utc_ms, created_at_utc_ms, user_id
         FROM warn_reminders
         WHERE ($1::text IS NULL OR guild_id = $1)
         ORDER BY due_at_utc_ms ASC`,
        [guildId]
    );
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

/** @returns {Promise<boolean>} whether the reminder actually reached the channel. Never throws. */
async function sendWarnReminderMessage(client, reminder) {
    const channel = await client.channels.fetch(reminder.channel_id).catch(() => null);
    if (!channel) {
        console.warn(`[WARN-REMINDER] Channel ${reminder.channel_id} unavailable for ${reminder.warned_user}'s reminder`);
        return false;
    }
    try {
        await channel.send(buildReminderText(reminder));
        return true;
    } catch (err) {
        console.warn(`[WARN-REMINDER] Could not deliver to ${reminder.channel_id}: ${err.message}`);
        return false;
    }
}

/** Pushes a reminder's due date forward, persisted so a restart cannot resume a hot loop. */
async function deferWarnReminder(id, delayMs) {
    await pool.query(
        'UPDATE warn_reminders SET due_at_utc_ms = $2 WHERE id = $1',
        [id, String(Date.now() + delayMs)]
    );
}

/**
 * Whether the person a reminder is about is still in the server.
 *
 * Answered at FIRE time, never at warn time, because the whole point is that
 * membership moves: somebody can be warned, leave, and come back inside the
 * thirty days, and only the state at the moment of reminding matters.
 *
 * Three-valued on purpose. `null` means unknowable, and unknowable is not the
 * same as absent: a reminder from before ids were recorded, an intent
 * problem, or a network blip must never be read as "they left". The caller
 * sends on null, because a reminder about somebody who has gone is a minor
 * annoyance and a dropped reminder about somebody still here is the failure
 * this whole feature exists to prevent.
 *
 * @returns {Promise<boolean|null>} true present, false gone, null unknowable
 */
async function isStillPresent(client, reminder) {
    // No resolved account, no answer. Guessing from the display name is how a
    // rename or a lookup miss would silently bin somebody's reminder.
    if (!reminder.user_id) return null;

    const guild = await client.guilds?.fetch?.(reminder.guild_id).catch(() => null);
    if (!guild) return null;

    try {
        const member = await guild.members.fetch({ user: reminder.user_id, force: false });
        return Boolean(member);
    } catch (error) {
        // 10007 Unknown Member: they are not in this guild. 10013 Unknown
        // User: the account is gone entirely. Both mean nobody to remind.
        if (error?.code === 10007 || error?.code === 10013) return false;
        console.warn(`[WARN-REMINDER] Could not check membership for ${reminder.user_id}: ${error.message}`);
        return null;
    }
}

/**
 * One due reminder: delivered and deleted, or dropped because the person it
 * is about has left, or deferred with backoff, or (after enough failures)
 * dropped with a log line naming what was lost.
 */
async function deliverDueReminder(client, reminder) {
    // Before anything is sent. A reminder to consider clearing somebody's
    // warning is pointless once they are not in the server to have one, and
    // staff answering it with "he left, its okay" is the reminder doing work
    // for nobody.
    const present = await isStillPresent(client, reminder);
    if (present === false) {
        console.log(
            `[WARN-REMINDER] Dropping ${reminder.warned_user}'s reminder: `
            + `they are no longer in ${reminder.guild_id}`
        );
        deliveryFailures.delete(reminder.id);
        await deleteWarnReminder(reminder.id);
        return;
    }

    const delivered = await sendWarnReminderMessage(client, reminder);
    if (delivered) {
        deliveryFailures.delete(reminder.id);
        await deleteWarnReminder(reminder.id);
        return;
    }

    const failures = (deliveryFailures.get(reminder.id) ?? 0) + 1;
    deliveryFailures.set(reminder.id, failures);
    if (failures >= MAX_DELIVERY_ATTEMPTS) {
        console.error(
            `[WARN-REMINDER] Giving up on ${reminder.warned_user}'s reminder after `
            + `${failures} failed deliveries to channel ${reminder.channel_id}`
        );
        deliveryFailures.delete(reminder.id);
        await deleteWarnReminder(reminder.id);
        return;
    }

    const backoff = Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
    console.warn(`[WARN-REMINDER] Delivery failed (${failures}), retrying in ${Math.round(backoff / 60_000)}m`);
    await deferWarnReminder(reminder.id, backoff);
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
                    await deliverDueReminder(client, again);
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
    // Exported so the tests can pin the backoff: a reminder that cannot be
    // sent must never become a full-speed retry loop again.
    deliverDueReminder,
    // And so they can pin that "unknowable" is never treated as "left".
    isStillPresent,
};
