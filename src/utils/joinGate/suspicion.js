// src/utils/joinGate/suspicion.js
/**
 * Join Gate — suspicion scoring.
 *
 * Account age answers one question: "is this account new?". Plenty of abuse
 * comes from accounts that are old enough to pass that check, and plenty of
 * legitimate people fail it. This scores a joiner across several independent
 * signals instead, and shows its arithmetic.
 *
 * Three principles, because they are what make this usable rather than another
 * opaque black box:
 *
 *  1. TRUST SIGNALS SUBTRACT. Nitro, badges and a genuinely old account pull
 *     the score DOWN. A purely additive scorer flags every real newcomer,
 *     which is exactly how these systems end up ignored.
 *  2. EVERY DECISION SHOWS ITS WORK. Each signal reports its own points and a
 *     human-readable reason, so a flag can be argued with.
 *  3. SCRIPT IS NOT SUSPICION. The name checks look for mixed scripts WITHIN A
 *     SINGLE WORD, which is the actual homoglyph impersonation trick. A name
 *     written wholly in Cyrillic, Greek, Arabic or CJK is perfectly ordinary
 *     and is never penalised for it.
 *
 * Scoring is pure and side-effect free, so the panel can backtest it against
 * existing members without touching anyone.
 */

const { SnowflakeUtil } = require('discord.js');

const DAY_MS = 86_400_000;

// ── Tunable weights ─────────────────────────────────────────────────────────

/**
 * Default points per signal. Every one of these can be overridden per guild.
 * Negative numbers are trust signals.
 */
const DEFAULT_WEIGHTS = Object.freeze({
    default_avatar: 18,
    no_global_name: 6,
    invisible_chars: 32,
    mixed_script: 30,
    digit_suffix: 12,
    random_name: 14,
    symbol_spam: 8,
    scam_keyword: 22,
    impersonation: 30,
    creation_cluster: 26,
    avatar_collision: 30,
    name_similarity: 20,
    join_burst: 10,
    nitro_avatar: -22,
    has_badges: -26,
});

/** Account age contributes on a curve rather than as a cliff. */
const AGE_BANDS = Object.freeze([
    { maxDays: 1, points: 35, label: 'under a day old' },
    { maxDays: 3, points: 28, label: 'under 3 days old' },
    { maxDays: 7, points: 22, label: 'under a week old' },
    { maxDays: 30, points: 12, label: 'under a month old' },
    { maxDays: 90, points: 4, label: 'under 3 months old' },
    { maxDays: 365, points: 0, label: 'under a year old' },
    { maxDays: 1095, points: -10, label: 'over a year old' },
    { maxDays: Infinity, points: -20, label: 'over 3 years old' },
]);

const DEFAULT_SCAM_KEYWORDS = Object.freeze([
    'free nitro', 'nitro free', 'discord nitro', 'steam gift', 'free gift',
    'airdrop', 'crypto', 'giveaway bot', 'moderator', 'admin', 'support team',
    'system', 'discord staff', 'onlyfans', 'teen', 'nudes',
]);

const DEFAULT_THRESHOLDS = Object.freeze({ watch: 40, suspect: 70, malicious: 100 });

/** Discord badges. Holding any of them is meaningful evidence of a real account. */
const TRUST_FLAGS = [
    'Staff', 'Partner', 'Hypesquad', 'BugHunterLevel1', 'BugHunterLevel2',
    'HypeSquadOnlineHouse1', 'HypeSquadOnlineHouse2', 'HypeSquadOnlineHouse3',
    'PremiumEarlySupporter', 'VerifiedDeveloper', 'CertifiedModerator', 'ActiveDeveloper',
];

// ── Text analysis ───────────────────────────────────────────────────────────

/**
 * Zero-width, bidi-override and soft-hyphen characters.
 *
 * Built through the RegExp constructor so the escapes stay escapes: writing
 * these as literals puts genuinely invisible bytes into the source, which is
 * unreadable, easy to mangle, and trips no-irregular-whitespace.
 */
