// src/utils/joinGate/config.js
/**
 * Join Gate: per-guild configuration store.
 *
 * A guild with no row is implicitly disabled. Reads go through a short-lived
 * cache because `guildMemberAdd` can fire dozens of times per second during a
 * raid, and every one of those would otherwise be a database round-trip.
 */

const { pool } = require('../db');
const logger = require('../logger');

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const DAY_MINUTES = 1440;

/** Matches the wording requested for the DM, with placeholders substituted. */
const DEFAULT_DM_MESSAGE =
    'Your account was made too recently ({days} day limit) to join this server. ' +
    'After the {days} days of your account creation (and if you\'re not a bot) you should be able to rejoin. ' +
    'We are sorry for the inconvenience.';

const DEFAULT_DM_BAN_MESSAGE =
    'Your account was made too recently ({days} day limit) to join this server, and you have tried to rejoin ' +
    'several times. Access has been temporarily blocked instead of kicking you again. ' +
    'The block lifts automatically as soon as your account is old enough; you do not need to ask anyone. ' +
    'We are sorry for the inconvenience.';

/**
 * Removal DMs for the suspicion engine and the behaviour watch window.
 * These members already PASSED the age gate, so the "made too recently"
 * wording above would be a lie for them; each removal reason gets its own
 * truthful text.
 */
const DEFAULT_DM_SUSPICION_MESSAGE =
    'Your account was flagged by an automated safety check when joining {server}: its profile matches ' +
    'patterns commonly seen in spam accounts. This is not about your account\'s age. If this is a mistake, ' +
    'filling out your profile (an avatar, a display name) before trying again will help. ' +
    'We are sorry for the inconvenience.';

const DEFAULT_DM_WATCH_MESSAGE =
    'You were removed from {server} because of what was posted from your account shortly after joining ' +
    '(scam links, spam, or mass mentions). If your account was compromised, please secure it before ' +
    'rejoining. We are sorry for the inconvenience.';

/** Hard bounds. Anything the panel accepts is clamped into these. */
const LIMITS = {
    MIN_AGE_MINUTES: { min: 0, max: 365 * DAY_MINUTES },
    DM_COOLDOWN_MINUTES: { min: 0, max: 7 * DAY_MINUTES },
    ESCALATE_ATTEMPTS: { min: 2, max: 50 },
    BURST_THRESHOLD: { min: 2, max: 100 },
    BURST_WINDOW_SECONDS: { min: 10, max: 3600 },
    SWEEP_WINDOW_HOURS: { min: 1, max: 168 },
    BAN_HOURS: { min: 1, max: 720 },
    /** Discord's own ceiling on a timeout is 28 days; going past it just fails. */
    TIMEOUT_MINUTES: { min: 1, max: 28 * DAY_MINUTES },
    DM_MESSAGE_LENGTH: 1800,
    EXEMPT_IDS: 200,
};

