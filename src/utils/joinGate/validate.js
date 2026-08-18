// src/utils/joinGate/validate.js
/**
 * Join Gate: what counts as a valid setting, in one place.
 *
 * These rules used to live inline inside the panel's interaction handlers,
 * tangled up with modals and ephemeral replies. That was fine while the panel
 * was the only way to change anything. The moment a second writer exists, two
 * copies of "a timeout may not exceed 28 days" is how one of them ends up
 * wrong, and the wrong one is the one nobody tested.
 *
 * Everything here is pure: strings in, a decision out. No discord.js, no
 * interaction, no database. That is what makes it testable, and what lets a web
 * form and a Discord modal share one definition of correct rather than two.
 *
 * PERMISSIONS ARE DECLARED, NOT CHECKED. A pure function cannot ask Discord
 * whether the bot may ban. So a validator that produces a ban action reports
 * `requires: ['BanMembers']` and the caller, which has the guild, enforces it.
 * The alternative is a browser form quietly arming an action the bot cannot
 * carry out, which is exactly the failure the panel already guards against.
 */

const { LIMITS, TIER_ACTIONS, clamp, daysToMinutes, DAY_MINUTES } = require('./config');
const { DEFAULT_WEIGHTS } = require('./suspicion');
const { BEHAVIOUR_WEIGHTS, COMBO_WEIGHTS } = require('./watch');

/**
 * Every signal a weight override may name: the profile scorer's, the
 * behaviour window's, and its combinations. One blob, one validator. The
 * behaviour keys were missing for a while, which made the automod_keyword
 * comment ("an owner can raise it deliberately") impossible to act on: the
 * only path to raising it rejected the key as unrecognised.
 */
const KNOWN_WEIGHTS = Object.freeze({ ...DEFAULT_WEIGHTS, ...BEHAVIOUR_WEIGHTS, ...COMBO_WEIGHTS });

const SNOWFLAKE_RE = /^\d{17,20}$/;
const INVITE_RE = /^https:\/\/(discord\.gg|discord\.com\/invite|discordapp\.com\/invite)\/[A-Za-z0-9-]+$/;

const WEIGHT_BOUNDS = { min: -100, max: 100 };
const THRESHOLD_BOUNDS = { min: 1, max: 500 };
const WATCH_WINDOW_BOUNDS = { min: 1, max: 1440 };
const WATCH_AT_BOUNDS = { min: 1, max: 500 };
const TENURE_GRACE_BOUNDS = { min: 0, max: 3650 };
const GUARD_WINDOW_BOUNDS = { min: 5, max: 3600 };
const GUARD_LIMIT_BOUNDS = { min: 1, max: 100 };

const ok = (patch, summary, requires = []) => ({ ok: true, patch, summary, requires });
const bad = error => ({ ok: false, error });

/** Which permission an action needs before it is worth arming. */
const ACTION_PERMISSION = Object.freeze({
    ban: 'BanMembers',
    kick: 'KickMembers',
    timeout: 'ModerateMembers',
});

/**
 * Every simple numeric field, its bounds, and how it is written.
 *
 * A table rather than a pile of one-off handlers, because a web form needs to
 * render these and a modal needs to validate them, and both should be reading
 * the same row.
 */
const NUMERIC_FIELDS = Object.freeze({
    min_account_age_minutes: { bounds: LIMITS.MIN_AGE_MINUTES, unit: 'days', label: 'Minimum account age' },
    dm_cooldown_minutes: { bounds: LIMITS.DM_COOLDOWN_MINUTES, unit: 'minutes', label: 'Re-DM cooldown' },
    escalate_after_attempts: { bounds: LIMITS.ESCALATE_ATTEMPTS, unit: 'attempts', label: 'Ban after attempts' },
    suspicion_ban_hours: { bounds: LIMITS.BAN_HOURS, unit: 'hours', label: 'Suspicion ban length' },
    watch_ban_hours: { bounds: LIMITS.BAN_HOURS, unit: 'hours', label: 'Behaviour ban length' },
    watch_timeout_minutes: { bounds: LIMITS.TIMEOUT_MINUTES, unit: 'minutes', label: 'Watch timeout length' },
    watch_window_minutes: { bounds: WATCH_WINDOW_BOUNDS, unit: 'minutes', label: 'Watch window' },
    watch_action_at: { bounds: WATCH_AT_BOUNDS, unit: 'points', label: 'Watch acts at' },
    suspicion_tenure_grace_days: { bounds: TENURE_GRACE_BOUNDS, unit: 'days', label: 'Tenure grace' },
    burst_threshold: { bounds: LIMITS.BURST_THRESHOLD, unit: 'joins', label: 'Burst trigger' },
    burst_window_seconds: { bounds: LIMITS.BURST_WINDOW_SECONDS, unit: 'seconds', label: 'Burst window' },
    sweep_window_hours: { bounds: LIMITS.SWEEP_WINDOW_HOURS, unit: 'hours', label: 'Catch-up window' },
    guard_window_seconds: { bounds: GUARD_WINDOW_BOUNDS, unit: 'seconds', label: 'Guard window' },
    guard_delete_limit: { bounds: GUARD_LIMIT_BOUNDS, unit: 'actions', label: 'Deletions before alert' },
    guard_create_limit: { bounds: GUARD_LIMIT_BOUNDS, unit: 'actions', label: 'Creations before alert' },
    guard_perm_limit: { bounds: GUARD_LIMIT_BOUNDS, unit: 'actions', label: 'Permission grants before alert' },
    guard_webhook_limit: { bounds: GUARD_LIMIT_BOUNDS, unit: 'actions', label: 'Webhooks before alert' },
});