const INVISIBLE_RE = new RegExp('[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF\\u00AD]');

/**
 * Scripts that contain visually identical letters. Mixing them inside one word
 * is the homoglyph trick (an "admin" whose 'a' is Cyrillic). Using one of them
 * for a whole name is just writing in that language, and is never penalised.
 */
const CONFUSABLE_SCRIPTS = [
    ['latin', /[A-Za-z]/],
    ['cyrillic', new RegExp('[\\u0400-\\u04FF]')],
    ['greek', new RegExp('[\\u0370-\\u03FF]')],
];

const VOWELS = /[aeiouyAEIOUY]/;

function hasInvisibleChars(name) {
    return INVISIBLE_RE.test(String(name ?? ''));
}

/** True only when a single token mixes two confusable scripts. */
function hasMixedScriptToken(name) {
    for (const token of String(name ?? '').split(/[\s_\-.|]+/)) {
        if (token.length < 2) continue;
        const present = CONFUSABLE_SCRIPTS.filter(([, re]) => re.test(token));
        if (present.length >= 2) return true;
    }
    return false;
}

function hasDigitSuffix(name) {
    return /\d{4,}$/.test(String(name ?? ''));
}

/** Consonant soup: long, all letters, almost no vowels. */
function looksRandom(name) {
    const stripped = String(name ?? '').replace(/[^A-Za-z]/g, '');
    if (stripped.length < 8) return false;
    const vowels = stripped.split('').filter(c => VOWELS.test(c)).length;
    return vowels / stripped.length < 0.25;
}

function hasSymbolSpam(name) {
    const symbols = String(name ?? '').replace(/[\p{L}\p{N}\s._-]/gu, '');
    return symbols.length >= 4;
}

/**
 * Folds a name down for comparison: lowercase, confusable digits mapped back
 * to letters, everything non-alphanumeric removed. "A_d_m1n!!" -> "admin".
 */
function foldName(name) {
    return String(name ?? '')
        .toLowerCase()
        .replace(/0/g, 'o').replace(/1/g, 'l').replace(/3/g, 'e')
        .replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't')
        .replace(/[^a-z0-9]/g, '');
}

function matchesScamKeyword(name, keywords) {
    const haystack = String(name ?? '').toLowerCase();
    const folded = foldName(name);
    return keywords.find(kw => {
        const k = String(kw).toLowerCase().trim();
        if (!k) return false;
        return haystack.includes(k) || folded.includes(foldName(k));
    }) || null;
}

/**
 * Impersonation of a protected name (staff display names, the server name).
 * Requires a fold-equal match or containment of a reasonably long name, so
 * short nicknames do not match half the server.
 */
function matchesProtectedName(name, protectedNames) {
    const folded = foldName(name);
    if (folded.length < 3) return null;

    for (const protectedName of protectedNames) {
        const target = foldName(protectedName);
        if (target.length < 4) continue;
        if (folded === target) return protectedName;
        if (folded.includes(target) || target.includes(folded)) return protectedName;
    }
    return null;
}

// ── Recent-join correlation ─────────────────────────────────────────────────

const JOIN_WINDOW_MS = 10 * 60_000;
const CLUSTER_WINDOW_MS = 30 * 60_000;
const MAX_TRACKED_PER_GUILD = 200;

/** guildId -> recent joiners, for cross-member correlation. */
const recentJoins = new Map();

function pruneJoins(list, now) {
    const cutoff = now - JOIN_WINDOW_MS;
    const kept = list.filter(entry => entry.at >= cutoff);
    return kept.length > MAX_TRACKED_PER_GUILD ? kept.slice(-MAX_TRACKED_PER_GUILD) : kept;
}

/**
 * Records a joiner so later arrivals can be correlated against them.
 * Called for every join, including ones that pass every check: a raid is only
 * visible as a group.
 */
