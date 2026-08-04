// src/utils/casinoConfig.js
/**
 * Casino settings, owner-tunable at runtime.
 *
 * These live in the generic speak_config key/value table rather than in a new
 * one: it is already a JSONB store with a short read cache, and a second
 * near-identical table would be two things to keep in step.
 *
 * Every value here has a default that reproduces the behaviour the casino had
 * before this module existed, so an untouched install changes nothing.
 */

const { getSpeakConfigValue, setSpeakConfigValue, invalidateSpeakConfig } = require('./db');

const DEFAULTS = Object.freeze({
    // 0 means no ceiling. Expressed that way because "unlimited" has to be
    // representable in a number field the owner types into.
    min_bet: 1,
    max_bet: 0,
    daily_base: 500,
    daily_streak_bonus: 100,
    /** Streak days past this stop increasing the payout. */
    daily_streak_cap: 30,
    /** Live heckling is a new automatic behaviour, so it starts off. */
    heckle_enabled: false,
    /** Minimum seconds between two spoken heckles, anywhere. */
    heckle_cooldown_seconds: 1800,
    /** A round has to move at least this much before it is worth remarking on. */
    heckle_threshold: 5000,
});

const KEY_PREFIX = 'casino_';

const LIMITS = Object.freeze({
    min_bet: { min: 1, max: 1_000_000 },
    max_bet: { min: 0, max: 1_000_000_000 },
    daily_base: { min: 0, max: 1_000_000 },
    daily_streak_bonus: { min: 0, max: 100_000 },
    daily_streak_cap: { min: 1, max: 3650 },
    heckle_cooldown_seconds: { min: 60, max: 86_400 },
    heckle_threshold: { min: 1, max: 100_000_000 },
});

function clamp(value, key) {
    const bound = LIMITS[key];
    if (!bound) return value;
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULTS[key];
    return Math.min(bound.max, Math.max(bound.min, Math.round(n)));
}

async function getSetting(key) {
    if (!(key in DEFAULTS)) throw new Error(`Unknown casino setting: ${key}`);
    const stored = await getSpeakConfigValue(`${KEY_PREFIX}${key}`, null);
    if (stored === null || stored === undefined) return DEFAULTS[key];
    if (typeof DEFAULTS[key] === 'boolean') return Boolean(stored);
    return clamp(stored, key);
}

async function setSetting(key, value) {
    if (!(key in DEFAULTS)) throw new Error(`Unknown casino setting: ${key}`);
    const stored = typeof DEFAULTS[key] === 'boolean' ? Boolean(value) : clamp(value, key);
    await setSpeakConfigValue(`${KEY_PREFIX}${key}`, stored);
    return stored;
}

/** All settings at once, for the panel. */
async function getAllSettings() {
    const out = {};
    for (const key of Object.keys(DEFAULTS)) out[key] = await getSetting(key);
    return out;
}

/**
 * The bet bounds every game funnels through.
 * @returns {Promise<{min: number, max: number}>} `max` is Infinity when unset.
 */
async function getBetLimits() {
    const min = await getSetting('min_bet');
    const max = await getSetting('max_bet');
    return { min, max: max > 0 ? max : Infinity };
}

function invalidate() {
    for (const key of Object.keys(DEFAULTS)) invalidateSpeakConfig(`${KEY_PREFIX}${key}`);
}

module.exports = {
    DEFAULTS,
    LIMITS,
    KEY_PREFIX,
    getSetting,
    setSetting,
    getAllSettings,
    getBetLimits,
    invalidate,
};