/**
 * One numeric field.
 *
 * Rejects junk rather than clamping it: "abc" is a mistake, and silently
 * storing the minimum would tell the owner their setting saved when it did not.
 * A number merely out of range IS clamped, because "500 days" plainly means
 * "the most you will let me have".
 */
function numericField(key, raw) {
    const field = NUMERIC_FIELDS[key];
    if (!field) return bad(`${key} is not a numeric setting.`);

    const cleaned = String(raw ?? '').trim().replace(',', '.');
    if (cleaned === '') return bad(`${field.label} cannot be blank.`);

    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed)) return bad(`${field.label}: "${raw}" is not a number.`);
    if (parsed < 0) return bad(`${field.label} cannot be negative.`);

    const value = field.unit === 'days' && key === 'min_account_age_minutes'
        ? clamp(daysToMinutes(parsed), field.bounds)
        : clamp(parsed, field.bounds);

    return ok({ [key]: value }, `${field.label} set to ${value}`);
}

/** Suspicion tiers, which have to rise. */
function thresholds({ watch, suspect, malicious }) {
    for (const [label, raw] of [['watch', watch], ['suspect', suspect], ['malicious', malicious]]) {
        if (!Number.isFinite(Number(String(raw).trim()))) return bad(`The ${label} threshold is not a number.`);
    }
    const w = clamp(Number(watch), THRESHOLD_BOUNDS);
    const s = clamp(Number(suspect), THRESHOLD_BOUNDS);
    const m = clamp(Number(malicious), THRESHOLD_BOUNDS);

    if (!(w <= s && s <= m)) {
        return bad(`Thresholds must rise: watch (${w}) <= suspect (${s}) <= malicious (${m}).`);
    }
    return ok(
        { suspicion_watch_at: w, suspicion_suspect_at: s, suspicion_malicious_at: m },
        `Thresholds set to ${w} / ${s} / ${m}`
    );
}

/** The action each tier takes. Declares the permissions those actions need. */
function tierActions({ watch, suspect, malicious }) {
    const picked = [watch, suspect, malicious].map(a => String(a ?? '').trim().toLowerCase());
    const unknown = picked.filter(a => !TIER_ACTIONS.includes(a));
    if (unknown.length) {
        return bad(`Unknown action(s): ${unknown.join(', ')}. Use one of: ${TIER_ACTIONS.join(', ')}.`);
    }
    return ok(
        {
            suspicion_watch_action: picked[0],
            suspicion_suspect_action: picked[1],
            suspicion_malicious_action: picked[2],
        },
        `Tier actions set to ${picked.join(' / ')}`,
        permissionsFor(picked)
    );
}

/** The watch window's length, bar and action, which move together. */
function watchWindow({ minutes, at, action, timeout }) {
    const verdictMinutes = numericField('watch_window_minutes', minutes);
    if (!verdictMinutes.ok) return verdictMinutes;
    const verdictAt = numericField('watch_action_at', at);
    if (!verdictAt.ok) return verdictAt;

    const chosen = String(action ?? '').trim().toLowerCase();
    if (!TIER_ACTIONS.includes(chosen)) {
        return bad(`Unknown action "${chosen}". Use one of: ${TIER_ACTIONS.join(', ')}.`);
    }

    const patch = {
        ...verdictMinutes.patch,
        ...verdictAt.patch,
        watch_action: chosen,
    };

    // Blank keeps whatever is stored: the field is optional and an empty box
    // means "leave it", not "set it to zero".
    const timeoutRaw = String(timeout ?? '').trim();
    if (timeoutRaw !== '') {
        const verdictTimeout = numericField('watch_timeout_minutes', timeoutRaw);
        if (!verdictTimeout.ok) return verdictTimeout;
        Object.assign(patch, verdictTimeout.patch);
    }

    const summary = `Watch window: ${patch.watch_window_minutes} min, act at ${patch.watch_action_at} -> ${chosen}`
        + (chosen === 'timeout' && patch.watch_timeout_minutes ? ` for ${patch.watch_timeout_minutes} min` : '');

    return ok(patch, summary, permissionsFor([chosen]));
}

