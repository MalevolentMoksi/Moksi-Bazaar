/**
 * Database Module
 * Handles all database operations for balances, user preferences, media caching, and game state
 */

const { Pool, types } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const logger = require('./logger');
const { SENTIMENT_THRESHOLDS, SENTIMENT_DECAY, MEMORY_LIMITS, SPEAK_MODELS } = require('./constants');
const { downloadToTemp, createTempPath, cleanup, extFromUrl } = require('./media/tempFiles');
const { runFFmpeg } = require('./media/ffmpegUtils');
const { firstFrameDataUri, MAX_VIDEO_BYTES } = require('./media/videoFrame');
const { withSampleSlot } = require('./media/sampleGate');
// Lazy-requires this module back; safe to require at the top from here.
const telemetry = require('./telemetry');

// Single source of truth for score → attitude level mapping
function scoreToAttitudeLevel(score) {
    if (score <= SENTIMENT_THRESHOLDS.HOSTILE_THRESHOLD)  return 'hostile';
    if (score <= SENTIMENT_THRESHOLDS.CAUTIOUS_THRESHOLD) return 'cautious';
    if (score >= SENTIMENT_THRESHOLDS.FRIENDLY_THRESHOLD) return 'friendly';
    if (score >= SENTIMENT_THRESHOLDS.FAMILIAR_THRESHOLD) return 'familiar';
    return 'neutral';
}

// Parse BigInts as integers
types.setTypeParser(types.builtins.INT8, v => parseInt(v, 10));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20, // Maximum connections
  min: 5, // Minimum idle connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// ── POOL ERROR HANDLERS ──────────────────────────────────────────────────────
pool.on('error', (err) => {
  logger.error('Unexpected error on idle client', { error: err.message, stack: err.stack });
});

pool.on('connect', () => {
  logger.debug('New database connection established');
});