function recordJoin(guildId, user, now = Date.now()) {
    const list = pruneJoins(recentJoins.get(guildId) ?? [], now);
    list.push({
        id: user.id,
        username: String(user.username ?? ''),
        avatar: user.avatar ?? null,
        createdTimestamp: Number(user.createdTimestamp),
        at: now,
    });
    recentJoins.set(guildId, list);
}

/** Everything the correlation signals need, computed against the live window. */
function correlateJoin(guildId, user, now = Date.now()) {
    const list = pruneJoins(recentJoins.get(guildId) ?? [], now).filter(e => e.id !== user.id);
    const createdTimestamp = Number(user.createdTimestamp);
    const foldedSelf = foldName(user.username).replace(/\d+/g, '');

    const cohort = list.filter(e => Math.abs(e.createdTimestamp - createdTimestamp) <= CLUSTER_WINDOW_MS);
    const sharedAvatar = user.avatar
        ? list.filter(e => e.avatar && e.avatar === user.avatar)
        : [];
    const similarNames = list.filter(e => {
        const folded = foldName(e.username).replace(/\d+/g, '');
        if (!folded || !foldedSelf) return false;
        if (folded === foldedSelf) return true;
        const shortest = Math.min(folded.length, foldedSelf.length);
        return shortest >= 6 && folded.slice(0, 6) === foldedSelf.slice(0, 6);
    });

    return {
        windowSize: list.length + 1,
        cohortSize: cohort.length,
        sharedAvatarCount: sharedAvatar.length,
        similarNameCount: similarNames.length,
    };
}

function resetCorrelation(guildId) {
    if (guildId) recentJoins.delete(guildId);
    else recentJoins.clear();
}

// ── Scoring ─────────────────────────────────────────────────────────────────

function weightOf(weights, id) {
    const override = weights?.[id];
    return Number.isFinite(Number(override)) ? Number(override) : DEFAULT_WEIGHTS[id];
}

/**
 * Scores one account.
 *
 * Pure: no API calls, no database, no mutation. `correlation` and
 * `protectedNames` are passed in so the panel can score existing members
 * without any of that context.
 *
 * @param {object} user               discord.js User (or a plain shape in tests)
 * @param {object} options
 * @param {object} [options.weights]        per-guild weight overrides
 * @param {string[]} [options.keywords]     scam keyword list
 * @param {string[]} [options.protectedNames] staff/server names to guard
 * @param {object} [options.correlation]    output of correlateJoin()
 * @param {boolean} [options.inBurst]       gate reported a join burst
 * @param {number} [options.now]
 * @returns {{score: number, tier: string, signals: Array<{id,label,points,detail}>}}
 */