/** The guard's four counters and its window. */
function guardLimits({ window, del, cre, perm, hook }) {
    const patch = {};
    const pairs = [
        ['guard_window_seconds', window],
        ['guard_delete_limit', del],
        ['guard_create_limit', cre],
        ['guard_perm_limit', perm],
        ['guard_webhook_limit', hook],
    ];
    for (const [key, raw] of pairs) {
        const verdict = numericField(key, raw);
        if (!verdict.ok) return verdict;
        Object.assign(patch, verdict.patch);
    }
    return ok(
        patch,
        `Guard limits: ${patch.guard_delete_limit} deleted, ${patch.guard_create_limit} created, `
        + `${patch.guard_perm_limit} permission grants, ${patch.guard_webhook_limit} webhooks `
        + `per ${patch.guard_window_seconds}s`
    );
}

/**
 * Per-signal weight overrides, given as `key=value` lines.
 *
 * An unrecognised key is an error rather than a silent skip: a typo that saves
 * cleanly and changes nothing is worse than one that complains, because the
 * owner walks away believing the tuning took.
 */
function weights(text) {
    const parsed = {};
    const unknown = [];

    for (const line of String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean)) {
        const [key, value] = line.split('=').map(p => p?.trim());
        if (!key || !Object.prototype.hasOwnProperty.call(KNOWN_WEIGHTS, key)) { unknown.push(line); continue; }
        const points = Number(value);
        if (!Number.isFinite(points)) { unknown.push(line); continue; }
        parsed[key] = clamp(points, WEIGHT_BOUNDS);
    }

    if (unknown.length) {
        return bad(
            `Unrecognised line(s): ${unknown.join(', ')}\n`
            + `Profile signals: ${Object.keys(DEFAULT_WEIGHTS).join(', ')}\n`
            + `Behaviour signals: ${[...Object.keys(BEHAVIOUR_WEIGHTS), ...Object.keys(COMBO_WEIGHTS)].join(', ')}`
        );
    }
    return ok(
        { suspicion_weights: parsed },
        Object.keys(parsed).length
            ? `Weight overrides set (${Object.keys(parsed).length})`
            : 'Weight overrides cleared, back to defaults'
    );
}

/**
 * A list of user IDs from free text.
 *
 * Silently dropping something that is not a snowflake would mean silently not
 * exempting somebody the owner believes is exempt.
 */
function userIds(text, { max = LIMITS.EXEMPT_IDS } = {}) {
    const tokens = String(text ?? '')
        .split(/[\s,]+/).map(s => s.trim().replace(/^<@!?/, '').replace(/>$/, '')).filter(Boolean);

    const valid = [];
    const invalid = [];
    for (const token of tokens) {
        if (SNOWFLAKE_RE.test(token)) valid.push(token);
        else invalid.push(token);
    }
    if (invalid.length) return bad(`Not user IDs: ${invalid.slice(0, 8).join(', ')}`);

    const unique = [...new Set(valid)];
    if (unique.length > max) return bad(`That is ${unique.length} IDs; the limit is ${max}.`);
    // No patch: the caller decides which column this list belongs in, since the
    // same parser serves the gate's exempt list and the guard's.
    return { ok: true, ids: unique, summary: `${unique.length} user ID(s)` };
}

/**
 * The invite offered to someone who was removed.
 *
 * Restricted to Discord invites on purpose: this string is DMed to strangers,
 * so it must never become an arbitrary-link vector.
 */
function inviteUrl(raw) {
    const url = String(raw ?? '').trim();
    if (!url) return ok({ dm_invite_url: null }, 'Rejoin invite cleared');
    if (!INVITE_RE.test(url)) {
        return bad('Only Discord invite links are accepted (https://discord.gg/... or https://discord.com/invite/...).');
    }
    return ok({ dm_invite_url: url }, `Rejoin invite set to ${url}`);
}

/** The permissions a set of actions needs, deduplicated. */
function permissionsFor(actions) {
    const needed = new Set();
    for (const action of actions ?? []) {
        const permission = ACTION_PERMISSION[String(action).toLowerCase()];
        if (permission) needed.add(permission);
    }
    return [...needed];
}

/**
 * Every permission a settings patch would require to be honoured.
 *
 * Used by both writers to refuse arming an action the bot cannot perform. A
 * gate that claims to ban and cannot is worse than one that is switched off,
 * because the panel reports it as armed.
 */
function permissionsForPatch(patch) {
    const actions = [
        patch?.suspicion_watch_action,
        patch?.suspicion_suspect_action,
        patch?.suspicion_malicious_action,
        patch?.watch_action,
    ].filter(Boolean);
    const needed = permissionsFor(actions);
    if (patch?.escalate_enabled === true && !needed.includes('BanMembers')) needed.push('BanMembers');
    if (patch?.guard_enabled === true) needed.push('ViewAuditLog');
    return needed;
}

module.exports = {
    numericField,
    thresholds,
    tierActions,
    watchWindow,
    guardLimits,
    weights,
    userIds,
    inviteUrl,
    permissionsFor,
    permissionsForPatch,
    NUMERIC_FIELDS,
    ACTION_PERMISSION,
    SNOWFLAKE_RE,
    INVITE_RE,
    DAY_MINUTES,
};