const DEFAULTS = Object.freeze({
    enabled: false,
    dry_run: false,
    min_account_age_minutes: 14 * DAY_MINUTES,
    gate_bots: false,
    exempt_user_ids: [],
    dm_enabled: true,
    dm_message: DEFAULT_DM_MESSAGE,
    dm_ban_message: DEFAULT_DM_BAN_MESSAGE,
    dm_append_eligible: true,
    dm_append_invite: true,
    dm_invite_url: null,
    dm_cooldown_minutes: 60,
    escalate_enabled: false,
    escalate_after_attempts: 3,
    log_channel_id: null,
    log_kick_channel_id: null,
    log_failure_channel_id: null,
    log_preview_channel_id: null,
    log_config_channel_id: null,
    log_kicks: true,
    log_failures: true,
    log_previews: true,
    log_config: true,
    burst_alert_enabled: true,
    burst_threshold: 5,
    burst_window_seconds: 60,
    sweep_enabled: false,
    sweep_window_hours: 24,
    // Suspicion scoring. Everything off / log-only until deliberately armed.
    suspicion_enabled: false,
    suspicion_watch_at: 40,
    suspicion_suspect_at: 70,
    suspicion_malicious_at: 100,
    suspicion_watch_action: 'log',
    suspicion_suspect_action: 'log',
    suspicion_malicious_action: 'log',
    suspicion_log_channel_id: null,
    suspicion_log_enabled: true,
    suspicion_weights: {},
    suspicion_keywords: null,
    suspicion_tenure_grace_days: 30,
    suspicion_ban_hours: 24,
    dm_suspicion_message: DEFAULT_DM_SUSPICION_MESSAGE,
    // Post-join behaviour window.
    watch_enabled: false,
    watch_window_minutes: 10,
    watch_action_at: 100,
    watch_action: 'log',
    watch_ban_hours: 24,
    watch_timeout_minutes: 60,
    /**
     * Channels the behaviour window ignores entirely.
     *
     * A server with a #self-promotion channel has a place where posting your
     * own invite is the whole point, and scoring it as advertising there is
     * just wrong. Empty by default, which is exactly the behaviour this had
     * before the setting existed.
     */
    watch_exempt_channel_ids: [],
    watch_automod_enabled: false,

    // ── Audit-log guard ─────────────────────────────────────────────────────
    // Watch-only. Nothing here calls a moderation endpoint: the audit log is a
    // record of what already happened, so this can notice and report and can
    // never intercept, block or undo an action by anyone.
    guard_enabled: false,
    guard_channel_id: null,
    guard_dm_owner: true,
    guard_window_seconds: 60,
    guard_delete_limit: 4,
    guard_create_limit: 6,
    guard_perm_limit: 2,
    guard_webhook_limit: 3,
    guard_watch_identity: true,
    guard_watch_bots: true,
    guard_exempt_user_ids: [],

    snapshot_enabled: false,
    // A snapshot kept only in the server it describes does not survive the one
    // event it exists for. The DM is the copy that outlives the server.
    snapshot_dm_owner: true,
    dm_watch_message: DEFAULT_DM_WATCH_MESSAGE,
    // Invite attribution.
    invite_tracking_enabled: false,
    total_kicks: 0,
    total_bans: 0,
    total_failures: 0,
    total_flagged: 0,
});

/**
 * What a tier is allowed to do.
 *
 * 'timeout' exists for the behaviour watch window specifically: a borderline
 * score from someone who just joined is far better answered by muting them for
 * an hour, which a human can undo in one click, than by a kick or a ban that
 * needs an invite and an apology to walk back.
 */
const TIER_ACTIONS = Object.freeze(['log', 'timeout', 'kick', 'ban', 'none']);

/**
 * Columns the panel is allowed to write. Used as an allow-list when building
 * dynamic UPDATE statements so a key can never be injected into SQL.
 */
const WRITABLE_COLUMNS = new Set([
    'enabled', 'dry_run', 'min_account_age_minutes', 'gate_bots', 'exempt_user_ids',
    'dm_enabled', 'dm_message', 'dm_ban_message', 'dm_append_eligible', 'dm_append_invite',
    'dm_invite_url', 'dm_cooldown_minutes',
    'escalate_enabled', 'escalate_after_attempts',
    'log_channel_id', 'log_kick_channel_id', 'log_failure_channel_id',
    'log_preview_channel_id', 'log_config_channel_id',
    'log_kicks', 'log_failures', 'log_previews', 'log_config',
    'burst_alert_enabled', 'burst_threshold', 'burst_window_seconds',
    'sweep_enabled', 'sweep_window_hours',
    'suspicion_enabled', 'suspicion_watch_at', 'suspicion_suspect_at', 'suspicion_malicious_at',
    'suspicion_watch_action', 'suspicion_suspect_action', 'suspicion_malicious_action',
    'suspicion_log_channel_id', 'suspicion_log_enabled', 'suspicion_weights', 'suspicion_keywords',
    'suspicion_tenure_grace_days', 'suspicion_ban_hours', 'dm_suspicion_message',
    'watch_enabled', 'watch_window_minutes', 'watch_action_at', 'watch_action',
    'watch_ban_hours', 'watch_timeout_minutes', 'watch_exempt_channel_ids', 'dm_watch_message',
    'watch_automod_enabled',
    'guard_enabled', 'guard_channel_id', 'guard_dm_owner', 'guard_window_seconds',
    'guard_delete_limit', 'guard_create_limit', 'guard_perm_limit', 'guard_webhook_limit',
    'guard_watch_identity', 'guard_watch_bots', 'guard_exempt_user_ids',
    'snapshot_enabled', 'snapshot_dm_owner',
    'invite_tracking_enabled',
]);

const STAT_COLUMNS = new Set(['total_kicks', 'total_bans', 'total_failures', 'total_flagged']);

const CACHE_TTL_MS = 30_000;
/** @type {Map<string, {value: object, expiresAt: number}>} */
const cache = new Map();