function scoreAccount(user, options = {}) {
    const {
        weights = {},
        keywords = DEFAULT_SCAM_KEYWORDS,
        protectedNames = [],
        correlation = null,
        inBurst = false,
        thresholds = DEFAULT_THRESHOLDS,
        now = Date.now(),
    } = options;

    const signals = [];
    const add = (id, label, points, detail) => {
        if (!points) return;
        signals.push({ id, label, points, detail });
    };

    const createdTimestamp = Number(
        user.createdTimestamp ?? SnowflakeUtil.timestampFrom(user.id)
    );
    const ageDays = (now - createdTimestamp) / DAY_MS;
    const name = user.username ?? '';

    // 1. Account age, on a curve, negative once the account is genuinely old.
    const band = AGE_BANDS.find(b => ageDays < b.maxDays) ?? AGE_BANDS[AGE_BANDS.length - 1];
    add('account_age', 'Account age', band.points, `${ageDays.toFixed(1)}d (${band.label})`);

    // 2. Profile shape.
    if (!user.avatar) add('default_avatar', 'Default avatar', weightOf(weights, 'default_avatar'), 'never set one');
    if (!user.globalName) add('no_global_name', 'No display name', weightOf(weights, 'no_global_name'), 'username only');
    if (typeof user.avatar === 'string' && user.avatar.startsWith('a_')) {
        add('nitro_avatar', 'Animated avatar', weightOf(weights, 'nitro_avatar'), 'has (or had) Nitro');
    }

    const flagNames = (() => {
        try { return user.flags?.toArray?.() ?? []; } catch { return []; }
    })();
    const badges = flagNames.filter(f => TRUST_FLAGS.includes(f));
    if (badges.length > 0) {
        add('has_badges', 'Discord badges', weightOf(weights, 'has_badges'), badges.slice(0, 3).join(', '));
    }

    // 3. Name heuristics.
    if (hasInvisibleChars(name)) {
        add('invisible_chars', 'Hidden characters', weightOf(weights, 'invisible_chars'), 'zero-width or bidi control chars');
    }
    if (hasMixedScriptToken(name)) {
        add('mixed_script', 'Mixed-script name', weightOf(weights, 'mixed_script'), 'one word mixes lookalike alphabets');
    }
    if (hasDigitSuffix(name)) {
        add('digit_suffix', 'Digit suffix', weightOf(weights, 'digit_suffix'), 'name ends in 4+ digits');
    }
    if (looksRandom(name)) {
        add('random_name', 'Random-looking name', weightOf(weights, 'random_name'), 'almost no vowels');
    }
    if (hasSymbolSpam(name)) {
        add('symbol_spam', 'Symbol-heavy name', weightOf(weights, 'symbol_spam'), '4+ decorative symbols');
    }

    const keywordHit = matchesScamKeyword(name, keywords);
    if (keywordHit) {
        add('scam_keyword', 'Scam keyword', weightOf(weights, 'scam_keyword'), `matched "${keywordHit}"`);
    }

    const impersonated = matchesProtectedName(name, protectedNames);
    if (impersonated) {
        add('impersonation', 'Possible impersonation', weightOf(weights, 'impersonation'), `resembles "${impersonated}"`);
    }

    // 4. Correlation against other recent joiners.
    if (correlation) {
        if (correlation.cohortSize >= 2) {
            add('creation_cluster', 'Created alongside others', weightOf(weights, 'creation_cluster'),
                `${correlation.cohortSize} other joiner(s) made within 30min of this account`);
        }
        if (correlation.sharedAvatarCount >= 1) {
            add('avatar_collision', 'Shared avatar', weightOf(weights, 'avatar_collision'),
                `identical avatar to ${correlation.sharedAvatarCount} other joiner(s)`);
        }
        if (correlation.similarNameCount >= 1) {
            add('name_similarity', 'Similar name', weightOf(weights, 'name_similarity'),
                `near-identical to ${correlation.similarNameCount} other joiner(s)`);
        }
    }
    if (inBurst) {
        add('join_burst', 'Arrived in a burst', weightOf(weights, 'join_burst'), 'joined during a detected burst');
    }

    const raw = signals.reduce((sum, s) => sum + s.points, 0);
    const score = Math.max(0, raw);

    return { score, tier: tierFor(score, thresholds), signals };
}

function tierFor(score, thresholds = DEFAULT_THRESHOLDS) {
    if (score >= thresholds.malicious) return 'malicious';
    if (score >= thresholds.suspect) return 'suspect';
    if (score >= thresholds.watch) return 'watch';
    return 'clear';
}

/** Renders the arithmetic for a log embed. */
function explain(result) {
    if (result.signals.length === 0) return 'no signals fired';
    return result.signals
        .slice()
        .sort((a, b) => b.points - a.points)
        .map(s => `${s.points > 0 ? '+' : ''}${s.points} ${s.label} (${s.detail})`)
        .join('\n');
}

module.exports = {
    DAY_MS,
    DEFAULT_WEIGHTS,
    DEFAULT_SCAM_KEYWORDS,
    DEFAULT_THRESHOLDS,
    AGE_BANDS,
    TRUST_FLAGS,
    scoreAccount,
    tierFor,
    explain,
    recordJoin,
    correlateJoin,
    resetCorrelation,
    // exported for tests
    hasInvisibleChars,
    hasMixedScriptToken,
    hasDigitSuffix,
    looksRandom,
    hasSymbolSpam,
    foldName,
    matchesScamKeyword,
    matchesProtectedName,
};
