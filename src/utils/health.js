// src/utils/health.js
//
// What the green dot is supposed to mean.
//
// The bot's presence was `status: 'online'` written as a literal, so the dot
// under its name was green through a dead database, a rejected API key and a
// join gate that could not kick anybody. Every one of those failures was
// discoverable only by opening something: the logs, a settings panel, or a
// user's complaint. The member list is the one surface the owner passes
// without meaning to, so this is what makes it worth glancing at.
//
// The boot report covers the other half: subsystems that never started. This
// covers the ones that started and then stopped working.
//
// Two rules keep it honest:
//
//   'down' is reserved for the bot being unable to do its job at all, which
//   in practice means the database. A silent tweet mirror is annoying; it is
//   not the same class of event, and if everything can turn the dot red then
//   red stops meaning anything.
//
//   A subsystem reports its own state. Nothing here polls a feature to ask if
//   it is alright, because a checker that only runs every minute learns about
//   failures a minute late and invents its own bugs. The one exception is the
//   database, which cannot report a failure to talk.

const logger = require('./logger');

/** Ordered worst-last, so the numbers can be compared directly. */
const STATES = Object.freeze({ ok: 0, degraded: 1, down: 2 });

/**
 * Display names. A key with no entry here prints as itself, so a new
 * subsystem can start reporting without touching this file.
 */
const LABELS = Object.freeze({
    database: 'Database',
    ai: 'AI',
    tweets: 'X mirror',
    joinGate: 'Join gate',
});

/** How long a database probe may hang before it counts as unreachable. */
const PROBE_TIMEOUT_MS = 6_000;

/** key -> {state, detail, sinceMs} */
const subsystems = new Map();

const label = key => LABELS[key] ?? key;

/**
 * Records what a subsystem currently thinks of itself.
 *
 * `sinceMs` survives a repeated report of the same thing, so a poller that
 * complains every ten minutes still yields "unreachable for 40m" rather than
 * resetting the clock and always reading as if it had just broken.
 *
 * @param {string} key
 * @param {'ok'|'degraded'|'down'} state
 * @param {string|null} detail  Short, human, and specific: this is what the
 *                              member list will say out loud.
 */
function report(key, state, detail = null, now = Date.now()) {
    if (!Object.prototype.hasOwnProperty.call(STATES, state)) {
        logger.warn('[HEALTH] Unknown state reported, ignoring', { key, state });
        return;
    }
    const previous = subsystems.get(key);
    const unchanged = previous && previous.state === state && previous.detail === detail;
    subsystems.set(key, {
        state,
        detail: detail ? String(detail).trim() : null,
        sinceMs: unchanged ? previous.sinceMs : now,
    });

    if (!unchanged && previous && previous.state !== state) {
        const line = `[HEALTH] ${label(key)} is ${state}`;
        if (state === 'ok') logger.info(line);
        else logger.warn(line, { detail });
    }
}

/**
 * Everything that is currently wrong, worst first, then longest-standing.
 *
 * @returns {{state: 'ok'|'degraded'|'down',
 *            worst: {key, label, state, detail, sinceMs}|null,
 *            problems: Array<{key, label, state, detail, sinceMs}>}}
 */
function snapshot() {
    const problems = [...subsystems.entries()]
        .filter(([, v]) => v.state !== 'ok')
        .map(([key, v]) => ({ key, label: label(key), ...v }))
        .sort((a, b) => STATES[b.state] - STATES[a.state] || a.sinceMs - b.sinceMs);

    return {
        state: problems.length ? problems[0].state : 'ok',
        worst: problems[0] ?? null,
        problems,
    };
}

/**
 * The database cannot tell us it is unreachable, so it gets asked.
 *
 * A trivial query, capped, once a minute. It is the one dependency with no
 * failure path of its own: every other subsystem finds out it is down by
 * trying to use it, and by then the reply has already failed.
 */
async function probeDatabase(now = Date.now()) {
    // Required here rather than at the top: db.js is the largest module in the
    // codebase and half the test suite mocks it. Nothing that only calls
    // report() should have to drag it in.
    let pool;
    try {
        ({ pool } = require('./db'));
    } catch (error) {
        report('database', 'down', 'module failed to load', now);
        logger.error('[HEALTH] Could not load the database module', { error: error.message });
        return;
    }
    if (!pool?.query) return;

    let timer;
    try {
        await Promise.race([
            pool.query('SELECT 1'),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`no answer in ${PROBE_TIMEOUT_MS / 1000}s`)), PROBE_TIMEOUT_MS);
            }),
        ]);
        report('database', 'ok', null, now);
    } catch (error) {
        report('database', 'down', error.message, now);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Runs the checks that have to be asked for. Never throws: this is called
 * from the presence tick, and a health check that can take the presence loop
 * down with it is worse than no health check.
 */
async function refresh(now = Date.now()) {
    try {
        await probeDatabase(now);
    } catch (error) {
        logger.error('[HEALTH] Probe threw', { error: error.message });
    }
}

/** Tests only. */
function reset() {
    subsystems.clear();
}

module.exports = {
    report,
    snapshot,
    refresh,
    probeDatabase,
    reset,
    STATES,
    LABELS,
    PROBE_TIMEOUT_MS,
};
