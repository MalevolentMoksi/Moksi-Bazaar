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

/** Hard bounds. Anything the panel accepts is clamped into these. */
const LIMITS = {
    MIN_AGE_MINUTES: { min: 0, max: 365 * DAY_MINUTES },
    DM_COOLDOWN_MINUTES: { min: 0, max: 7 * DAY_MINUTES },
    ESCALATE_ATTEMPTS: { min: 2, max: 50 },
    BURST_THRESHOLD: { min: 2, max: 100 },
    BURST_WINDOW_SECONDS: { min: 10, max: 3600 },
    SWEEP_WINDOW_HOURS: { min: 1, max: 168 },
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
    total_kicks: 0,
    total_bans: 0,
    total_failures: 0,
});

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
]);

const STAT_COLUMNS = new Set(['total_kicks', 'total_bans', 'total_failures']);

const CACHE_TTL_MS = 30_000;
/** @type {Map<string, {value: object, expiresAt: number}>} */
const cache = new Map();

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
        dm_message: row.dm_message ?? DEFAULT_DM_MESSAGE,
        dm_ban_message: row.dm_ban_message ?? DEFAULT_DM_BAN_MESSAGE,
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
        `UPDATE join_gate_settings SET total_kicks = 0, total_bans = 0, total_failures = 0, updated_at = NOW()
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