/**
 * Columns this module introduced after the base schema in db.js shipped.
 * The schema file is owned elsewhere, so the gate ensures its own late
 * additions here, once, before the first read or write touches them.
 * Idempotent, and a failure is retried on the next call rather than cached.
 */
let columnsEnsured = null;
function ensureColumns() {
    columnsEnsured ??= pool.query(
        `ALTER TABLE join_gate_settings
            ADD COLUMN IF NOT EXISTS suspicion_log_enabled BOOLEAN NOT NULL DEFAULT true,
            ADD COLUMN IF NOT EXISTS suspicion_ban_hours   INTEGER NOT NULL DEFAULT 24,
            ADD COLUMN IF NOT EXISTS watch_ban_hours       INTEGER NOT NULL DEFAULT 24,
            ADD COLUMN IF NOT EXISTS watch_timeout_minutes INTEGER NOT NULL DEFAULT 60,
            ADD COLUMN IF NOT EXISTS watch_exempt_channel_ids TEXT[],
            ADD COLUMN IF NOT EXISTS watch_automod_enabled BOOLEAN NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS guard_enabled         BOOLEAN NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS guard_channel_id      TEXT,
            ADD COLUMN IF NOT EXISTS guard_dm_owner        BOOLEAN NOT NULL DEFAULT true,
            ADD COLUMN IF NOT EXISTS guard_window_seconds  INTEGER NOT NULL DEFAULT 60,
            ADD COLUMN IF NOT EXISTS guard_delete_limit    INTEGER NOT NULL DEFAULT 4,
            ADD COLUMN IF NOT EXISTS guard_create_limit    INTEGER NOT NULL DEFAULT 6,
            ADD COLUMN IF NOT EXISTS guard_perm_limit      INTEGER NOT NULL DEFAULT 2,
            ADD COLUMN IF NOT EXISTS guard_webhook_limit   INTEGER NOT NULL DEFAULT 3,
            ADD COLUMN IF NOT EXISTS guard_watch_identity  BOOLEAN NOT NULL DEFAULT true,
            ADD COLUMN IF NOT EXISTS guard_watch_bots      BOOLEAN NOT NULL DEFAULT true,
            ADD COLUMN IF NOT EXISTS guard_exempt_user_ids TEXT[],
            ADD COLUMN IF NOT EXISTS snapshot_enabled      BOOLEAN NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS snapshot_dm_owner     BOOLEAN NOT NULL DEFAULT true,
            ADD COLUMN IF NOT EXISTS dm_suspicion_message  TEXT,
            ADD COLUMN IF NOT EXISTS dm_watch_message      TEXT`
    ).catch(error => {
        columnsEnsured = null;
        throw error;
    });
    return columnsEnsured;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function clamp(value, { min, max }) {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Fills in nulls with defaults so callers never have to null-check.
 * `dm_message` is stored NULL when it has never been customised, which keeps
 * the default text upgradable without a migration.
 */
function normalise(row) {
    // Fresh array on the unconfigured path: DEFAULTS is frozen but the array
    // inside it is not, and handing the same instance to every caller invites
    // a shared-mutation bug later.
    if (!row) return { ...DEFAULTS, exempt_user_ids: [], guild_id: null, configured: false };

    return {
        ...DEFAULTS,
        ...row,
        configured: true,
        exempt_user_ids: Array.isArray(row.exempt_user_ids) ? row.exempt_user_ids : [],
        watch_exempt_channel_ids: Array.isArray(row.watch_exempt_channel_ids)
            ? row.watch_exempt_channel_ids : [],
        guard_exempt_user_ids: Array.isArray(row.guard_exempt_user_ids)
            ? row.guard_exempt_user_ids : [],
        dm_message: row.dm_message ?? DEFAULT_DM_MESSAGE,
        dm_ban_message: row.dm_ban_message ?? DEFAULT_DM_BAN_MESSAGE,
        dm_suspicion_message: row.dm_suspicion_message ?? DEFAULT_DM_SUSPICION_MESSAGE,
        dm_watch_message: row.dm_watch_message ?? DEFAULT_DM_WATCH_MESSAGE,
        // JSONB comes back parsed, but a legacy NULL must not become "no object".
        suspicion_weights: (row.suspicion_weights && typeof row.suspicion_weights === 'object')
            ? row.suspicion_weights
            : {},
        suspicion_keywords: Array.isArray(row.suspicion_keywords) ? row.suspicion_keywords : null,
    };
}

/** Renders a minute count as a human day figure ("14", "0.5", "1.25"). */
function formatDays(minutes) {
    const days = Number(minutes) / DAY_MINUTES;
    if (!Number.isFinite(days)) return '0';
    if (Number.isInteger(days)) return String(days);
    return String(Number(days.toFixed(2)));
}

function daysToMinutes(days) {
    return Math.round(Number(days) * DAY_MINUTES);
}

function thresholdMs(settings) {
    return Number(settings.min_account_age_minutes) * MINUTE_MS;
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * Reads a guild's configuration.
 *
 * Throws on database failure. Callers on the join path must treat that as
 * "do nothing" rather than "no config, therefore kick".
 *
 * @param {string} guildId
 * @param {{fresh?: boolean}} [options]
 * @returns {Promise<object>} normalised settings
 */
async function getSettings(guildId, { fresh = false } = {}) {
    if (!fresh) {
        const hit = cache.get(guildId);
        if (hit && hit.expiresAt > Date.now()) return hit.value;
    }

    await ensureColumns();
    const { rows } = await pool.query('SELECT * FROM join_gate_settings WHERE guild_id = $1', [guildId]);
    const value = normalise(rows[0]);
    cache.set(guildId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
}

/** Every guild with the gate switched on. Used by the startup sweep. */
async function getEnabledGuildIds() {
    const { rows } = await pool.query('SELECT guild_id FROM join_gate_settings WHERE enabled = true');
    return rows.map(r => r.guild_id);
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Upserts a partial configuration patch and returns the stored row.
 * Unknown keys are rejected loudly rather than silently dropped.
 *
 * @param {string} guildId
 * @param {Record<string, any>} patch
 * @returns {Promise<object>} normalised settings after the write
 */
async function updateSettings(guildId, patch) {
    const keys = Object.keys(patch).filter(k => {
        if (WRITABLE_COLUMNS.has(k)) return true;
        logger.warn('[JOIN-GATE] Ignored non-writable settings key', { guildId, key: k });
        return false;
    });

    if (keys.length === 0) return getSettings(guildId, { fresh: true });

    await ensureColumns();
    const columns = ['guild_id', ...keys];
    const placeholders = columns.map((_, i) => `$${i + 1}`);
    const values = [guildId, ...keys.map(k => patch[k])];
    const assignments = keys.map(k => `${k} = EXCLUDED.${k}`);

    const { rows } = await pool.query(
        `INSERT INTO join_gate_settings (${columns.join(', ')})
         VALUES (${placeholders.join(', ')})
         ON CONFLICT (guild_id) DO UPDATE SET ${assignments.join(', ')}, updated_at = NOW()
         RETURNING *`,
        values
    );

    const value = normalise(rows[0]);
    cache.set(guildId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
}

/**
 * Bumps a lifetime counter. Fire-and-forget: a failed stat must never take
 * down an enforcement action, so this swallows its own errors.
 */
async function incrementStat(guildId, column, by = 1) {
    if (!STAT_COLUMNS.has(column)) return;
    try {
        await pool.query(
            `UPDATE join_gate_settings SET ${column} = ${column} + $2 WHERE guild_id = $1`,
            [guildId, by]
        );
        invalidate(guildId);
    } catch (error) {
        logger.warn('[JOIN-GATE] Stat increment failed', { guildId, column, error: error.message });
    }
}

async function resetStats(guildId) {
    await pool.query(
        `UPDATE join_gate_settings
         SET total_kicks = 0, total_bans = 0, total_failures = 0, total_flagged = 0, updated_at = NOW()
         WHERE guild_id = $1`,
        [guildId]
    );
    invalidate(guildId);
}

function invalidate(guildId) {
    if (guildId) cache.delete(guildId);
    else cache.clear();
}

module.exports = {
    DAY_MS,
    MINUTE_MS,
    DAY_MINUTES,
    DEFAULTS,
    DEFAULT_DM_MESSAGE,
    DEFAULT_DM_BAN_MESSAGE,
    DEFAULT_DM_SUSPICION_MESSAGE,
    DEFAULT_DM_WATCH_MESSAGE,
    TIER_ACTIONS,
    LIMITS,
    clamp,
    formatDays,
    daysToMinutes,
    thresholdMs,
    getSettings,
    getEnabledGuildIds,
    updateSettings,
    incrementStat,
    resetStats,
    invalidate,
};