pool.on('remove', () => {
  logger.debug('Database connection removed from pool');
});

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// ── INITIALIZATION ──────────────────────────────────────────────────────────
const init = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS balances (
            user_id TEXT PRIMARY KEY,
            balance BIGINT NOT NULL
        );
        -- Money a game has taken but not yet resolved.
        --
        -- Every wager leaves the balance the instant it is placed, and the hand
        -- that would give it back lives in an in-memory collector. A deploy
        -- therefore took the bet and forgot the game, and this bot deploys on
        -- every push: the interaction handler apologised for it in prose while
        -- the money stayed gone. A row here is a promise to return that stake
        -- if the process dies before the game finishes, and it survives the
        -- crash cases an in-memory registry could not.
        CREATE TABLE IF NOT EXISTS open_stakes (
            id           BIGSERIAL PRIMARY KEY,
            user_id      TEXT NOT NULL,
            amount       BIGINT NOT NULL,
            game         TEXT NOT NULL,
            opened_at_ms BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_open_stakes_opened ON open_stakes(opened_at_ms);
        CREATE TABLE IF NOT EXISTS user_preferences (
            user_id TEXT PRIMARY KEY,
            display_name TEXT,
            interaction_count INTEGER DEFAULT 0,
            last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            attitude_level TEXT DEFAULT 'neutral',
            sentiment_score DECIMAL(4,3) DEFAULT 0.000, 
            last_sentiment_update TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS conversation_memories (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            user_message TEXT,
            bot_response TEXT,
            sentiment_score DECIMAL(4,2),
            timestamp BIGINT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            is_context_only BOOLEAN DEFAULT false
        );
        CREATE TABLE IF NOT EXISTS speak_blacklist (
            user_id TEXT PRIMARY KEY
        );
        CREATE TABLE IF NOT EXISTS settings (
            setting TEXT PRIMARY KEY,
            state BOOLEAN NOT NULL
        );
        CREATE TABLE IF NOT EXISTS media_cache (
            media_id TEXT PRIMARY KEY,
            description TEXT NOT NULL,
            media_type TEXT NOT NULL,
            original_url TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            accessed_count INTEGER DEFAULT 1,
            last_accessed TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_media_cache_accessed ON media_cache(last_accessed);
        -- Telemetry: one trace per reply, one row per model/media call inside
        -- it, inputs deduped per trace by hash. See utils/telemetry.js.
        CREATE TABLE IF NOT EXISTS telemetry_traces (
            trace_id TEXT PRIMARY KEY,
            kind TEXT NOT NULL DEFAULT 'reply',
            version TEXT,
            user_id TEXT,
            channel_id TEXT,
            trigger TEXT,
            started_at_ms BIGINT NOT NULL,
            total_ms INTEGER,
            reply_text TEXT,
            emoji_key TEXT,
            flags JSONB,
            outcome TEXT,
            error TEXT,
            rating SMALLINT,
            rating_comment TEXT,
            judge_wrong_pick BOOLEAN,
            rated_at_ms BIGINT
        );
        CREATE TABLE IF NOT EXISTS telemetry_calls (
            id BIGSERIAL PRIMARY KEY,
            trace_id TEXT NOT NULL REFERENCES telemetry_traces(trace_id) ON DELETE CASCADE,
            at_ms BIGINT NOT NULL,
            kind TEXT NOT NULL,
            model TEXT,
            input_hash TEXT,
            output_text TEXT,
            latency_ms INTEGER,
            tokens_in INTEGER,
            tokens_out INTEGER,
            cost_usd NUMERIC(12, 8),
            outcome TEXT NOT NULL,
            error TEXT,
            extra JSONB
        );
        CREATE TABLE IF NOT EXISTS telemetry_inputs (
            trace_id TEXT NOT NULL REFERENCES telemetry_traces(trace_id) ON DELETE CASCADE,
            input_hash TEXT NOT NULL,
            input_text TEXT NOT NULL,
            PRIMARY KEY (trace_id, input_hash)
        );
        CREATE INDEX IF NOT EXISTS idx_telemetry_traces_started ON telemetry_traces(started_at_ms DESC);
        CREATE INDEX IF NOT EXISTS idx_telemetry_calls_trace ON telemetry_calls(trace_id);
        CREATE INDEX IF NOT EXISTS idx_conversation_memories_user ON conversation_memories(user_id);
        CREATE INDEX IF NOT EXISTS idx_conversation_memories_timestamp ON conversation_memories(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_user_preferences_composite ON user_preferences(attitude_level, interaction_count DESC);
        CREATE TABLE IF NOT EXISTS pending_duels (
            id SERIAL PRIMARY KEY,
            challenger_id TEXT NOT NULL,
            challenged_id TEXT NOT NULL,
            amount BIGINT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP NOT NULL,
            status TEXT DEFAULT 'pending'
        );
        CREATE INDEX IF NOT EXISTS idx_pending_duels_challenged ON pending_duels(challenged_id);
        CREATE INDEX IF NOT EXISTS idx_pending_duels_status ON pending_duels(status, expires_at);
        CREATE TABLE IF NOT EXISTS user_cooldowns (
            user_id TEXT NOT NULL,
            command TEXT NOT NULL,
            expires_at TIMESTAMP NOT NULL,
            PRIMARY KEY (user_id, command)
        );
        CREATE INDEX IF NOT EXISTS idx_user_cooldowns_expires ON user_cooldowns(expires_at);
        -- One row per player per game. Money in and money out are tracked
        -- separately from win and loss counts on purpose: a player can win
        -- most of their hands and still be down, and the profile should be
        -- able to say so rather than flattering them with a win rate.
        CREATE TABLE IF NOT EXISTS game_stats (
            user_id      TEXT NOT NULL,
            game         TEXT NOT NULL,
            rounds       BIGINT NOT NULL DEFAULT 0,
            wagered      BIGINT NOT NULL DEFAULT 0,
            returned     BIGINT NOT NULL DEFAULT 0,
            wins         BIGINT NOT NULL DEFAULT 0,
            losses       BIGINT NOT NULL DEFAULT 0,
            pushes       BIGINT NOT NULL DEFAULT 0,
            biggest_win  BIGINT NOT NULL DEFAULT 0,
            biggest_loss BIGINT NOT NULL DEFAULT 0,
            last_played  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, game)
        );
        CREATE INDEX IF NOT EXISTS idx_game_stats_user ON game_stats(user_id);
        -- Claim dates are stored as a plain DATE in UTC so "one per day" is a
        -- comparison rather than an interval, and a streak survives the bot
        -- being down for part of a day.
        CREATE TABLE IF NOT EXISTS daily_claims (
            user_id      TEXT PRIMARY KEY,
            last_claim   DATE NOT NULL,
            streak       INTEGER NOT NULL DEFAULT 1,
            best_streak  INTEGER NOT NULL DEFAULT 1,
            total_claims INTEGER NOT NULL DEFAULT 1
        );
        -- A durable warn record.
        --
        -- The warn reminder scheduler only ever kept a row long enough to fire
        -- one reminder and then deleted it, and it keyed on the display name
        -- Dyno printed, so a rename fragmented someone's history and nothing
        -- could ever be tied back to an account. This keeps both: the resolved
        -- user id when it can be worked out, and the label as written.
        CREATE TABLE IF NOT EXISTS warns (
            id            SERIAL PRIMARY KEY,
            guild_id      TEXT NOT NULL,
            user_id       TEXT,
            user_label    TEXT NOT NULL,
            case_id       TEXT,
            moderator     TEXT,
            reason        TEXT,
            source        TEXT NOT NULL DEFAULT 'dyno',
            created_at_ms BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_warns_user ON warns(user_id, created_at_ms DESC);
        CREATE INDEX IF NOT EXISTS idx_warns_label ON warns(guild_id, user_label);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_warns_case ON warns(guild_id, case_id)
            WHERE case_id IS NOT NULL;
        -- Bans, kicks and timeouts, whoever performed them.
        --
        -- Discord keeps its audit log for 45 days and then discards it, and the
        -- copy Dyno keeps lives on Dyno's servers. This is the durable one:
        -- who, whom, when, why, and which bot carried it out. Recorded from the
        -- audit log, which means actions taken through Dyno are captured too.
        --
        -- Recording only. Nothing here feeds the guard's thresholds or raises
        -- an alert; the guard deliberately does not watch moderation at all.
        CREATE TABLE IF NOT EXISTS mod_actions (
            id           BIGSERIAL PRIMARY KEY,
            guild_id     TEXT NOT NULL,
            audit_id     TEXT,
            action       TEXT NOT NULL,
            target_id    TEXT NOT NULL,
            target_tag   TEXT,
            actor_id     TEXT,
            actor_tag    TEXT,
            actor_is_bot BOOLEAN NOT NULL DEFAULT false,
            reason       TEXT,
            at_ms        BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mod_actions_target
            ON mod_actions(guild_id, target_id, at_ms DESC);
        -- Audit entries can arrive twice after a reconnect; the id is the only
        -- thing that makes a replay idempotent.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mod_actions_audit
            ON mod_actions(guild_id, audit_id) WHERE audit_id IS NOT NULL;
        -- Every suspicion report the gate has filed, and whether it was wrong.
        --
        -- The scoring engine has hand-tuned weights and thresholds and, until
        -- now, no ground truth at all: reports were read and nothing was ever
        -- written back, so "which signal misfires" had no answer beyond
        -- memory. The row is written when the report is posted, which is the
        -- only moment the signals still exist; the verdict is set later, by a
        -- human pressing the button on the panel, and is reversible.
        CREATE TABLE IF NOT EXISTS suspicion_reports (
            id             BIGSERIAL PRIMARY KEY,
            guild_id       TEXT NOT NULL,
            user_id        TEXT NOT NULL,
            score          INTEGER NOT NULL,
            tier           TEXT NOT NULL,
            source         TEXT NOT NULL,
            action         TEXT,
            signals        JSONB NOT NULL DEFAULT '[]'::jsonb,
            channel_id     TEXT,
            at_ms          BIGINT NOT NULL,
            false_positive BOOLEAN NOT NULL DEFAULT false,
            marked_by      TEXT,
            marked_at_ms   BIGINT
        );
        CREATE INDEX IF NOT EXISTS idx_suspicion_reports_guild
            ON suspicion_reports(guild_id, at_ms DESC);
        CREATE INDEX IF NOT EXISTS idx_suspicion_reports_wrong
            ON suspicion_reports(guild_id, false_positive) WHERE false_positive;
        -- Why an attitude moved, not just that it did. Capped per user by
        -- recordAttitudeChange; see the note there.
        CREATE TABLE IF NOT EXISTS attitude_ledger (
            id            SERIAL PRIMARY KEY,
            user_id       TEXT NOT NULL,
            delta         REAL NOT NULL,
            new_score     REAL NOT NULL,
            new_level     TEXT NOT NULL,
            raw_sentiment REAL,
            reason        TEXT,
            excerpt       TEXT,
            created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_attitude_ledger_user ON attitude_ledger(user_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS user_inventory (
            user_id     TEXT NOT NULL,
            item_id     TEXT NOT NULL,
            quantity    INTEGER NOT NULL DEFAULT 1,
            acquired_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, item_id)
        );
        CREATE TABLE IF NOT EXISTS reminders (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            due_at_utc_ms BIGINT NOT NULL,
            reason TEXT,
            created_at_utc_ms BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at_utc_ms);
        CREATE TABLE IF NOT EXISTS warn_reminders (
            id                TEXT PRIMARY KEY,
            channel_id        TEXT NOT NULL,
            guild_id          TEXT NOT NULL,
            warned_user       TEXT NOT NULL,
            warn_ids          TEXT,
            warn_count        INTEGER NOT NULL DEFAULT 1,
            due_at_utc_ms     BIGINT NOT NULL,
            created_at_utc_ms BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_warn_reminders_due ON warn_reminders(due_at_utc_ms);
        CREATE TABLE IF NOT EXISTS sleepy_counts (
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (guild_id, user_id)
        );
        -- How much each member has actually said. Membership tenure used to
        -- forgive on presence alone, so an account that joined and sat still
        -- became invisible to scoring once the grace window passed, which is
        -- precisely the sleeper strategy. This is the participation half.
        --
        -- Counts only, never content: nothing here identifies what was said.
        CREATE TABLE IF NOT EXISTS member_activity (
            guild_id        TEXT NOT NULL,
            user_id         TEXT NOT NULL,
            message_count   INTEGER NOT NULL DEFAULT 0,
            first_message_ms BIGINT NOT NULL,
            last_message_ms BIGINT NOT NULL,
            PRIMARY KEY (guild_id, user_id)
        );
        -- ── JOIN GATE (account-age auto-kicker) ─────────────────────────────
        -- One row per guild. A guild with no row is implicitly disabled, so the
        -- gate is opt-in and can never act on a server it was never set up for.
        CREATE TABLE IF NOT EXISTS join_gate_settings (
            guild_id                TEXT PRIMARY KEY,
            enabled                 BOOLEAN NOT NULL DEFAULT false,
            dry_run                 BOOLEAN NOT NULL DEFAULT false,
            min_account_age_minutes INTEGER NOT NULL DEFAULT 20160,
            gate_bots               BOOLEAN NOT NULL DEFAULT false,
            exempt_user_ids         TEXT[]  NOT NULL DEFAULT '{}',
            dm_enabled              BOOLEAN NOT NULL DEFAULT true,
            dm_message              TEXT,
            dm_ban_message          TEXT,
            dm_append_eligible      BOOLEAN NOT NULL DEFAULT true,
            dm_append_invite        BOOLEAN NOT NULL DEFAULT true,
            dm_invite_url           TEXT,
            dm_cooldown_minutes     INTEGER NOT NULL DEFAULT 60,
            escalate_enabled        BOOLEAN NOT NULL DEFAULT false,
            escalate_after_attempts INTEGER NOT NULL DEFAULT 3,
            log_channel_id          TEXT,
            log_kick_channel_id     TEXT,
            log_failure_channel_id  TEXT,
            log_preview_channel_id  TEXT,
            log_config_channel_id   TEXT,
            log_kicks               BOOLEAN NOT NULL DEFAULT true,
            log_failures            BOOLEAN NOT NULL DEFAULT true,
            log_previews            BOOLEAN NOT NULL DEFAULT true,
            log_config              BOOLEAN NOT NULL DEFAULT true,
            burst_alert_enabled     BOOLEAN NOT NULL DEFAULT true,
            burst_threshold         INTEGER NOT NULL DEFAULT 5,
            burst_window_seconds    INTEGER NOT NULL DEFAULT 60,
            sweep_enabled           BOOLEAN NOT NULL DEFAULT false,
            sweep_window_hours      INTEGER NOT NULL DEFAULT 24,
            total_kicks             INTEGER NOT NULL DEFAULT 0,
            total_bans              INTEGER NOT NULL DEFAULT 0,
            total_failures          INTEGER NOT NULL DEFAULT 0,
            created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        -- Suspicion scoring. Off by default, and every tier defaults to
        -- 'log' so that switching it on can never remove anybody until the
        -- owner has looked at real scores and decided otherwise.
        ALTER TABLE join_gate_settings
            ADD COLUMN IF NOT EXISTS suspicion_enabled     BOOLEAN NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS suspicion_watch_at    INTEGER NOT NULL DEFAULT 40,
            ADD COLUMN IF NOT EXISTS suspicion_suspect_at  INTEGER NOT NULL DEFAULT 70,
            ADD COLUMN IF NOT EXISTS suspicion_malicious_at INTEGER NOT NULL DEFAULT 100,
            ADD COLUMN IF NOT EXISTS suspicion_watch_action     TEXT NOT NULL DEFAULT 'log',
            ADD COLUMN IF NOT EXISTS suspicion_suspect_action   TEXT NOT NULL DEFAULT 'log',
            ADD COLUMN IF NOT EXISTS suspicion_malicious_action TEXT NOT NULL DEFAULT 'log',
            ADD COLUMN IF NOT EXISTS suspicion_log_channel_id TEXT,
            ADD COLUMN IF NOT EXISTS suspicion_weights     JSONB NOT NULL DEFAULT '{}'::jsonb,
            ADD COLUMN IF NOT EXISTS suspicion_keywords    TEXT[],
            ADD COLUMN IF NOT EXISTS total_flagged         INTEGER NOT NULL DEFAULT 0,
            -- Post-join behaviour window and invite attribution. Both opt-in.
            ADD COLUMN IF NOT EXISTS watch_enabled         BOOLEAN NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS watch_window_minutes  INTEGER NOT NULL DEFAULT 10,
            ADD COLUMN IF NOT EXISTS watch_action_at       INTEGER NOT NULL DEFAULT 100,
            ADD COLUMN IF NOT EXISTS watch_action          TEXT NOT NULL DEFAULT 'log',
            ADD COLUMN IF NOT EXISTS invite_tracking_enabled BOOLEAN NOT NULL DEFAULT false,
            -- How long a 'timeout' watch action mutes for. Never applied
            -- unless watch_action is set to 'timeout', which is not a default.
            ADD COLUMN IF NOT EXISTS watch_timeout_minutes INTEGER NOT NULL DEFAULT 60,
            -- Channels the behaviour window ignores, e.g. a #self-promotion
            -- channel where posting an invite is the point.
            ADD COLUMN IF NOT EXISTS watch_exempt_channel_ids TEXT[],
            ADD COLUMN IF NOT EXISTS suspicion_tenure_grace_days INTEGER NOT NULL DEFAULT 30;
        -- Rejoin tracking. Drives escalation and DM de-duplication.
        CREATE TABLE IF NOT EXISTS join_gate_attempts (
            guild_id      TEXT NOT NULL,
            user_id       TEXT NOT NULL,
            attempts      INTEGER NOT NULL DEFAULT 0,
            first_seen_ms BIGINT NOT NULL,
            last_seen_ms  BIGINT NOT NULL,
            last_dm_ms    BIGINT,
            PRIMARY KEY (guild_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_join_gate_attempts_seen ON join_gate_attempts(last_seen_ms);
        -- Temp-bans awaiting automatic lift. Deliberately independent of
        -- join_gate_settings.enabled: disabling the gate must never strand
        -- someone in a ban the bot promised to lift.
        CREATE TABLE IF NOT EXISTS join_gate_pending_unbans (
            guild_id     TEXT NOT NULL,
            user_id      TEXT NOT NULL,
            unban_at_ms  BIGINT NOT NULL,
            banned_at_ms BIGINT NOT NULL,
            -- 'age': lifts when the account matures; threshold edits recompute it.
            -- 'timed': fixed cooldown from the ban; threshold edits must not touch it.
            kind         TEXT NOT NULL DEFAULT 'age',
            PRIMARY KEY (guild_id, user_id)
        );
        ALTER TABLE join_gate_pending_unbans ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'age';
        CREATE INDEX IF NOT EXISTS idx_join_gate_unbans_due ON join_gate_pending_unbans(unban_at_ms);
        -- ── SPEAK EXTRAS ─────────────────────────────────────────────────────
        -- Distilled long-term profiles: durable facts and running jokes, kept
        -- separate from conversation_memories which stores raw exchanges.
        CREATE TABLE IF NOT EXISTS speak_profiles (
            user_id             TEXT PRIMARY KEY,
            profile             TEXT,
            exchanges_at_distill INTEGER NOT NULL DEFAULT 0,
            updated_at_ms       BIGINT NOT NULL DEFAULT 0
        );
        -- Structured config the boolean-only settings table cannot hold
        -- (interjection rules, delivery options).
        CREATE TABLE IF NOT EXISTS speak_config (
            key   TEXT PRIMARY KEY,
            value JSONB NOT NULL
        );
        -- Every X post the tweet mirror has already put in the channel. This
        -- exists so a post cannot appear twice (see claimTweet), and so the
        -- bot can recognise its own mirror posts when someone replies to one.
        CREATE TABLE IF NOT EXISTS mirrored_tweets (
            tweet_id     TEXT PRIMARY KEY,
            posted_at_ms BIGINT NOT NULL,
            message_id   TEXT
        );
        CREATE INDEX IF NOT EXISTS mirrored_tweets_posted_idx
            ON mirrored_tweets (posted_at_ms);
    `);

    // Migration: the mirror shipped a day before it tracked its own message
    // ids, so the table already exists in production without that column.
    //
    // The index on it MUST live here and not in the CREATE above. On a
    // database that already has the table, CREATE TABLE IF NOT EXISTS does
    // nothing at all, including nothing about the new column, so an index
    // declared alongside it runs against a column that does not exist yet and
    // takes down init() and with it the whole process. That is not a
    // hypothetical: it is what this comment was written for.
    await pool.query(`
        ALTER TABLE mirrored_tweets ADD COLUMN IF NOT EXISTS message_id TEXT;
        CREATE INDEX IF NOT EXISTS mirrored_tweets_message_idx
            ON mirrored_tweets (message_id);
    `);

    // Default Settings
    await pool.query(`
        INSERT INTO settings (setting, state)
        VALUES ('active_speak', true), ('active_media_analysis', true)
        ON CONFLICT DO NOTHING
    `);

    // Migration: Add is_context_only column if it doesn't exist
    await pool.query(`
        ALTER TABLE conversation_memories ADD COLUMN IF NOT EXISTS is_context_only BOOLEAN DEFAULT false
    `);

    // Migration: Add warn_ids and warn_count columns to warn_reminders if they don't exist
    await pool.query(`
        ALTER TABLE warn_reminders ADD COLUMN IF NOT EXISTS warn_ids TEXT;
        ALTER TABLE warn_reminders ADD COLUMN IF NOT EXISTS warn_count INTEGER NOT NULL DEFAULT 1;
    `);
};

// ── ECONOMY FUNCTIONS ───────────────────────────────────────────────────────
/**
 * Gets the balance for a user, creating account with seed amount if not exists
 * @param {string} userId - Discord user ID
 * @returns {Promise<number>} User's balance
 */
async function getBalance(userId) {
    const { rows } = await pool.query('SELECT balance FROM balances WHERE user_id = $1', [userId]);
    if (rows.length) return rows[0].balance;
    const seed = 10000;
    await pool.query('INSERT INTO balances (user_id, balance) VALUES ($1, $2)', [userId, seed]);
    logger.debug('New user balance created', { userId, seed });
    return seed;
}

/**
 * Updates a user's balance
 * @param {string} userId - Discord user ID
 * @param {number} newBalance - New balance amount
 */
async function updateBalance(userId, newBalance) {
    await pool.query(`
        INSERT INTO balances (user_id, balance) VALUES ($1, $2)
        ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance
    `, [userId, newBalance]);
    logger.debug('Balance updated', { userId, newBalance });
}

/**
 * Atomically adjusts a user's balance by a delta.
 * Seeds the account first if it does not exist (same $10k path as getBalance),
 * then applies the delta only when it cannot drive the balance negative.
 * @param {string} userId - Discord user ID
 * @param {number} delta - Amount to add (negative to deduct)
 * @returns {Promise<number|null>} New balance, or null when funds were insufficient
 */
async function adjustBalance(userId, delta) {
    const amount = Math.round(delta);
    const seed = 10000;
    await pool.query(
        'INSERT INTO balances (user_id, balance) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, seed]
    );
    const { rows } = await pool.query(
        'UPDATE balances SET balance = balance + $2 WHERE user_id = $1 AND balance + $2 >= 0 RETURNING balance',
        [userId, amount]
    );
    if (rows.length === 0) {
        logger.debug('Balance adjustment blocked (insufficient funds)', { userId, delta: amount });
        return null;
    }
    logger.debug('Balance adjusted', { userId, delta: amount, newBalance: rows[0].balance });
    return Number(rows[0].balance);
}

// ── OPEN STAKES ─────────────────────────────────────────────────────────────
/**
 * Stake ids this process opened and has not settled. The shutdown sweep works
 * from this set rather than from the whole table, because Railway overlaps the
 * old and new containers during a deploy: a blanket refund would hand back
 * money for a hand the OTHER instance is still dealing.
 */
const ownStakeIds = new Set();

/**
 * Takes a wager and records the debt in one transaction, so there is no
 * instant where the money has left the balance and nothing promises it back.
 * @param {string} userId
 * @param {number} amount positive whole amount to stake
 * @param {string} game short label, for the refund log
 * @returns {Promise<{balance: number, stakeId: string}|null>} null on insufficient funds
 */
async function placeStake(userId, amount, game) {
    const value = Math.round(amount);
    if (!(value > 0)) return null;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            'INSERT INTO balances (user_id, balance) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [userId, 10000]
        );
        const { rows } = await client.query(
            'UPDATE balances SET balance = balance - $2 WHERE user_id = $1 AND balance - $2 >= 0 RETURNING balance',
            [userId, value]
        );
        if (rows.length === 0) {
            await client.query('ROLLBACK');
            return null;
        }
        const { rows: stakeRows } = await client.query(
            'INSERT INTO open_stakes (user_id, amount, game, opened_at_ms) VALUES ($1, $2, $3, $4) RETURNING id',
            [userId, value, String(game || 'game').slice(0, 32), Date.now()]
        );
        await client.query('COMMIT');

        const stakeId = String(stakeRows[0].id);
        ownStakeIds.add(stakeId);
        return { balance: Number(rows[0].balance), stakeId };
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
        throw error;
    } finally {
        client.release();
    }
}

/**
 * The game resolved and paid out whatever it owed: the debt is discharged.
 * Deleting a settled row is what stops the sweeps below refunding a bet that
 * was already won or lost.
 * @param {string[]} stakeIds
 */
async function settleStakes(stakeIds) {
    const ids = (Array.isArray(stakeIds) ? stakeIds : [stakeIds]).filter(Boolean).map(String);
    if (ids.length === 0) return 0;
    for (const id of ids) ownStakeIds.delete(id);
    const { rowCount } = await pool.query('DELETE FROM open_stakes WHERE id = ANY($1::bigint[])', [ids]);
    return rowCount ?? 0;
}

/**
 * Hands money back for stakes whose game will never finish. The delete and the
 * credit share a transaction and the delete takes the row locks, so two sweeps
 * racing each other cannot pay the same stake twice.
 * @param {Object} options
 * @param {string[]} [options.ids] specific stakes (the shutdown sweep)
 * @param {number} [options.olderThanMs] everything opened before now minus this (the boot sweep)
 * @returns {Promise<{stakes: number, users: number, total: number}>}
 */
async function refundOpenStakes({ ids = null, olderThanMs = null } = {}) {
    const empty = { stakes: 0, users: 0, total: 0 };
    if (ids && ids.length === 0) return empty;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = ids
            ? await client.query(
                'DELETE FROM open_stakes WHERE id = ANY($1::bigint[]) RETURNING id, user_id, amount, game',
                [ids.map(String)])
            : await client.query(
                'DELETE FROM open_stakes WHERE opened_at_ms <= $1 RETURNING id, user_id, amount, game',
                [Date.now() - Math.max(0, Number(olderThanMs) || 0)]);

        const perUser = new Map();
        for (const row of rows) {
            perUser.set(row.user_id, (perUser.get(row.user_id) ?? 0) + Number(row.amount));
            ownStakeIds.delete(String(row.id));
        }
        for (const [userId, amount] of perUser) {
            await client.query(
                `INSERT INTO balances (user_id, balance) VALUES ($1, $2)
                 ON CONFLICT (user_id) DO UPDATE SET balance = balances.balance + $2`,
                [userId, amount]
            );
        }
        await client.query('COMMIT');

        const total = [...perUser.values()].reduce((sum, n) => sum + n, 0);
        if (rows.length > 0) {
            logger.info('[STAKES] Refunded unfinished wagers', {
                stakes: rows.length, users: perUser.size, total,
                games: [...new Set(rows.map(r => r.game))],
            });
        }
        return { stakes: rows.length, users: perUser.size, total };
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
        throw error;
    } finally {
        client.release();
    }
}

/** The shutdown sweep: only this process's own unfinished games. */
async function refundOwnStakes() {
    return refundOpenStakes({ ids: [...ownStakeIds] });
}

/** Test seam; nothing in the bot needs to read this. */
function openStakeCount() {
    return ownStakeIds.size;
}

/**
 * Atomically moves money from one user to another in a single transaction.
 * Both updates carry the non-negative guard; rows are touched in ascending
 * user_id order so concurrent transfers cannot deadlock.
 * @param {string} fromId - Paying user's Discord ID
 * @param {string} toId - Receiving user's Discord ID
 * @param {number} amount - Positive amount to move
 * @returns {Promise<{fromBalance: number, toBalance: number}|null>} New balances, or null on insufficient funds or failure
 */
async function transferBalance(fromId, toId, amount) {
    const value = Math.round(amount);
    if (value <= 0 || fromId === toId) return null;
    const seed = 10000;
    const ids = [fromId, toId].sort();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const id of ids) {
            await client.query(
                'INSERT INTO balances (user_id, balance) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [id, seed]
            );
        }
        const results = {};
        for (const id of ids) {
            const delta = id === fromId ? -value : value;
            const { rows } = await client.query(
                'UPDATE balances SET balance = balance + $2 WHERE user_id = $1 AND balance + $2 >= 0 RETURNING balance',
                [id, delta]
            );
            if (rows.length === 0) {
                await client.query('ROLLBACK');
                logger.debug('Balance transfer blocked (insufficient funds)', { fromId, toId, amount: value });
                return null;
            }
            results[id] = Number(rows[0].balance);
        }
        await client.query('COMMIT');
        logger.info('Balance transferred', { fromId, toId, amount: value });
        return { fromBalance: results[fromId], toBalance: results[toId] };
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
        logger.error('Balance transfer failed', { fromId, toId, amount: value, error: error.message });
        return null;
    } finally {
        client.release();
    }
}

/**
 * Gets top N users by balance
 * @param {number} limit - Number of top users to retrieve (default: 10)
 * @returns {Promise<Array>} Array of {user_id, balance} objects
 */
async function getTopBalances(limit = 10) {
    const { rows } = await pool.query('SELECT user_id, balance FROM balances ORDER BY balance DESC LIMIT $1', [limit]);
    return rows;
}

// ── SETTINGS & BLACKLIST ────────────────────────────────────────────────────
/**
 * Gets a setting state by key
 * @param {string} key - Setting key name
 * @returns {Promise<boolean|null>} Setting state or null if not found
 */
async function getSettingState(key) {
    const { rows } = await pool.query('SELECT state FROM settings WHERE setting = $1', [key]);
    return rows.length > 0 ? rows[0].state : null;
}

/**
 * Checks if a user is blacklisted from using speak command
 * @param {string} userId - Discord user ID
 * @returns {Promise<boolean>} True if blacklisted
 */
async function isUserBlacklisted(userId) {
    const { rows } = await pool.query('SELECT 1 FROM speak_blacklist WHERE user_id = $1', [userId]);
    return rows.length > 0;
}

/**
 * Adds a user to the speak command blacklist
 * @param {string} userId - Discord user ID
 */
async function addUserToBlacklist(userId) {
    await pool.query('INSERT INTO speak_blacklist (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
    logger.info('User added to blacklist', { userId });
}

/**
 * Removes a user from the speak command blacklist
 * @param {string} userId - Discord user ID
 */
async function removeUserFromBlacklist(userId) {
    await pool.query('DELETE FROM speak_blacklist WHERE user_id = $1', [userId]);
    logger.info('User removed from blacklist', { userId });
}

// ── MEDIA ANALYSIS (VISION) ─────────────────────────────────────────────────

/**
 * Discord signs CDN links with `?ex=&is=&hm=` and re-signs them on every
 * message fetch, so the same uploaded image arrives with a different URL each
 * time. Keying the cache on the full URL therefore never hit for attachments:
 * every call re-ran a vision model on a picture that was already described.
 *
 * The path alone is stable and already unique (it contains the attachment id),
 * so the query is dropped for Discord's own hosts. Other hosts are left
 * untouched, because elsewhere query parameters can genuinely select a
 * different image.
 */
const SIGNED_CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

function normalizeMediaUrl(url) {
    const raw = String(url ?? '');
    if (!raw.startsWith('http')) return raw; // data: URLs and the like
    try {
        const parsed = new URL(raw);
        if (SIGNED_CDN_HOSTS.has(parsed.hostname)) return `${parsed.origin}${parsed.pathname}`;
        return raw;
    } catch {
        return raw;
    }
}

function generateMediaId(url, _contentHash = null, fileName = '') {
    const uniqueString = `${normalizeMediaUrl(url)}_${fileName}`;
    return crypto.createHash('sha256').update(uniqueString).digest('hex').substring(0, 16);
}

async function getCachedMediaDescription(mediaId) {
    const { rows } = await pool.query(
        'SELECT description, media_type FROM media_cache WHERE media_id = $1',
        [mediaId]
    );

    if (rows.length > 0) {
        pool.query(`UPDATE media_cache SET accessed_count = accessed_count + 1, last_accessed = CURRENT_TIMESTAMP WHERE media_id = $1`, [mediaId])
            .catch(e => logger.warn('Media cache touch failed', { mediaId, error: e.message }));
        return rows[0];
    }
    return null;
}

// PRIMARY: Gemini 3.1 Flash-Lite, the STABLE id ($0.25/$1.50/M). The old
//   -preview id worked until the day Google retired it, which is what preview
//   ids do; same price, so there was never a reason to be on it.
// FALLBACK: Qwen3 VL 8B ($0.12/$0.46/M). Replaces Qwen 2.5 VL 7B, which was
//   DELISTED from OpenRouter: every fallback call had been 404ing silently,
//   so any Gemini hiccup became "contents not seen".
// RETRY POLICY: a timeout is NOT retried. It means the provider is slow right
//   now, and a reply is waiting; the fallback is the retry. Only fast network
//   failures get one more attempt. Worst case per item is ~16s where the old
//   ladder (three 10s timeout retries plus fallback) could reach ~38s.
async function analyzeImageWithOpenRouter(imageUrl, prompt = "Describe this image in a concise way, focusing on the main subject.", attempt = 1) {
    if (!OPENROUTER_API_KEY) return null;
    const MAX_ATTEMPTS = 2;
    const BACKOFF_BASE = 100; // milliseconds

    const VISION_MODEL = SPEAK_MODELS.VISION;
    const visionInput = [{
        role: 'user',
        content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: imageUrl } }
        ]
    }];
    const startedAt = Date.now();
    const record = fields => telemetry.logCall({
        kind: 'vision', model: VISION_MODEL, input: visionInput,
        latencyMs: Date.now() - startedAt, ...fields,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://discord.com',
                'X-Title': 'Cooler Moksi Media',
            },
            signal: controller.signal,
            body: JSON.stringify({
                model: VISION_MODEL,
                messages: visionInput,
                max_tokens: 300,
                usage: { include: true }
            })
        });

        // Armed until the body is read, not just the headers: a provider can
        // answer 200 instantly and then trickle the body past any deadline.
        // Cleared in the finally.
        if (!response.ok) {
            // HTTP error, try fallback
            logger.warn('[MEDIA] Gemini HTTP error, attempting fallback', { status: response.status, attempt });
            record({ outcome: `http_${response.status}` });
            return await analyzeImageFallback(imageUrl, prompt);
        }

        const data = await response.json();
        const result = data.choices?.[0]?.message?.content?.trim();
        if (result) {
            logger.debug('[MEDIA] Gemini primary success', { urlLength: imageUrl.length });
            record({
                output: result, outcome: 'ok',
                tokensIn: data.usage?.prompt_tokens ?? null,
                tokensOut: data.usage?.completion_tokens ?? null,
                costUsd: Number.isFinite(data.usage?.cost) ? data.usage.cost : null,
            });
            return result;
        }

        // Empty response, try fallback
        logger.warn('[MEDIA] Gemini returned empty response, trying fallback');
        record({ outcome: 'empty' });
        return await analyzeImageFallback(imageUrl, prompt);
    } catch (e) {
        // One retry, and only for a fast network failure. A timeout goes
        // straight to the fallback: retrying a slow provider stacks 8-second
        // waits in front of a reply that has a 20-second deadline.
        if (attempt < MAX_ATTEMPTS && e.name !== 'AbortError' && e.message.includes('fetch')) {
            const backoffMs = BACKOFF_BASE * attempt;
            logger.warn('[MEDIA] Network error, retrying Gemini once', { attempt, nextAttemptMs: backoffMs, error: e.message });
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            return await analyzeImageWithOpenRouter(imageUrl, prompt, attempt + 1);
        }

        logger.error('[MEDIA] Gemini failed, trying fallback', { error: e.message });
        record({ outcome: e.name === 'AbortError' ? 'timeout' : 'exception', error: e.message });
        return await analyzeImageFallback(imageUrl, prompt);
    } finally {
        clearTimeout(timeoutId);
    }
}

// FALLBACK: Qwen3 VL 8B (current-gen, cheap, strong on text/memes)
async function analyzeImageFallback(imageUrl, prompt) {
    const FALLBACK_TIMEOUT = 8000; // Slightly shorter timeout than primary
    const FALLBACK_MODEL = SPEAK_MODELS.VISION_FALLBACK;
    const visionInput = [{
        role: 'user',
        content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: imageUrl } }
        ]
    }];
    const startedAt = Date.now();
    const record = fields => telemetry.logCall({
        kind: 'vision_fallback', model: FALLBACK_MODEL, input: visionInput,
        latencyMs: Date.now() - startedAt, ...fields,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FALLBACK_TIMEOUT);

    try {
        logger.debug('[MEDIA] Qwen fallback attempt', { urlLength: imageUrl.length });

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://discord.com',
                'X-Title': 'Cooler Moksi Media Fallback',
            },
            signal: controller.signal,
            body: JSON.stringify({
                model: FALLBACK_MODEL,
                messages: visionInput,
                max_tokens: 200,
                usage: { include: true }
            })
        });

        // Armed until the body is read; cleared in the finally.
        if (!response.ok) {
            logger.warn('[MEDIA] Qwen HTTP error', { status: response.status });
            record({ outcome: `http_${response.status}` });
            return null;
        }

        const data = await response.json();
        const result = data.choices?.[0]?.message?.content?.trim();
        if (result) {
            logger.info('[MEDIA] Qwen fallback success');
            record({
                output: result, outcome: 'ok',
                tokensIn: data.usage?.prompt_tokens ?? null,
                tokensOut: data.usage?.completion_tokens ?? null,
                costUsd: Number.isFinite(data.usage?.cost) ? data.usage.cost : null,
            });
            return result;
        }

        logger.warn('[MEDIA] Qwen returned empty result');
        record({ outcome: 'empty' });
        return null;
    } catch (e) {
        logger.error('[MEDIA] Qwen fallback exception', { error: e.message });
        record({ outcome: e.name === 'AbortError' ? 'timeout' : 'exception', error: e.message });
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

function isGifMedia(url = '', fileName = '', contentType = '') {
    const ct = String(contentType || '').toLowerCase();
    const name = String(fileName || '').toLowerCase();
    const urlLower = String(url || '').toLowerCase();
    const ext = extFromUrl(urlLower);

    return ct === 'image/gif'
        || ct.includes('gif')
        || name.endsWith('.gif')
        || ext === 'gif'
        || urlLower.includes('.gif');
}

function isAnimatedEmbedCandidate(embed) {
    const embedType = String(embed?.type || '').toLowerCase();
    const candidates = [
        embed?.url,
        embed?.video?.url,
        embed?.video?.proxyURL,
        embed?.image?.url,
        embed?.image?.proxyURL,
        embed?.thumbnail?.url,
        embed?.thumbnail?.proxyURL
    ].filter(Boolean).map(v => String(v).toLowerCase());

    // Hosts whose page URLs carry no extension but are always animations.
    // Discord's own CDN does NOT belong here: a pasted cdn.discordapp.com
    // link is usually a plain image, and listing the host meant every one of
    // them was downloaded, storyboarded through ffmpeg and labeled a GIF.
    // Actual .gif links on any host are caught by the extension check.
    const hasAnimatedHost = candidates.some(u => /tenor\.com|giphy\.com/.test(u));
    const hasAnimatedExt = candidates.some(u => u.includes('.gif') || u.includes('.webm') || u.includes('.mp4'));

    return embedType === 'gifv' || hasAnimatedHost || hasAnimatedExt;
}

// Same hardening as the video frame path, because this is the same shape of
// work: a download and an ffmpeg pass with a reply waiting on them. The gate
// is shared with video sampling, so GIFs and videos queue in one lane instead
// of bursting side by side.
async function buildGifStoryboard(gifUrl) {
    return withSampleSlot(async () => {
        let inputPath = null;
        let storyboardPath = null;
        const startedAt = Date.now();

        try {
            const sourceExt = extFromUrl(gifUrl) || 'gif';
            inputPath = await downloadToTemp(gifUrl, sourceExt, {
                maxBytes: MAX_VIDEO_BYTES,
                timeoutMs: 12_000,
            });
            storyboardPath = createTempPath('jpg');

            // Sample animation across time and tile frames into one image (3x2).
            await runFFmpeg(inputPath, storyboardPath, cmd => {
                cmd
                    .videoFilters('fps=2,scale=320:-1:flags=lanczos,tile=3x2')
                    .outputOptions(['-frames:v 1']);
            }, { timeoutMs: 8_000 });

            telemetry.logCall({
                kind: 'gif_storyboard', outcome: 'ok',
                latencyMs: Date.now() - startedAt, extra: { url: gifUrl.slice(0, 200) },
            });
            return { inputPath, storyboardPath };
        } catch (e) {
            logger.warn('[MEDIA] GIF storyboard generation failed', { error: e.message });
            telemetry.logCall({
                kind: 'gif_storyboard', outcome: 'failed', error: e.message,
                latencyMs: Date.now() - startedAt, extra: { url: gifUrl.slice(0, 200) },
            });
            await cleanup(inputPath, storyboardPath);
            return null;
        }
    });
}

async function analyzeGifWithOpenRouter(gifUrl, prompt) {
    const storyboard = await buildGifStoryboard(gifUrl);
    if (!storyboard?.storyboardPath) {
        return await analyzeImageWithOpenRouter(gifUrl, prompt);
    }

    try {
        const storyboardBuffer = await fs.promises.readFile(storyboard.storyboardPath);
        const storyboardDataUrl = `data:image/jpeg;base64,${storyboardBuffer.toString('base64')}`;
        const gifPrompt = `${prompt}\n\nThis is an animated GIF shown as a storyboard of equally-spaced frames in timeline order (left-to-right, top-to-bottom). Describe both the scene content and what changes across the frames. Focus on the event or reaction being shown.`;
        return await analyzeImageWithOpenRouter(storyboardDataUrl, gifPrompt);
    } finally {
        await cleanup(storyboard.inputPath, storyboard.storyboardPath);
    }
}

async function processMediaInMessage(message, shouldAnalyze = true, options = {}) {
    const { forceReanalyze = false, deadlineAt = 0 } = options;
    const activeMedia = await getSettingState('active_media_analysis');
    if (activeMedia === false) return [];

    const descriptions = [];

    // The prompt tells the model to treat these tags as if it saw the thing, so
    // a tag that names a file type instead of contents is worse than useless:
    // it reacts to "mp4" with total confidence. When there is nothing to
    // describe, say that in words the model cannot mistake for a description.
    const unseen = what => `[${what} shared, contents not seen]`;

    // A reply is waiting on all of this. Cached lookups always go through;
    // fresh analysis is skipped once the caller's media budget is spent, so a
    // channel full of new media degrades to honest "not seen" tags instead of
    // pushing the reply past its deadline. The skipped items are analysed the
    // next time they come up with budget to spare, and cached from then on.
    const outOfTime = () => deadlineAt > 0 && Date.now() > deadlineAt;

    const MEDIA_PROMPT = "Describe what is shown in this image in 1-2 sentences. This description will be used by a chat AI to react to what was shared. Prioritize anything visually striking, emotionally notable, or culturally significant. Name any recognizable characters, memes, or public figures. If text is visible in the image, include it.";

    const remember = (mediaId, desc, kind, url) => pool.query(
        `INSERT INTO media_cache (media_id, description, media_type, original_url)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (media_id)
         DO UPDATE SET
            description = EXCLUDED.description,
            media_type = EXCLUDED.media_type,
            original_url = EXCLUDED.original_url,
            last_accessed = CURRENT_TIMESTAMP`,
        [mediaId, desc, kind, url]
    );

    // These return their tag rather than pushing it, so a message carrying
    // several items can describe them concurrently and still keep them in the
    // order they were posted. Four videos in one message used to mean four
    // downloads and four encodes back to back, with a reply waiting on all of
    // them.
    const describeUrl = async (url, type, name, mediaMeta = {}) => {
        const mediaId = generateMediaId(url, null, name);
        const cached = await getCachedMediaDescription(mediaId);

        if (!forceReanalyze && cached) return `[${type}: ${cached.description}]`;
        if (!shouldAnalyze || outOfTime()) {
            if (outOfTime()) telemetry.logCall({ kind: 'media_skip', outcome: 'deadline', extra: { type } });
            return unseen(type);
        }

        const desc = mediaMeta.isGif
            ? await analyzeGifWithOpenRouter(url, MEDIA_PROMPT)
            : await analyzeImageWithOpenRouter(url, MEDIA_PROMPT);

        if (!desc) return unseen(type);
        await remember(mediaId, desc, mediaMeta.isGif ? 'gif' : 'image', url);
        return `[${type}: ${desc}]`;
    };

    /**
     * A video uploaded straight to Discord has no embed and so no thumbnail.
     * Rather than fall back to the filename, pull a frame out of it with ffmpeg
     * and describe that like any other image.
     */
    const describeVideo = async (att) => {
        const mediaId = generateMediaId(att.url, null, att.name);
        const cached = await getCachedMediaDescription(mediaId);

        if (!forceReanalyze && cached) return `[Video: ${cached.description}]`;
        if (!shouldAnalyze || outOfTime()) {
            if (outOfTime()) telemetry.logCall({ kind: 'media_skip', outcome: 'deadline', extra: { type: 'Video' } });
            return unseen('Video');
        }

        const frame = await firstFrameDataUri(att.url, { sizeBytes: att.size });
        if (!frame) return unseen('Video');

        const desc = await analyzeImageWithOpenRouter(frame, MEDIA_PROMPT);
        if (!desc) return unseen('Video');

        // Keyed on the attachment URL, not the data URI: the frame is temporary
        // and would never match again.
        await remember(mediaId, desc, 'video', att.url);
        return `[Video: ${desc}]`;
    };

    // 1. Attachments (Images & VIDEOS), all at once rather than one after
    // another: an album of four is one wait, not four. Videos are always
    // sampled: attachment videos never generate embeds, so the old "borrow a
    // thumbnail from message.embeds" shortcut could only ever match an
    // UNRELATED embed. A YouTube link posted alongside an uploaded clip meant
    // the clip was described from the YouTube thumbnail.
    if (message.attachments?.size > 0) {
        const attachmentTags = await Promise.all([...message.attachments.values()].map(async (att) => {
            if (att.contentType?.startsWith('image/')) {
                const gifLike = isGifMedia(att.url, att.name, att.contentType);
                return describeUrl(att.url, gifLike ? "GIF Attachment" : "Image Attachment", att.name, { isGif: gifLike });
            }
            if (att.contentType?.startsWith('video/')) {
                return describeVideo(att);
            }
            return null;
        }));
        descriptions.push(...attachmentTags.filter(Boolean));
    }

    // 2. Embeds, concurrently for the same reason. The sample gate bounds the
    // heavy ones, so three tenor links are two ffmpeg passes and a queue, not
    // three at once and not one after another.
    if (message.embeds?.length > 0) {
        const embedTags = await Promise.all(message.embeds.map((embed) => {
            if (embed.video && message.attachments.size > 0) return null;

            const gifLikeEmbed = isAnimatedEmbedCandidate(embed);
            const preferredUrl = embed.video?.url || embed.video?.proxyURL;

            if (gifLikeEmbed && preferredUrl) {
                return describeUrl(preferredUrl, "Embedded GIF", "embed-gifv", { isGif: true });
            }

            const url = embed.image?.url || embed.thumbnail?.url;
            if (url) {
                return describeUrl(url, gifLikeEmbed ? "Embedded GIF" : "Embedded Image", "embed", { isGif: gifLikeEmbed });
            }
            return null;
        }));
        descriptions.push(...embedTags.filter(Boolean));
    }

    // 3. Stickers, concurrently too.
    if (message.stickers?.size > 0) {
        const stickerTags = await Promise.all([...message.stickers.values()].map((s) => {
            // Format 1=PNG, 2=APNG, 4=GIF. (Format 3 is Lottie/JSON which AI cannot see).
            if (s.format === 1 || s.format === 2 || s.format === 4) {
                return describeUrl(s.url, "Sticker", s.name, { isGif: s.format === 4 });
            }
            // Fallback for Lottie stickers
            return `[Sticker: ${s.name}]`;
        }));
        descriptions.push(...stickerTags.filter(Boolean));
    }

    // 4. Custom Emojis
    const emojiRegex = /<a?:(\w+):(\d+)>/g;
    const emojis = [...(message.content?.matchAll(emojiRegex) || [])];
    
    if (emojis.length > 0) {
        const uniqueNames = [...new Set(emojis.map(m => m[1]))].slice(0, 5);
        if (uniqueNames.length > 0) {
            descriptions.push(`[Custom Emojis used: ${uniqueNames.join(', ')}]`);
        }
    }

    return descriptions;
}

// ── SENTIMENT & RELATIONSHIP ────────────────────────────────────────────────
// PRIMARY: MiMo-V2-Flash ($0.09/$0.29/M). Cost-efficient JSON scoring
// FALLBACK 1: Groq Llama 3.3 8B ($0.05/$0.08/M). Lightweight dense model
// FALLBACK 2: DeepSeek V3 ($0.32/$0.89/M). Full reasoning fallback (safe but expensive)
async function analyzeMessageSentiment(userMessage, conversationContext) {
    if (!OPENROUTER_API_KEY) return { sentiment: 0, reasoning: 'No API' };

    const contextSlice = conversationContext.slice(-800).replace(/^[^\n]*\n/, '');
    const prompt = `Analyze the sentiment of the last message as directed specifically at the bot, not the user's general mood or topic.
CONTEXT:
${contextSlice}
MESSAGE: "${userMessage}"
Rules:
- Score only sentiment directed AT the bot. Venting, seeking help, or expressing emotions about unrelated topics should score near 0.
- Examples: "haha you're actually funny" → 0.5 | "you're so annoying, shut up" → -0.8 | "my day was terrible, help me" → 0.0
- Clamp to [-1.0, 1.0].
Return JSON only: {"sentiment": 0.0, "reasoning": "..."}`;

    // The configured utility model. This was a three-model cascade whose first
    // two rungs had both been delisted from OpenRouter, so every sentiment
    // read in the bot spent two doomed round trips before the safety net
    // below caught it, on every single reply.
    try {
        const { getUtilityModel } = require('./speakPipeline');
        const model = await getUtilityModel();
        logger.debug('Sentiment: attempting utility model', { model, promptLength: prompt.length });
        const { callOpenRouterAPI } = require('./apiHelpers');
        const result = await callOpenRouterAPI(model, [
            { role: 'system', content: 'Output JSON only.' },
            { role: 'user', content: prompt }
        ], {
            maxTokens: 100,
            temperature: 0.1,
            timeout: 8000,
            telemetry: { kind: 'sentiment' }
        });
        if (result) {
            const parsed = JSON.parse(result);
            logger.info('Sentiment: utility model success', { sentiment: parsed.sentiment });
            return parsed;
        }
    } catch (e) {
        logger.warn('Sentiment: utility model failed', { error: e.message });
    }

    // Safety net: a different family on purpose, so one vendor having a bad
    // afternoon does not take the attitude system down with it.
    try {
        logger.debug('Sentiment: Attempting DeepSeek V3 final fallback');
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://discord.com',
                'X-Title': 'Cooler Moksi Sentiment',
            },
            body: JSON.stringify({
                model: SPEAK_MODELS.SENTIMENT_SAFETY_NET,
                messages: [
                    { role: 'system', content: 'Output JSON only.' },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 100,
                temperature: 0.1,
                response_format: { type: 'json_object' }
            })
        });
        const data = await response.json();
        const result = data.choices?.[0]?.message?.content;
        if (result) {
            const parsed = JSON.parse(result);
            logger.info('Sentiment: DeepSeek V3 fallback success', { sentiment: parsed.sentiment });
            return parsed;
        }
    } catch (e) {
        logger.error('Sentiment: All models failed', { error: e.message });
    }

    // Last resort: neutral
    return { sentiment: 0, reasoning: 'All sentiment models failed; defaulting to neutral' };
}

async function getUserContext(userId) {
    const { rows } = await pool.query(
        'SELECT user_id, display_name, interaction_count, attitude_level, sentiment_score, last_sentiment_update, last_seen FROM user_preferences WHERE user_id = $1',
        [userId]
    );
    if (rows.length === 0) return { isNewUser: true, attitudeLevel: 'neutral', sentimentScore: 0, interactionCount: 0 };

    const data = rows[0];
    const lastUpdate = new Date(data.last_sentiment_update).getTime();
    const daysSince = (Date.now() - lastUpdate) / (1000 * 60 * 60 * 24);

    let currentScore = parseFloat(data.sentiment_score);
    let currentLevel = data.attitude_level;

    // Persist decay so reads and writes never disagree (fire-and-forget)
    if (daysSince > SENTIMENT_DECAY.DAYS_THRESHOLD) {
        currentScore = currentScore * SENTIMENT_DECAY.DECAY_MULTIPLIER;
        currentLevel = scoreToAttitudeLevel(currentScore);
        pool.query(
            `UPDATE user_preferences
             SET sentiment_score = $1, attitude_level = $2, last_sentiment_update = NOW(), updated_at = NOW()
             WHERE user_id = $3`,
            [currentScore, currentLevel, userId]
        ).catch(e => logger.warn('Sentiment decay persistence failed', { userId, error: e.message }));
    }

    return {
        isNewUser: false,
        attitudeLevel: currentLevel,
        sentimentScore: currentScore,
        displayName: data.display_name,
        interactionCount: data.interaction_count || 0,
        lastSeen: data.last_seen
    };
}

/**
 * Applies one sentiment reading to a user's attitude: smoothing, clamping,
 * persistence and the ledger entry. The reading can come from the dedicated
 * sentiment cascade or from the speak pipeline's room read; the arithmetic is
 * identical either way, which is the point of splitting this out.
 */
async function applyAttitudeSignal(userId, rawSentiment, reasoning, userContext, excerpt = '') {
    // Use provided userContext to eliminate N+1 query
    const currentScore = userContext.sentimentScore ?? 0;
    const impactFactor = Math.abs(rawSentiment) > 0.8
        ? SENTIMENT_THRESHOLDS.HIGH_IMPACT
        : SENTIMENT_THRESHOLDS.LOW_IMPACT;
    let newScore = (currentScore * (1 - impactFactor)) + (rawSentiment * impactFactor);
    newScore = Math.max(-1, Math.min(1, newScore));

    const newLevel = scoreToAttitudeLevel(newScore);

    await pool.query(`
        INSERT INTO user_preferences (user_id, interaction_count, attitude_level, sentiment_score, last_sentiment_update)
        VALUES ($1, 1, $2, $3, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
            interaction_count = user_preferences.interaction_count + 1,
            attitude_level = $2,
            sentiment_score = $3,
            last_sentiment_update = NOW(),
            updated_at = NOW()
    `, [userId, newLevel, newScore]);

    // The sentiment model already explains itself and that explanation was
    // being thrown away, which is why an attitude could slide for weeks with
    // no way to find out what caused it. Best-effort: a missing ledger row is
    // not worth failing the attitude update over.
    recordAttitudeChange(userId, {
        delta: newScore - currentScore,
        newScore,
        newLevel,
        rawSentiment,
        reason: reasoning,
        excerpt,
    }).catch(error => logger.warn('Attitude ledger write failed', { userId, error: error.message }));

    // Return both smoothed score and original for proper recording
    return { sentiment: newScore, originalSentiment: rawSentiment, reasoning };
}

async function updateUserAttitudeWithAI(userId, userMessage, conversationContext, userContext) {
    const analysis = await analyzeMessageSentiment(userMessage, conversationContext);
    return applyAttitudeSignal(userId, analysis.sentiment, analysis.reasoning, userContext, userMessage);
}

// ── WARNS ───────────────────────────────────────────────────────────────────

/**
 * Records a warning.
 *
 * Idempotent on the moderation bot's case number, because the listener can see
 * the same embed twice (an edit, a resend) and a warn counted twice is worse
 * than one counted late.
 *
 * @returns {Promise<boolean>} false when this case was already on file
 */
async function recordWarn({ guildId, userId, userLabel, caseId, moderator, reason, source = 'dyno' }) {
    const { rowCount } = await pool.query(
        `INSERT INTO warns (guild_id, user_id, user_label, case_id, moderator, reason, source, created_at_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING`,
        [
            guildId, userId || null, String(userLabel).slice(0, 200), caseId || null,
            moderator ? String(moderator).slice(0, 200) : null,
            reason ? String(reason).slice(0, 1000) : null,
            source, String(Date.now()),
        ]
    );
    return rowCount > 0;
}

/**
 * Records one moderation action read from the audit log.
 *
 * Idempotent on the audit entry id, because a gateway reconnect can replay
 * entries and a duplicated ban in someone's history is a lie about how many
 * times it happened.
 *
 * @returns {Promise<boolean>} whether a new row was written
 */
async function recordModAction({
    guildId, auditId, action, targetId, targetTag,
    actorId, actorTag, actorIsBot = false, reason, atMs,
}) {
    const { rowCount } = await pool.query(
        `INSERT INTO mod_actions
            (guild_id, audit_id, action, target_id, target_tag, actor_id, actor_tag, actor_is_bot, reason, at_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT DO NOTHING`,
        [
            guildId, auditId ? String(auditId) : null, String(action),
            String(targetId), targetTag ? String(targetTag).slice(0, 200) : null,
            actorId ? String(actorId) : null, actorTag ? String(actorTag).slice(0, 200) : null,
            Boolean(actorIsBot), reason ? String(reason).slice(0, 1000) : null,
            String(atMs ?? Date.now()),
        ]
    );
    return rowCount > 0;
}

/** One member's moderation history, newest first. */
async function getModActions(guildId, targetId, limit = 15) {
    const { rows } = await pool.query(
        `SELECT audit_id, action, target_tag, actor_id, actor_tag, actor_is_bot, reason, at_ms
           FROM mod_actions
          WHERE guild_id = $1 AND target_id = $2
          ORDER BY at_ms DESC
          LIMIT $3`,
        [guildId, targetId, limit]
    );
    return rows;
}

/**
 * Files a suspicion report, at the moment it is posted.
 *
 * Returns the row id, which the panel's buttons carry: a report from last
 * Tuesday still has to answer a click after three deploys, so the id is the
 * only thing tying a button to what it is about.
 *
 * @returns {Promise<number|null>} null when the write failed, which only
 *   costs the report its buttons.
 */
async function recordSuspicionReport({ guildId, userId, score, tier, source, action, signals, channelId }) {
    const { rows } = await pool.query(
        `INSERT INTO suspicion_reports
            (guild_id, user_id, score, tier, source, action, signals, channel_id, at_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
         RETURNING id`,
        [
            guildId, userId, Math.round(Number(score) || 0), tier ?? 'watch', source ?? 'profile',
            action ?? null, JSON.stringify(signals ?? []), channelId ?? null, String(Date.now()),
        ]
    );
    return rows[0]?.id ?? null;
}

/**
 * Marks a filed report as a mistake, or takes the mark back.
 *
 * Deliberately reversible and idempotent: a moderator who mis-clicks, or who
 * learns an hour later that the account really was a spammer, must be able to
 * put it back exactly as it was.
 *
 * @returns {Promise<{id: number, userId: string, falsePositive: boolean}|null>}
 */
async function markSuspicionReport(id, { falsePositive, byId }) {
    const { rows } = await pool.query(
        `UPDATE suspicion_reports
            SET false_positive = $2,
                marked_by      = CASE WHEN $2 THEN $3 ELSE NULL END,
                marked_at_ms   = CASE WHEN $2 THEN $4 ELSE NULL END
          WHERE id = $1
      RETURNING id, user_id, false_positive`,
        [id, Boolean(falsePositive), byId ?? null, String(Date.now())]
    );
    if (!rows[0]) return null;
    return { id: rows[0].id, userId: rows[0].user_id, falsePositive: rows[0].false_positive };
}

/** One filed report, for a button that needs to know what it is toggling. */
async function getSuspicionReport(id) {
    const { rows } = await pool.query(
        `SELECT id, guild_id, user_id, score, tier, source, false_positive, marked_by
           FROM suspicion_reports WHERE id = $1`,
        [id]
    );
    return rows[0] ?? null;
}

/**
 * What the reports have amounted to: how many were filed, how many were
 * called wrong, and which signals show up most often in the wrong ones.
 */
async function getSuspicionAccuracy(guildId, { limit = 8 } = {}) {
    const [totals, worst] = await Promise.all([
        pool.query(
            `SELECT COUNT(*)::int AS filed,
                    COUNT(*) FILTER (WHERE false_positive)::int AS wrong,
                    MIN(at_ms) AS oldest_ms
               FROM suspicion_reports WHERE guild_id = $1`,
            [guildId]
        ),
        pool.query(
            // jsonb_array_elements raises on anything that is not an array, and
            // a dashboard page that 500s over one malformed row is a bad trade
            // for a count.
            `SELECT signal->>'label' AS label, COUNT(*)::int AS wrong
               FROM suspicion_reports,
                    jsonb_array_elements(
                        CASE WHEN jsonb_typeof(signals) = 'array' THEN signals ELSE '[]'::jsonb END
                    ) AS signal
              WHERE guild_id = $1 AND false_positive
              GROUP BY 1 ORDER BY wrong DESC LIMIT $2`,
            [guildId, limit]
        ),
    ]);
    return { ...totals.rows[0], signals: worst.rows };
}

/** How far back the record goes, and how much of it there is. */
async function getModActionSummary(guildId) {
    const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS total,
                MIN(at_ms) AS oldest_ms,
                COUNT(DISTINCT target_id)::int AS people
           FROM mod_actions WHERE guild_id = $1`,
        [guildId]
    );
    return rows[0] ?? { total: 0, oldest_ms: null, people: 0 };
}

/**
 * A user's warn history. Matches on the resolved id when there is one, and
 * falls back to the label so warns recorded before an id could be worked out
 * are not orphaned.
 */
async function getWarns(guildId, { userId = null, label = null } = {}, limit = 25) {
    const { rows } = await pool.query(
        `SELECT id, user_id, user_label, case_id, moderator, reason, source, created_at_ms
         FROM warns
         WHERE guild_id = $1
           AND (($2::text IS NOT NULL AND user_id = $2)
             OR ($3::text IS NOT NULL AND user_label ILIKE $3))
         ORDER BY created_at_ms DESC LIMIT $4`,
        [guildId, userId, label, limit]
    );
    return rows.map(r => ({
        id: r.id,
        userId: r.user_id,
        userLabel: r.user_label,
        caseId: r.case_id,
        moderator: r.moderator,
        reason: r.reason,
        source: r.source,
        createdAtMs: Number(r.created_at_ms),
    }));
}

/** Backfills the id on rows recorded before the label could be resolved. */
async function linkWarnsToUser(guildId, label, userId) {
    const { rowCount } = await pool.query(
        'UPDATE warns SET user_id = $3 WHERE guild_id = $1 AND user_label ILIKE $2 AND user_id IS NULL',
        [guildId, label, userId]
    );
    return rowCount;
}

// ── ATTITUDE LEDGER ─────────────────────────────────────────────────────────

/** Excerpts are for recognising the moment, not for re-reading the message. */
const LEDGER_EXCERPT_CHARS = 160;
/** Rows below this delta are ordinary drift and would bury the real swings. */
const LEDGER_MIN_DELTA = 0.02;

async function recordAttitudeChange(userId, { delta, newScore, newLevel, rawSentiment, reason, excerpt }) {
    if (!Number.isFinite(delta) || Math.abs(delta) < LEDGER_MIN_DELTA) return;
    await pool.query(
        `INSERT INTO attitude_ledger
            (user_id, delta, new_score, new_level, raw_sentiment, reason, excerpt, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
            userId, delta, newScore, newLevel, rawSentiment,
            String(reason ?? '').slice(0, 500),
            String(excerpt ?? '').replace(/\s+/g, ' ').slice(0, LEDGER_EXCERPT_CHARS),
        ]
    );

    // Keep it to the last 50 entries per user. This is a "what happened
    // lately" log, not an archive, and it is written on every exchange.
    await pool.query(
        `DELETE FROM attitude_ledger WHERE user_id = $1 AND id NOT IN (
            SELECT id FROM attitude_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50
        )`,
        [userId]
    );
}

/** Most recent first. */
async function getAttitudeLedger(userId, limit = 10) {
    const { rows } = await pool.query(
        `SELECT delta, new_score, new_level, raw_sentiment, reason, excerpt, created_at
         FROM attitude_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [userId, limit]
    );
    return rows.map(r => ({
        delta: Number(r.delta),
        newScore: Number(r.new_score),
        newLevel: r.new_level,
        rawSentiment: Number(r.raw_sentiment),
        reason: r.reason,
        excerpt: r.excerpt,
        createdAt: r.created_at,
    }));
}

// ── MEMORY ──────────────────────────────────────────────────────────────────
async function storeConversationMemory(userId, channelId, userMessage, botResponse, sentimentScore, isContextOnly = false) {
    await pool.query(`
        INSERT INTO conversation_memories (user_id, channel_id, user_message, bot_response, sentiment_score, timestamp, is_context_only)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [userId, channelId, userMessage, botResponse, sentimentScore, Date.now(), isContextOnly]);

    // Retention is per user: the last N exchanges each. The old cap was
    // GLOBAL (1000 rows for the whole server, oldest 200 deleted at a time),
    // which meant every active week evicted everyone else's history and the
    // bot genuinely remembered nothing about anyone for longer than a few
    // days. Worst case is now bounded at N rows times however many people
    // actually talk to it, which is smaller than the old cap ever was in
    // practice and belongs to each user rather than to whoever spoke last.
    await pool.query(`
        DELETE FROM conversation_memories
        WHERE user_id = $1 AND id NOT IN (
            SELECT id FROM conversation_memories
            WHERE user_id = $1
            ORDER BY timestamp DESC
            LIMIT ${MEMORY_LIMITS.PER_USER_KEPT}
        )
    `, [userId]);
}

/**
 * Returns chronological sentiment history for a user, oldest first.
 * Used by checkrelationship/stats to compute trend (improving / declining).
 * Excludes context-only rows so lurking doesn't skew the trendline.
 */
async function getSentimentHistory(userId, limit = 10) {
    const { rows } = await pool.query(
        `SELECT sentiment_score, timestamp FROM conversation_memories
         WHERE user_id = $1 AND is_context_only = false AND sentiment_score IS NOT NULL
         ORDER BY timestamp DESC LIMIT $2`,
        [userId, limit]
    );
    return rows.reverse().map(r => ({
        sentiment: parseFloat(r.sentiment_score),
        timestamp: Number(r.timestamp)
    }));
}

async function getRecentMemories(userId, limit = 5, options = {}) {
    const { excludeContext = false } = options;

    // timestamp and channel_id ride along so the caller can date each memory
    // and drop ones already visible in the live chat log.
    const query = excludeContext
        ? `SELECT user_message, bot_response, timestamp, channel_id FROM conversation_memories
           WHERE user_id = $1 AND is_context_only = false
           ORDER BY timestamp DESC LIMIT $2`
        : `SELECT user_message, bot_response, timestamp, channel_id FROM conversation_memories
           WHERE user_id = $1 ORDER BY timestamp DESC LIMIT $2`;

    const { rows } = await pool.query(query, [userId, limit]);
    return rows.reverse();
}

/**
 * Attitude and interaction counts for a set of users in one round-trip.
 * Users with no row are simply absent from the result: strangers.
 *
 * @param {string[]} userIds
 * @returns {Promise<Map<string, {attitudeLevel: string, interactionCount: number}>>}
 */
async function getUserContextsBulk(userIds) {
    const out = new Map();
    const ids = [...new Set(userIds)].filter(Boolean);
    if (ids.length === 0) return out;

    const { rows } = await pool.query(
        `SELECT user_id, attitude_level, interaction_count
         FROM user_preferences WHERE user_id = ANY($1)`,
        [ids]
    );
    for (const row of rows) {
        out.set(row.user_id, {
            attitudeLevel: row.attitude_level || 'neutral',
            interactionCount: row.interaction_count || 0,
        });
    }
    return out;
}

// ── SPEAK CONFIG & PROFILES ─────────────────────────────────────────────────

/**
 * speak_config reads go through a short cache because the interjection gate
 * consults them on every guild message.
 */
const SPEAK_CONFIG_TTL_MS = 30_000;
const speakConfigCache = new Map(); // key -> {value, expiresAt}

async function getSpeakConfigValue(key, fallback = null) {
    const hit = speakConfigCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const { rows } = await pool.query('SELECT value FROM speak_config WHERE key = $1', [key]);
    const value = rows.length ? rows[0].value : fallback;
    speakConfigCache.set(key, { value, expiresAt: Date.now() + SPEAK_CONFIG_TTL_MS });
    return value;
}

async function setSpeakConfigValue(key, value) {
    await pool.query(
        `INSERT INTO speak_config (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, JSON.stringify(value)]
    );
    speakConfigCache.set(key, { value, expiresAt: Date.now() + SPEAK_CONFIG_TTL_MS });
}

function invalidateSpeakConfig(key) {
    if (key) speakConfigCache.delete(key);
    else speakConfigCache.clear();
}

// ── TWEET MIRROR ────────────────────────────────────────────────────────────

/**
 * Claims a tweet id for posting, atomically.
 *
 * Railway keeps the old container alive while the new one boots, so for a
 * minute or so on every deploy there are two pollers running, both holding the
 * same cursor and both about to post the same thing. Nothing in the poller can
 * prevent that on its own, because neither process can see the other.
 *
 * The insert is the claim. Exactly one caller gets a row back, whichever
 * process it belongs to, and only that one posts. It also makes the cursor
 * safe to rewind: re-reading a window that was already delivered costs a
 * fraction of a cent and produces no duplicate messages.
 *
 * @param {string} tweetId
 * @returns {Promise<boolean>} true if this process is the one that may post it
 */
async function claimTweet(tweetId) {
    const { rows } = await pool.query(
        `INSERT INTO mirrored_tweets (tweet_id, posted_at_ms) VALUES ($1, $2)
         ON CONFLICT (tweet_id) DO NOTHING
         RETURNING tweet_id`,
        [String(tweetId), Date.now()]
    );
    return rows.length > 0;
}

/**
 * Gives a claim back, so the next poll may try that tweet again.
 *
 * Claiming happens before the send, because claiming afterwards would let two
 * overlapping containers both post first. The cost of that ordering is that a
 * send which fails has already consumed its one chance, and the post is gone
 * for good. Handing the claim back turns a failed send into a retry instead
 * of a silent loss, which matters most in the case that actually happens:
 * the mirror pointed at a channel the bot cannot type in.
 */
async function releaseTweet(tweetId) {
    await pool.query('DELETE FROM mirrored_tweets WHERE tweet_id = $1', [String(tweetId)]);
}

/**
 * Remembers which Discord message carried a given tweet.
 *
 * Replying to one of the bot's messages is how you talk to it, so without
 * this a mirror post is an invitation to a conversation nobody wanted: reply
 * to a leak to say "no way" and the bot answers you.
 */
async function recordMirrorMessage(tweetId, messageId) {
    await pool.query(
        'UPDATE mirrored_tweets SET message_id = $2 WHERE tweet_id = $1',
        [String(tweetId), String(messageId)]
    );
}

/**
 * Was this message posted by the tweet mirror?
 *
 * Goes stale after pruneMirroredTweets drops the row, which means a reply to
 * a month-old tweet embed does wake the bot. That is the right trade: the
 * alternative is keeping every message id forever to handle a case that does
 * not happen.
 */
async function isMirrorMessage(messageId) {
    if (!messageId) return false;
    const { rows } = await pool.query(
        'SELECT 1 FROM mirrored_tweets WHERE message_id = $1 LIMIT 1',
        [String(messageId)]
    );
    return rows.length > 0;
}

/**
 * Drops claim rows old enough that the cursor can never reach them again.
 * @returns {Promise<number>} rows removed
 */
async function pruneMirroredTweets(olderThanMs = 30 * 24 * 60 * 60 * 1000) {
    const { rowCount } = await pool.query(
        'DELETE FROM mirrored_tweets WHERE posted_at_ms < $1',
        [Date.now() - olderThanMs]
    );
    return rowCount ?? 0;
}

async function getSpeakProfile(userId) {
    const { rows } = await pool.query(
        'SELECT profile, exchanges_at_distill, updated_at_ms FROM speak_profiles WHERE user_id = $1',
        [userId]
    );
    return rows[0] ?? null;
}

async function saveSpeakProfile(userId, profile, exchangesAtDistill) {
    await pool.query(
        `INSERT INTO speak_profiles (user_id, profile, exchanges_at_distill, updated_at_ms)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET
            profile = EXCLUDED.profile,
            exchanges_at_distill = EXCLUDED.exchanges_at_distill,
            updated_at_ms = EXCLUDED.updated_at_ms`,
        [userId, profile, exchangesAtDistill, String(Date.now())]
    );
}

async function deleteSpeakProfile(userId) {
    const { rowCount } = await pool.query('DELETE FROM speak_profiles WHERE user_id = $1', [userId]);
    return rowCount > 0;
}

async function countSpeakProfiles() {
    const { rows } = await pool.query('SELECT COUNT(*) AS n FROM speak_profiles');
    return Number(rows[0]?.n) || 0;
}

/**
 * Distilled profiles for a set of users in one round-trip, keyed by id.
 * Users without a profile are simply absent. Lets the prompt show what the
 * bot knows about EVERYONE in the room, not only the asker: being remembered
 * in front of others is where long-term memory visibly pays off.
 */
async function getSpeakProfilesBulk(userIds) {
    const out = new Map();
    const ids = [...new Set(userIds)].filter(Boolean);
    if (ids.length === 0) return out;

    const { rows } = await pool.query(
        'SELECT user_id, profile FROM speak_profiles WHERE user_id = ANY($1)',
        [ids]
    );
    for (const row of rows) {
        if (row.profile) out.set(row.user_id, row.profile);
    }
    return out;
}

async function updateUserPreferences(userId, interaction) {
    const displayName = interaction.member?.displayName || interaction.user?.username || null;

    await pool.query(`
        INSERT INTO user_preferences (user_id, display_name, last_seen)
        VALUES ($1, $2, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
            display_name = COALESCE(EXCLUDED.display_name, user_preferences.display_name),
            last_seen = NOW(),
            updated_at = NOW()
    `, [userId, displayName]);
}

async function getMediaAnalysisProvider() {
    // Check if the setting is active
    const active = await getSettingState('active_media_analysis');
    if (!active) return 'disabled';
    
    // Since you are using OpenRouter for Llama/Gemini
    if (process.env.OPENROUTER_API_KEY) return 'openrouter';
    
    return 'unknown';
}

// ── DUEL STATE PERSISTENCE ──────────────────────────────────────────────────────
/**
 * Creates a pending duel between two users
 * @param {string} challengerId - Discord ID of duel initiator
 * @param {string} challengedId - Discord ID of challenged user
 * @param {number} amount - Wagered amount
 * @param {number} expiryMs - Milliseconds until duel expires (default: 30s)
 * @returns {Promise<number>} Duel ID
 */
async function createPendingDuel(challengerId, challengedId, amount, expiryMs = 30000) {
    const expiresAt = new Date(Date.now() + expiryMs);
    const { rows } = await pool.query(
        `INSERT INTO pending_duels (challenger_id, challenged_id, amount, expires_at)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [challengerId, challengedId, amount, expiresAt]
    );
    logger.info('Duel created', { duelId: rows[0].id, challengerId, challengedId, amount });
    return rows[0].id;
}

/**
 * Retrieves pending duels for a user
 * @param {string} userId - Discord user ID to check
 * @returns {Promise<Array>} Array of pending duel objects
 */
async function getPendingDuelsFor(userId) {
    const { rows } = await pool.query(
        `SELECT * FROM pending_duels WHERE challenged_id = $1 AND status = 'pending' AND expires_at > NOW()`,
        [userId]
    );
    return rows;
}

/**
 * Retrieves pending duels a user has issued (outgoing challenges)
 * @param {string} userId - Discord user ID of the challenger
 * @returns {Promise<Array>} Array of pending duel objects
 */
async function getPendingDuelsFrom(userId) {
    const { rows } = await pool.query(
        `SELECT * FROM pending_duels WHERE challenger_id = $1 AND status = 'pending' AND expires_at > NOW()`,
        [userId]
    );
    return rows;
}

/**
 * Updates duel status
 * @param {number} duelId - Duel ID
 * @param {string} status - New status (pending, accepted, completed, expired)
 */
async function updateDuelStatus(duelId, status) {
    await pool.query(
        `UPDATE pending_duels SET status = $1 WHERE id = $2`,
        [status, duelId]
    );
    logger.debug('Duel status updated', { duelId, status });
}

/**
 * Deletes a duel
 * @param {number} duelId - Duel ID to delete
 */
async function deleteDuel(duelId) {
    await pool.query(`DELETE FROM pending_duels WHERE id = $1`, [duelId]);
    logger.debug('Duel deleted', { duelId });
}

// ── COOLDOWN MANAGEMENT ─────────────────────────────────────────────────────────
/**
 * Sets a cooldown for a user on a specific command
 * @param {string} userId - Discord user ID
 * @param {string} command - Command name (e.g., 'gacha', 'duel')
 * @param {number} durationMs - Cooldown duration in milliseconds
 */
async function setUserCooldown(userId, command, durationMs) {
    const expiresAt = new Date(Date.now() + durationMs);
    await pool.query(
        `INSERT INTO user_cooldowns (user_id, command, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, command) DO UPDATE SET expires_at = $3`,
        [userId, command, expiresAt]
    );
    logger.debug('Cooldown set', { userId, command, durationMs });
}

/**
 * Gets remaining cooldown time for a user on a command
 * @param {string} userId - Discord user ID
 * @param {string} command - Command name
 * @returns {Promise<number>} Milliseconds remaining (0 if expired)
 */
async function getUserCooldownRemaining(userId, command) {
    const { rows } = await pool.query(
        `SELECT expires_at FROM user_cooldowns WHERE user_id = $1 AND command = $2`,
        [userId, command]
    );
    
    if (rows.length === 0) return 0;
    
    const remaining = new Date(rows[0].expires_at).getTime() - Date.now();
    return Math.max(0, remaining);
}

/**
 * Checks if a user is on cooldown for a command
 * @param {string} userId - Discord user ID
 * @param {string} command - Command name
 * @returns {Promise<boolean>} True if on cooldown
 */
async function isUserOnCooldown(userId, command) {
    const remaining = await getUserCooldownRemaining(userId, command);
    return remaining > 0;
}

/**
 * Clears expired cooldowns (maintenance task)
 */
async function clearExpiredCooldowns() {
    const result = await pool.query(
        `DELETE FROM user_cooldowns WHERE expires_at <= NOW()`
    );
    logger.debug('Expired cooldowns cleared', { rowsDeleted: result.rowCount });
}

// ── MEDIA CACHE CLEANUP ──────────────────────────────────────────────────────
/**
 * Cleans up old media cache entries (deterministic, not probabilistic),
 * keeping the most recently touched rows. The cap is generous on purpose: a
 * row is a couple hundred bytes, while a miss now costs a download, an ffmpeg
 * pass and a vision call with a reply waiting on all three. Evicting to save
 * kilobytes and paying seconds to earn them back was the wrong trade.
 */
async function cleanupMediaCache(maxRows = 10_000) {
    try {
        // Check cache size
        const { rows: size } = await pool.query('SELECT COUNT(*) as count FROM media_cache');
        const count = parseInt(size[0].count, 10);
        
        if (count > maxRows) {
            logger.info('Media cache cleanup triggered', { currentSize: count, maxRows });
            
            // Delete oldest cache entries, keeping newest maxRows
            const result = await pool.query(
                `DELETE FROM media_cache WHERE media_id NOT IN (
                    SELECT media_id FROM media_cache ORDER BY last_accessed DESC LIMIT $1
                )`,
                [maxRows]
            );
            
            logger.info('Media cache cleanup completed', { rowsDeleted: result.rowCount });
        }
    } catch (error) {
        logger.error('Media cache cleanup failed', { error: error.message });
    }
}

// ── CASINO STATISTICS ───────────────────────────────────────────────────────

/**
 * Records one settled round.
 *
 * `wagered` and `returned` are both gross: everything the player put on the
 * table and everything that came back, stake included. Net is derived, never
 * stored, so a partial write can never leave the two disagreeing.
 *
 * Best-effort by design. Statistics are not worth failing a payout over, so a
 * caller that cannot reach the database still finishes its round.
 *
 * @param {'blackjack'|'slots'|'roulette'|'craps'|'highlow'|'tetris'|'duel'|'gacha'} game
 */
async function recordGameResult(userId, game, { wagered = 0, returned = 0, rounds = 1 } = {}) {
    try {
        const net = returned - wagered;
        await pool.query(
            `INSERT INTO game_stats (user_id, game, rounds, wagered, returned,
                                     wins, losses, pushes, biggest_win, biggest_loss, last_played)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id, game) DO UPDATE SET
                rounds       = game_stats.rounds + EXCLUDED.rounds,
                wagered      = game_stats.wagered + EXCLUDED.wagered,
                returned     = game_stats.returned + EXCLUDED.returned,
                wins         = game_stats.wins + EXCLUDED.wins,
                losses       = game_stats.losses + EXCLUDED.losses,
                pushes       = game_stats.pushes + EXCLUDED.pushes,
                biggest_win  = GREATEST(game_stats.biggest_win, EXCLUDED.biggest_win),
                biggest_loss = GREATEST(game_stats.biggest_loss, EXCLUDED.biggest_loss),
                last_played  = CURRENT_TIMESTAMP`,
            [
                userId, game, rounds, wagered, returned,
                net > 0 ? 1 : 0,
                net < 0 ? 1 : 0,
                net === 0 ? 1 : 0,
                net > 0 ? net : 0,
                net < 0 ? -net : 0,
            ]
        );
    } catch (error) {
        logger.warn('Could not record game result', { userId, game, error: error.message });
    }
}

/** Every game a player has touched, busiest first. */
async function getGameStats(userId) {
    const { rows } = await pool.query(
        'SELECT * FROM game_stats WHERE user_id = $1 ORDER BY rounds DESC', [userId]
    );
    return rows.map(r => ({
        game: r.game,
        rounds: Number(r.rounds),
        wagered: Number(r.wagered),
        returned: Number(r.returned),
        wins: Number(r.wins),
        losses: Number(r.losses),
        pushes: Number(r.pushes),
        biggestWin: Number(r.biggest_win),
        biggestLoss: Number(r.biggest_loss),
        lastPlayed: r.last_played,
    }));
}

/**
 * The players who are furthest ahead or furthest behind, by lifetime net.
 * @param {'up'|'down'} direction
 */
async function getCasinoLeaders(direction = 'up', limit = 10) {
    const { rows } = await pool.query(
        `SELECT user_id, SUM(returned - wagered) AS net, SUM(rounds) AS rounds
         FROM game_stats GROUP BY user_id
         HAVING SUM(rounds) > 0
         ORDER BY SUM(returned - wagered) ${direction === 'down' ? 'ASC' : 'DESC'}
         LIMIT $1`,
        [limit]
    );
    return rows.map(r => ({ userId: r.user_id, net: Number(r.net), rounds: Number(r.rounds) }));
}

// ── DAILY CLAIM ─────────────────────────────────────────────────────────────

/**
 * Claims the daily stipend, if it is due.
 *
 * Days are UTC calendar days rather than rolling 24-hour windows, so the reset
 * is at a time a player can learn instead of drifting later every day.
 *
 * @returns {Promise<{claimed: boolean, streak: number, bestStreak: number,
 *   totalClaims: number, broke: boolean}>} `broke` says a previous streak
 *   lapsed, which the caller may want to commiserate about.
 */
async function claimDaily(userId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT last_claim, streak, best_streak, total_claims FROM daily_claims
             WHERE user_id = $1 FOR UPDATE`, [userId]
        );

        const { rows: today } = await client.query(
            "SELECT CURRENT_DATE AS today, CURRENT_DATE - 1 AS yesterday"
        );
        const todayStr = String(today[0].today);
        const yesterdayStr = String(today[0].yesterday);

        if (!rows.length) {
            await client.query(
                `INSERT INTO daily_claims (user_id, last_claim, streak, best_streak, total_claims)
                 VALUES ($1, CURRENT_DATE, 1, 1, 1)`, [userId]
            );
            await client.query('COMMIT');
            return { claimed: true, streak: 1, bestStreak: 1, totalClaims: 1, broke: false };
        }

        const row = rows[0];
        const last = String(row.last_claim);
        if (last === todayStr) {
            await client.query('COMMIT');
            return {
                claimed: false, streak: row.streak, bestStreak: row.best_streak,
                totalClaims: row.total_claims, broke: false,
            };
        }

        const continued = last === yesterdayStr;
        const streak = continued ? row.streak + 1 : 1;
        const bestStreak = Math.max(streak, row.best_streak);

        await client.query(
            `UPDATE daily_claims SET last_claim = CURRENT_DATE, streak = $2,
                best_streak = $3, total_claims = total_claims + 1
             WHERE user_id = $1`, [userId, streak, bestStreak]
        );
        await client.query('COMMIT');
        return {
            claimed: true, streak, bestStreak,
            totalClaims: row.total_claims + 1,
            broke: !continued && row.streak > 1,
        };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function getDailyState(userId) {
    const { rows } = await pool.query(
        `SELECT last_claim, streak, best_streak, total_claims,
                (last_claim = CURRENT_DATE) AS claimed_today
         FROM daily_claims WHERE user_id = $1`, [userId]
    );
    if (!rows.length) return null;
    return {
        streak: rows[0].streak,
        bestStreak: rows[0].best_streak,
        totalClaims: rows[0].total_claims,
        claimedToday: rows[0].claimed_today,
    };
}

// ── INVENTORY ───────────────────────────────────────────────────────────────

async function addInventoryItem(userId, itemId, quantity = 1) {
    const { rows } = await pool.query(
        `INSERT INTO user_inventory (user_id, item_id, quantity) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = user_inventory.quantity + EXCLUDED.quantity
         RETURNING quantity`,
        [userId, itemId, quantity]
    );
    return rows[0].quantity;
}

async function getInventory(userId) {
    const { rows } = await pool.query(
        'SELECT item_id, quantity, acquired_at FROM user_inventory WHERE user_id = $1 ORDER BY acquired_at ASC',
        [userId]
    );
    return rows.map(r => ({ itemId: r.item_id, quantity: r.quantity, acquiredAt: r.acquired_at }));
}

/**
 * Buys an item, taking the money and granting it in one transaction so a
 * failure between the two can never charge for nothing.
 * @returns {Promise<{ok: boolean, balance?: number, quantity?: number, error?: string}>}
 */
async function purchaseItem(userId, itemId, price, { unique = false } = {}) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        if (unique) {
            const { rows: owned } = await client.query(
                'SELECT 1 FROM user_inventory WHERE user_id = $1 AND item_id = $2', [userId, itemId]
            );
            if (owned.length) {
                await client.query('ROLLBACK');
                return { ok: false, error: 'You already own that.' };
            }
        }

        const { rows } = await client.query(
            `UPDATE balances SET balance = balance - $2
             WHERE user_id = $1 AND balance >= $2 RETURNING balance`,
            [userId, price]
        );
        if (!rows.length) {
            await client.query('ROLLBACK');
            return { ok: false, error: 'You cannot afford that.' };
        }

        const { rows: inv } = await client.query(
            `INSERT INTO user_inventory (user_id, item_id, quantity) VALUES ($1, $2, 1)
             ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = user_inventory.quantity + 1
             RETURNING quantity`,
            [userId, itemId]
        );

        await client.query('COMMIT');
        return { ok: true, balance: Number(rows[0].balance), quantity: inv[0].quantity };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        logger.error('Purchase failed', { userId, itemId, error: error.message });
        return { ok: false, error: 'Something went wrong; nothing was charged.' };
    } finally {
        client.release();
    }
}

// ── EXPORTS ─────────────────────────────────────────────────────────────────
module.exports = {
    pool,
    init,
    // Economy
    getBalance,
    updateBalance,
    adjustBalance,
    placeStake,
    settleStakes,
    refundOpenStakes,
    refundOwnStakes,
    openStakeCount,
    transferBalance,
    getTopBalances,
    // User Management
    isUserBlacklisted,
    addUserToBlacklist,
    removeUserFromBlacklist,
    getSettingState,
    getUserContext,
    getUserContextsBulk,
    updateUserPreferences,
    // Speak config & profiles
    getSpeakConfigValue,
    setSpeakConfigValue,
    invalidateSpeakConfig,
    // Tweet mirror
    claimTweet,
    releaseTweet,
    recordMirrorMessage,
    isMirrorMessage,
    pruneMirroredTweets,
    getSpeakProfile,
    saveSpeakProfile,
    deleteSpeakProfile,
    countSpeakProfiles,
    getSpeakProfilesBulk,
    updateUserAttitudeWithAI,
    applyAttitudeSignal,
    // Media & Cache
    processMediaInMessage,
    getMediaAnalysisProvider,
    cleanupMediaCache,
    normalizeMediaUrl,
    generateMediaId,
    isAnimatedEmbedCandidate,
    // Memory & Sentiment
    storeConversationMemory,
    getRecentMemories,
    getSentimentHistory,
    scoreToAttitudeLevel,
    // Duels (Persistent State)
    createPendingDuel,
    getPendingDuelsFor,
    getPendingDuelsFrom,
    updateDuelStatus,
    deleteDuel,
    // Cooldowns (Persistent State)
    setUserCooldown,
    getUserCooldownRemaining,
    isUserOnCooldown,
    clearExpiredCooldowns,
    // Casino statistics
    recordGameResult,
    getGameStats,
    getCasinoLeaders,
    // Daily claim
    claimDaily,
    getDailyState,
    // Inventory
    addInventoryItem,
    getInventory,
    purchaseItem,
    // Attitude ledger
    recordAttitudeChange,
    getAttitudeLedger,
    // Warns
    recordWarn,
    recordModAction,
    getModActions,
    getModActionSummary,
    recordSuspicionReport,
    markSuspicionReport,
    getSuspicionReport,
    getSuspicionAccuracy,
    getWarns,
    linkWarnsToUser,
};