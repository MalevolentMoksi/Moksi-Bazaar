// src/utils/janitor.js
/**
 * Periodic housekeeping.
 *
 * db.js has exported cleanupMediaCache() and clearExpiredCooldowns() since the
 * persistence rewrite and nothing ever called them, so the media cache grew
 * without bound and every cooldown row the bot had ever written was still
 * sitting there. Temp files had the same problem on disk: a crashed ffmpeg run
 * leaves its scratch file in os.tmpdir() forever, and on Railway that disk is
 * neither large nor swept between deploys.
 *
 * One timer drives all of it. Every step is best-effort and isolated: a sweep
 * that throws must never take down a bot that is otherwise perfectly healthy,
 * so each one logs its own failure and the cycle continues.
 */

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { pool, cleanupMediaCache, clearExpiredCooldowns } = require('./db');
const { pruneTelemetry } = require('./telemetry');
const logger = require('./logger');

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Delay before the first cycle so it never competes with startup. */
const FIRST_SWEEP_DELAY_MS = 2 * 60 * 1000;
/**
 * Generous on purpose. A long /videodl or a queued render can hold a temp file
 * open for many minutes, and deleting one mid-write is far worse than leaving
 * a few stale megabytes for another hour.
 */
const TEMP_FILE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** Every temp path this bot creates is prefixed; see utils/media/tempFiles.js. */
const TEMP_PREFIX = 'mbazaar_';

let timer = null;
let cycleInFlight = false;

/**
 * Deletes stale scratch files and directories left in the system temp dir.
 * @returns {Promise<{removed: number, bytes: number}>}
 */
async function sweepTempFiles() {
    const dir = os.tmpdir();
    const cutoff = Date.now() - TEMP_FILE_MAX_AGE_MS;
    let removed = 0;
    let bytes = 0;

    let entries;
    try {
        entries = await fs.readdir(dir);
    } catch (error) {
        logger.warn('[JANITOR] Could not read temp dir', { dir, error: error.message });
        return { removed, bytes };
    }

    for (const name of entries) {
        if (!name.startsWith(TEMP_PREFIX)) continue;
        const full = path.join(dir, name);
        try {
            const stat = await fs.stat(full);
            if (stat.mtimeMs > cutoff) continue;
            bytes += stat.isDirectory() ? 0 : stat.size;
            await fs.rm(full, { recursive: true, force: true });
            removed++;
        } catch (error) {
            // ENOENT means something else cleaned it up first, which is fine.
            if (error.code !== 'ENOENT') {
                logger.debug('[JANITOR] Temp entry not removed', { name, error: error.message });
            }
        }
    }

    return { removed, bytes };
}

/**
 * Drops duel rows nobody can act on any more. Both the accept and the decline
 * path filter on `expires_at > NOW()`, so anything past its deadline is dead
 * weight; the extra day of grace is only there so a row is never deleted out
 * from under an interaction that is still resolving.
 * @returns {Promise<number>} rows deleted
 */
async function purgeDeadDuels() {
    const { rowCount } = await pool.query(
        "DELETE FROM pending_duels WHERE expires_at < NOW() - INTERVAL '1 day'"
    );
    return rowCount ?? 0;
}

/** Runs every step, isolating failures so one broken sweep cannot stop the rest. */
async function runJanitorCycle() {
    if (cycleInFlight) {
        logger.debug('[JANITOR] Previous cycle still running, skipping this tick');
        return;
    }
    cycleInFlight = true;
    const startedAt = Date.now();
    const summary = {};

    const steps = [
        ['mediaCache', async () => { await cleanupMediaCache(); return 'ok'; }],
        ['cooldowns', async () => { await clearExpiredCooldowns(); return 'ok'; }],
        ['deadDuels', async () => purgeDeadDuels()],
        // Keeps the newest 1000 telemetry traces; rated ones are immortal.
        ['telemetry', async () => pruneTelemetry()],
        ['tempFiles', async () => {
            const { removed, bytes } = await sweepTempFiles();
            return removed ? `${removed} (${(bytes / 1048576).toFixed(1)} MB)` : 0;
        }],
        // The guard keeps a per-actor counter in memory. Anyone who touched the
        // server once and never again would otherwise sit there for the life of
        // the process.
        ['guardCounters', async () => require('./joinGate/guard').prune()],
    ];

    for (const [name, step] of steps) {
        try {
            summary[name] = await step();
        } catch (error) {
            summary[name] = `failed: ${error.message}`;
            logger.warn('[JANITOR] Step failed', { step: name, error: error.message });
        }
    }

    cycleInFlight = false;
    logger.info('[JANITOR] Cycle complete', { ...summary, ms: Date.now() - startedAt });
}

/** Idempotent: calling it twice does not stack timers. */
function startJanitor() {
    if (timer) return;
    // unref'd throughout: the gateway connection is what keeps this process
    // alive, and a pending sweep should never delay a shutdown.
    const first = setTimeout(() => {
        runJanitorCycle().catch(e => logger.error('[JANITOR] Cycle threw', { error: e.message }));
        timer = setInterval(() => {
            runJanitorCycle().catch(e => logger.error('[JANITOR] Cycle threw', { error: e.message }));
        }, SWEEP_INTERVAL_MS);
        timer.unref();
    }, FIRST_SWEEP_DELAY_MS);
    first.unref();
    timer = first;
    logger.info('[JANITOR] Scheduled', { everyMinutes: SWEEP_INTERVAL_MS / 60000 });
}

function stopJanitor() {
    if (!timer) return;
    clearTimeout(timer);
    clearInterval(timer);
    timer = null;
}

module.exports = {
    startJanitor,
    stopJanitor,
    runJanitorCycle,
    sweepTempFiles,
    purgeDeadDuels,
    TEMP_PREFIX,
    TEMP_FILE_MAX_AGE_MS,
};
