// src/utils/telemetry.js
/**
 * Full-pipeline observability for the conversation system.
 *
 * Every reply becomes a TRACE; every model call, vision pass and media
 * sampling job inside it becomes a CALL row tied to that trace. Two days
 * later the whole thing exports as CSVs and gets handed to an analyst (me),
 * which shapes every decision here:
 *
 *  - Context travels by AsyncLocalStorage, not parameters. speak.execute
 *    wraps its body in runWithTrace() and everything it awaits, however
 *    deeply nested (a vision call inside a media describe inside the context
 *    builder), attaches itself to the right trace with no plumbing. Code
 *    OUTSIDE a trace logs nothing, which is also the scope control: casino
 *    heckles do not pass through here because nothing wraps them.
 *  - Inputs are stored once per trace, keyed by hash. The three drafts
 *    receive byte-identical prompts; storing them three times would triple
 *    the table for zero information.
 *  - Every row carries the git version that produced it (Railway exposes the
 *    commit SHA), so pre-fix and post-fix behaviour can never be confused.
 *  - Writes are fire-and-forget and failure-silent: telemetry must never
 *    slow down or take down a reply. Enabled by default; the switch lives in
 *    speak_config under 'telemetry'.
 *  - Pruning keeps the newest TELEMETRY_MAX_TRACES traces. Rated traces are
 *    exempt: the owner's verdicts are the most valuable rows in the system.
 *
 * db.js is required lazily inside functions: db.js itself logs vision calls
 * through this module, and a top-level mutual require would land one of the
 * two half-initialised.
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const logger = require('./logger');

const als = new AsyncLocalStorage();

const TELEMETRY_MAX_TRACES = 1000;
const VERSION = (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || 'local';

let dbModule = null;
function getDb() {
    if (!dbModule) dbModule = require('./db');
    return dbModule;
}

async function isEnabled() {
    try {
        const cfg = await getDb().getSpeakConfigValue('telemetry', { enabled: true });
        return cfg?.enabled !== false;
    } catch {
        return false;
    }
}

// ── TRACE CONTEXT ───────────────────────────────────────────────────────────

function currentTrace() {
    return als.getStore() ?? null;
}

/**
 * Runs fn inside a new trace. Everything async that fn starts, awaited or
 * fire-and-forget, inherits the trace through the async context.
 *
 * @param {{kind?: string, userId?: string, channelId?: string, trigger?: string, startedAt?: number}} meta
 */
function runWithTrace(meta, fn) {
    const trace = {
        id: crypto.randomUUID(),
        startedAt: meta.startedAt ?? Date.now(),
        meta: { ...meta },
        rowReady: null,
    };
    return als.run(trace, () => fn(trace));
}

/**
 * Enters a new trace for the REMAINDER of the current async flow, without
 * wrapping it in a closure. Used by speak.execute, whose 300-line body would
 * otherwise need reindenting into a callback. The context does continue into
 * the caller after execute returns; nothing there makes model calls, and any
 * later enterTrace simply replaces the store. finishTrace() is still the
 * explicit end of the story either way.
 */
function enterTrace(meta) {
    const trace = {
        id: crypto.randomUUID(),
        startedAt: meta.startedAt ?? Date.now(),
        meta: { ...meta },
        rowReady: null,
    };
    als.enterWith(trace);
    return trace;
}

/** Idempotent, memoised per trace: calls can insert in any order after it. */
function ensureTraceRow(trace) {
    if (!trace.rowReady) {
        trace.rowReady = getDb().pool.query(
            `INSERT INTO telemetry_traces (trace_id, kind, version, user_id, channel_id, trigger, started_at_ms)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (trace_id) DO NOTHING`,
            [
                trace.id,
                trace.meta.kind ?? 'reply',
                VERSION,
                trace.meta.userId ?? null,
                trace.meta.channelId ?? null,
                trace.meta.trigger ?? null,
                trace.startedAt,
            ]
        ).catch(e => logger.debug('[TELEMETRY] trace row failed', { error: e.message }));
    }
    return trace.rowReady;
}

