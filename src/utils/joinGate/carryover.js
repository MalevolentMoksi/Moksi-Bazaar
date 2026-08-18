// src/utils/joinGate/carryover.js
/**
 * Join Gate: parking the short-term memory across a deploy.
 *
 * restore.js re-derives what Discord still knows at boot: who joined
 * recently, what their profile scores, how the audit log has been moving.
 * Three things it cannot re-derive, because only the dying process ever knew
 * them:
 *
 *   - what each watched member SAID inside their window (the evidence, and
 *     the duplicate / cross-channel history)
 *   - which behaviour signals had already fired, and the score a report had
 *     already gone out at (without it, a deploy re-reports the same member)
 *   - the burst window, so a raid straddling a deploy is one raid
 *
 * On shutdown those are written to one row; on boot they are read back,
 * merged on top of the derived restore, and the row is deleted. Consuming
 * the row is what keeps a stale snapshot from ever being applied twice, and
 * every entry is still filtered through its own window on import, so nothing
 * outlives the lifetime it would have had without the deploy.
 *
 * A crash (SIGKILL, OOM) skips the save. That is acceptable: the derived
 * restore still covers the profile half, and a carry that only works on
 * clean shutdowns still covers every ordinary deploy.
 *
 * IT NEVER ACTS, same rule as restore.js. The queued removals are the one
 * memory deliberately NOT carried: re-removing people on boot is exactly what
 * the opt-in catch-up sweep is for, so the save just says out loud how many
 * were dropped and whether the sweep will catch them.
 */

const { pool } = require('../db');
const logger = require('../logger');
const watch = require('./watch');
const enforcement = require('./enforcement');

const ROW_ID = 'state';
/** A snapshot older than this is from a parked process, not a deploy. */
const MAX_AGE_MS = 24 * 3_600_000;

let tableEnsured = null;
function ensureTable() {
    tableEnsured ??= pool.query(
        `CREATE TABLE IF NOT EXISTS join_gate_carryover (
            id          TEXT PRIMARY KEY,
            payload     JSONB NOT NULL,
            saved_at_ms BIGINT NOT NULL
        )`
    ).catch(error => {
        tableEnsured = null;
        throw error;
    });
    return tableEnsured;
}

/**
 * Writes the current short-term memory. Called from the shutdown path,
 * before the pool closes. Never throws.
 *
 * @returns {Promise<{watched: number, bursts: number, droppedQueue: number}|null>}
 */
async function save() {
    try {
        const watchState = watch.exportState();
        const burstState = enforcement.exportBurstState();
        const watched = Object.values(watchState).reduce((n, e) => n + e.length, 0);
        const bursts = Object.values(burstState).reduce((n, e) => n + e.length, 0);
        const droppedQueue = enforcement.queueDepth();

        if (droppedQueue > 0) {
            logger.warn('[JOIN-GATE] Queued removals dropped by shutdown', {
                droppedQueue,
                note: 'the catch-up sweep re-gates them at boot when sweep_enabled is on',
            });
        }

        await ensureTable();
        if (!watched && !bursts) {
            await pool.query('DELETE FROM join_gate_carryover WHERE id = $1', [ROW_ID]);
            return null;
        }

        await pool.query(
            `INSERT INTO join_gate_carryover (id, payload, saved_at_ms)
             VALUES ($1, $2, $3)
             ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, saved_at_ms = EXCLUDED.saved_at_ms`,
            [ROW_ID, JSON.stringify({ watch: watchState, bursts: burstState }), String(Date.now())]
        );
        return { watched, bursts, droppedQueue };
    } catch (error) {
        logger.warn('[JOIN-GATE] Could not park the short-term memory', { error: error.message });
        return null;
    }
}

/**
 * Reads the parked memory back, merges it, and consumes the row.
 * Runs after restore.restoreAll so it overlays the derived entries.
 *
 * @param {(guildId: string) => number} windowMsFor watch window per guild
 * @returns {Promise<{watched: number, bursts: number}|null>}
 */
async function load(windowMsFor) {
    try {
        await ensureTable();
        const { rows } = await pool.query(
            'SELECT payload, saved_at_ms FROM join_gate_carryover WHERE id = $1', [ROW_ID]
        );
        if (!rows[0]) return null;

        // Consume first: a payload that crashes the import must not get a
        // second attempt on the next boot.
        await pool.query('DELETE FROM join_gate_carryover WHERE id = $1', [ROW_ID]);

        if (Date.now() - Number(rows[0].saved_at_ms) > MAX_AGE_MS) {
            logger.info('[JOIN-GATE] Parked memory too old, discarded');
            return null;
        }

        const payload = rows[0].payload ?? {};
        const result = {
            watched: watch.importState(payload.watch, windowMsFor),
            bursts: enforcement.importBurstState(payload.bursts),
        };
        if (result.watched || result.bursts) {
            logger.info('[JOIN-GATE] Parked memory recovered', result);
        }
        return result;
    } catch (error) {
        logger.warn('[JOIN-GATE] Could not recover parked memory', { error: error.message });
        return null;
    }
}

module.exports = { save, load };