// ── SERIALISATION ───────────────────────────────────────────────────────────

/**
 * Model inputs as readable text. Vision parts carrying data URIs (a sampled
 * video frame is ~100KB of base64) are replaced with a small placeholder:
 * the analyst needs to know an image was there, not its bytes.
 */
function serializeInput(input) {
    if (input == null) return null;
    if (typeof input === 'string') return input;
    if (!Array.isArray(input)) return String(input);

    const scrubPart = (part) => {
        if (part?.type === 'image_url') {
            const url = String(part.image_url?.url ?? '');
            return url.startsWith('data:')
                ? `[image: inline data, ${url.length} chars]`
                : `[image: ${url}]`;
        }
        if (part?.type === 'text') return part.text;
        return JSON.stringify(part);
    };

    return input.map(m => {
        const content = Array.isArray(m.content)
            ? m.content.map(scrubPart).join('\n')
            : String(m.content ?? '');
        return `[${m.role}]\n${content}`;
    }).join('\n\n');
}

// ── LOGGING ─────────────────────────────────────────────────────────────────

/**
 * Records one call on the current trace. No trace means no row, silently:
 * that is the scope boundary, not an error. Returns the write promise so
 * tests can await it; production callers just drop it.
 */
function logCall({
    kind, model = null, input = null, output = null, latencyMs = null,
    tokensIn = null, tokensOut = null, costUsd = null,
    outcome = 'ok', error = null, extra = null,
}) {
    const trace = currentTrace();
    if (!trace) return Promise.resolve();

    return (async () => {
        try {
            if (!(await isEnabled())) return;
            await ensureTraceRow(trace);

            const { pool } = getDb();
            const inputText = serializeInput(input);
            let inputHash = null;
            if (inputText) {
                inputHash = crypto.createHash('sha256').update(inputText).digest('hex').slice(0, 16);
                await pool.query(
                    `INSERT INTO telemetry_inputs (trace_id, input_hash, input_text)
                     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
                    [trace.id, inputHash, inputText]
                );
            }

            await pool.query(
                `INSERT INTO telemetry_calls
                    (trace_id, at_ms, kind, model, input_hash, output_text, latency_ms,
                     tokens_in, tokens_out, cost_usd, outcome, error, extra)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
                [
                    trace.id, Date.now(), kind, model, inputHash,
                    output != null ? String(output) : null,
                    latencyMs, tokensIn, tokensOut, costUsd,
                    outcome, error != null ? String(error).slice(0, 500) : null,
                    extra ? JSON.stringify(extra) : null,
                ]
            );
        } catch (e) {
            logger.debug('[TELEMETRY] call row dropped', { kind, error: e.message });
        }
    })();
}

/** Closes the current trace with the reply and the pipeline verdicts. */
function finishTrace({
    replyText = null, emojiKey = null, flags = null,
    outcome = 'ok', error = null,
} = {}) {
    const trace = currentTrace();
    if (!trace) return Promise.resolve();
    const totalMs = Date.now() - trace.startedAt;

    return (async () => {
        try {
            if (!(await isEnabled())) return;
            await ensureTraceRow(trace);
            await getDb().pool.query(
                `UPDATE telemetry_traces
                 SET total_ms = $2, reply_text = $3, emoji_key = $4, flags = $5,
                     outcome = $6, error = $7
                 WHERE trace_id = $1`,
                [
                    trace.id, totalMs, replyText, emojiKey,
                    flags ? JSON.stringify(flags) : null,
                    outcome, error != null ? String(error).slice(0, 500) : null,
                ]
            );
        } catch (e) {
            logger.debug('[TELEMETRY] trace finish dropped', { error: e.message });
        }
    })();
}

// ── REVIEW (the dashboard's read and rate surface) ──────────────────────────

/** Newest reply traces with their cost rolled up, for the review list. */
async function reviewData({ limit = 50 } = {}) {
    const { pool } = getDb();
    const { rows } = await pool.query(
        `SELECT t.trace_id, t.version, t.user_id, t.channel_id, t.trigger,
                t.started_at_ms, t.total_ms, t.reply_text, t.outcome,
                t.rating, t.rating_comment, t.judge_wrong_pick,
                COALESCE(SUM(c.cost_usd), 0) AS cost_usd,
                COUNT(c.id)::int AS call_count
         FROM telemetry_traces t
         LEFT JOIN telemetry_calls c ON c.trace_id = t.trace_id
         WHERE t.kind = 'reply'
         GROUP BY t.trace_id
         ORDER BY t.started_at_ms DESC
         LIMIT $1`,
        [limit]
    );
    return rows;
}

/** One trace, all its calls, all its inputs: the drill-down page. */
async function traceDetail(traceId) {
    const { pool } = getDb();
    const [trace, calls, inputs] = await Promise.all([
        pool.query('SELECT * FROM telemetry_traces WHERE trace_id = $1', [traceId]),
        pool.query('SELECT * FROM telemetry_calls WHERE trace_id = $1 ORDER BY at_ms', [traceId]),
        pool.query('SELECT input_hash, input_text FROM telemetry_inputs WHERE trace_id = $1', [traceId]),
    ]);
    if (trace.rows.length === 0) return null;
    return { trace: trace.rows[0], calls: calls.rows, inputs: inputs.rows };
}

/** The owner's verdict. rating: 1 (good), -1 (bad), or null to clear. */
async function rateTrace(traceId, { rating = undefined, comment = undefined, judgeWrongPick = undefined } = {}) {
    const sets = [];
    const params = [traceId];
    const push = (fragment, value) => { params.push(value); sets.push(`${fragment} = $${params.length}`); };

    if (rating !== undefined) {
        if (rating !== null && rating !== 1 && rating !== -1) throw new Error('rating must be 1, -1 or null');
        push('rating', rating);
    }
    if (comment !== undefined) push('rating_comment', comment ? String(comment).slice(0, 1000) : null);
    if (judgeWrongPick !== undefined) push('judge_wrong_pick', Boolean(judgeWrongPick));
    if (sets.length === 0) throw new Error('nothing to rate');
    push('rated_at_ms', Date.now());

    const { rowCount } = await getDb().pool.query(
        `UPDATE telemetry_traces SET ${sets.join(', ')} WHERE trace_id = $1`,
        params
    );
    return rowCount > 0;
}

// ── EXPORT ──────────────────────────────────────────────────────────────────

function csvCell(value) {
    if (value == null) return '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(columns, rows) {
    const lines = [columns.map(csvCell).join(',')];
    for (const row of rows) {
        lines.push(columns.map(col => csvCell(row[col])).join(','));
    }
    return lines.join('\r\n');
}

const TRACE_COLUMNS = [
    'trace_id', 'kind', 'version', 'user_id', 'channel_id', 'trigger',
    'started_at_ms', 'total_ms', 'reply_text', 'emoji_key', 'flags',
    'outcome', 'error', 'rating', 'rating_comment', 'judge_wrong_pick', 'rated_at_ms',
];
const CALL_COLUMNS = [
    'trace_id', 'at_ms', 'kind', 'model', 'input_hash', 'output_text',
    'latency_ms', 'tokens_in', 'tokens_out', 'cost_usd', 'outcome', 'error', 'extra',
];
const INPUT_COLUMNS = ['trace_id', 'input_hash', 'input_text'];

/**
 * The handoff: three CSVs joined by trace_id (and input_hash into inputs).
 * @param {{sinceMs?: number}} opts window start; 0 means everything retained
 * @returns {Promise<{files: Array<{name: string, text: string}>, meta: object}>}
 */
async function exportFiles({ sinceMs = 0 } = {}) {
    const { pool } = getDb();
    const [traces, calls, inputs] = await Promise.all([
        pool.query(
            `SELECT * FROM telemetry_traces WHERE started_at_ms >= $1 ORDER BY started_at_ms`,
            [sinceMs]
        ),
        pool.query(
            `SELECT c.* FROM telemetry_calls c
             JOIN telemetry_traces t ON t.trace_id = c.trace_id
             WHERE t.started_at_ms >= $1 ORDER BY c.at_ms`,
            [sinceMs]
        ),
        pool.query(
            `SELECT i.trace_id, i.input_hash, i.input_text FROM telemetry_inputs i
             JOIN telemetry_traces t ON t.trace_id = i.trace_id
             WHERE t.started_at_ms >= $1`,
            [sinceMs]
        ),
    ]);

    return {
        files: [
            { name: 'traces.csv', text: toCsv(TRACE_COLUMNS, traces.rows) },
            { name: 'calls.csv', text: toCsv(CALL_COLUMNS, calls.rows) },
            { name: 'inputs.csv', text: toCsv(INPUT_COLUMNS, inputs.rows) },
        ],
        meta: { traces: traces.rows.length, calls: calls.rows.length, inputs: inputs.rows.length },
    };
}

/** Headline numbers for the dashboard: last 24 hours plus the rated tally. */
async function reviewStats() {
    const dayAgo = Date.now() - 86_400_000;
    const { rows } = await getDb().pool.query(
        `SELECT
            (SELECT COUNT(*) FROM telemetry_traces
                WHERE kind = 'reply' AND started_at_ms >= $1) AS day_replies,
            (SELECT COALESCE(AVG(total_ms), 0) FROM telemetry_traces
                WHERE kind = 'reply' AND started_at_ms >= $1 AND total_ms IS NOT NULL) AS avg_ms,
            (SELECT COALESCE(SUM(c.cost_usd), 0) FROM telemetry_calls c
                JOIN telemetry_traces t ON t.trace_id = c.trace_id
                WHERE t.started_at_ms >= $1) AS day_cost,
            (SELECT COUNT(*) FROM telemetry_traces
                WHERE rating IS NOT NULL OR rating_comment IS NOT NULL
                   OR judge_wrong_pick IS TRUE) AS rated`,
        [dayAgo]
    );
    const r = rows[0] ?? {};
    return {
        dayReplies: Number(r.day_replies) || 0,
        avgMs: Math.round(Number(r.avg_ms) || 0),
        dayCostUsd: Number(r.day_cost) || 0,
        rated: Number(r.rated) || 0,
    };
}

/** Row counts and rated tally for the settings panel. */
async function telemetryStats() {
    const { rows } = await getDb().pool.query(
        `SELECT
            (SELECT COUNT(*) FROM telemetry_traces) AS traces,
            (SELECT COUNT(*) FROM telemetry_calls) AS calls,
            (SELECT COUNT(*) FROM telemetry_traces WHERE rating IS NOT NULL
                OR rating_comment IS NOT NULL OR judge_wrong_pick IS TRUE) AS rated`
    );
    const r = rows[0] ?? {};
    return { traces: Number(r.traces) || 0, calls: Number(r.calls) || 0, rated: Number(r.rated) || 0 };
}

// ── PRUNE ───────────────────────────────────────────────────────────────────

/**
 * Keeps the newest maxTraces traces; older ones go, EXCEPT anything the owner
 * rated or commented, which is kept forever. Calls and inputs cascade.
 */
async function pruneTelemetry(maxTraces = TELEMETRY_MAX_TRACES) {
    const { rowCount } = await getDb().pool.query(
        `DELETE FROM telemetry_traces
         WHERE rating IS NULL AND rating_comment IS NULL AND judge_wrong_pick IS NOT TRUE
           AND trace_id NOT IN (
               SELECT trace_id FROM telemetry_traces
               ORDER BY started_at_ms DESC LIMIT $1
           )`,
        [maxTraces]
    );
    return rowCount ?? 0;
}

module.exports = {
    TELEMETRY_MAX_TRACES,
    VERSION,
    runWithTrace,
    enterTrace,
    currentTrace,
    logCall,
    finishTrace,
    serializeInput,
    toCsv,
    csvCell,
    reviewData,
    reviewStats,
    traceDetail,
    rateTrace,
    exportFiles,
    telemetryStats,
    pruneTelemetry,
    isEnabled,
};
