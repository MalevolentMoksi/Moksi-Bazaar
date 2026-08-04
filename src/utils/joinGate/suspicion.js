// src/utils/joinGate/suspicion.js
/**
 * Join Gate: suspicion scoring.
 *
 * Account age answers one question: "is this account new?". Plenty of abuse
 * comes from accounts old enough to pass that check, and plenty of legitimate
 * people fail it. This scores a joiner across many independent signals
 * instead, and shows its arithmetic.
 *
 * Design rules this file exists to keep honest:
 *
 *  1. TRUST IS CAPPED. Nitro, badges and a banner mean "probably not a fully
 *     automated bot". They do NOT mean "not malicious". Their combined pull is
 *     clamped, so a paid-for profile can never launder an otherwise damning
 *     account down to clear.
 *  2. COMBINATIONS BEAT SUMS. A default avatar is weak evidence. A default
 *     avatar plus a gibberish username plus a digit suffix is a bulk-registered
 *     account, and a linear sum badly under-rates that. Combos add on top.
 *  3. TENURE FORGIVES. Someone who has been in the server for months is not
 *     who this is for. Long membership damps the score hard.
 *  4. SCRIPT IS NOT SUSPICION. Name checks look for mixed scripts WITHIN A
 *     SINGLE WORD, the actual homoglyph trick. A name written wholly in
 *     Cyrillic, Greek, Arabic or CJK is ordinary and is never penalised.
 *     Nor is a transliteration of one: Discord forces usernames into
 *     [a-z0-9._], so a member whose name is written in an abjad has to drop
 *     the vowels to fit, and the result must not read as generator output.
 *  5. EVERY DECISION SHOWS ITS WORK.
 *
 * Scoring is pure and side-effect free, so the panel can backtest it against
 * existing members without touching anyone.
 */

const { SnowflakeUtil, UserFlags } = require('discord.js');

const DAY_MS = 86_400_000;

// ── Tunable weights ─────────────────────────────────────────────────────────

const DEFAULT_WEIGHTS = Object.freeze({
    // Discord's own verdict. Near-conclusive on its own.
    discord_spammer: 85,
    discord_quarantined: 85,
    // Profile shape
    default_avatar: 18,
    no_global_name: 6,
    // Name heuristics
    invisible_chars: 32,
    mixed_script: 30,
    digit_suffix: 12,
    gibberish_name: 20,
    symbol_spam: 8,
    scam_keyword: 22,
    impersonation: 30,
    // Raid correlation
    creation_cluster: 26,
    avatar_collision: 30,
    name_similarity: 20,
    join_burst: 10,
    invite_flood: 22,
    // Combinations
    bulk_signature: 25,
    generated_name: 15,
    fresh_throwaway: 18,
    barren_profile: 10,
    // Trust (negative, and collectively capped by TRUST_CAP)
    nitro_avatar: -12,
    has_badges: -18,
    has_banner: -8,
    server_booster: -14,
    server_tag: -8,
    rich_presence: -8,
});

/**
 * Ceilings on how far the profile-trust signals can pull a score down.
 *
 * Two limits, because one is not enough. The absolute cap stops a stack of
 * purchases subtracting 50+ points outright. The proportional cap is the more
 * important one: trust may cancel at most this fraction of whatever suspicion
 * was found, so the worse an account looks, the less a subscription can excuse.
 *
 * Buying Nitro is evidence of not being a throwaway bot. It is not evidence of
 * good intent, and it must never be able to clear a genuinely bad profile.
 */
const TRUST_CAP = 35;
const TRUST_MAX_FRACTION = 0.4;

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

/**
 * How much being a long-standing member forgives. Applied outside TRUST_CAP:
 * this is the "stop bothering me about my regulars" dial.
 */
const TENURE_BANDS = Object.freeze([
    { maxDays: 7, points: 0, label: 'joined this week' },
    { maxDays: 30, points: -10, label: 'member for weeks' },
    { maxDays: 90, points: -25, label: 'member for months' },
    { maxDays: 365, points: -40, label: 'member for months' },
    { maxDays: Infinity, points: -60, label: 'member for over a year' },
]);

/**
 * The grace days that reproduce TENURE_BANDS exactly: the boundary where the
 * outermost band (full forgiveness) begins. The per-guild
 * `suspicion_tenure_grace_days` dial scales every band boundary by
 * graceDays / this value, so the points per band never change; only how long
 * each forgiveness step takes to earn stretches or compresses.
 */
const DEFAULT_TENURE_GRACE_DAYS = 365;

const DEFAULT_SCAM_KEYWORDS = Object.freeze([
    'free nitro', 'nitro free', 'discord nitro', 'steam gift', 'free gift',
    'airdrop', 'giveaway bot', 'moderator', 'admin', 'support team',
    'system', 'discord staff', 'onlyfans', 'nudes',
]);

const DEFAULT_THRESHOLDS = Object.freeze({ watch: 40, suspect: 70, malicious: 100 });

/** Badges that indicate a real, lived-in account. */
const TRUST_FLAGS = [
    'Staff', 'Partner', 'Hypesquad', 'BugHunterLevel1', 'BugHunterLevel2',
    'HypeSquadOnlineHouse1', 'HypeSquadOnlineHouse2', 'HypeSquadOnlineHouse3',
    'PremiumEarlySupporter', 'VerifiedDeveloper', 'CertifiedModerator', 'ActiveDeveloper',
];

// ── Text analysis ───────────────────────────────────────────────────────────

/**
 * Zero-width, bidi-override and soft-hyphen characters. Built through the
 * RegExp constructor so the escapes stay escapes rather than becoming literal
 * invisible bytes in the source.
 */
const INVISIBLE_RE = new RegExp('[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF\\u00AD]');

/**
 * Scripts containing visually identical letters. Mixing them inside one word
 * is the homoglyph trick (an "admin" whose 'a' is Cyrillic). Using one of them
 * for a whole name is just writing in that language, and is never penalised.
 */
const CONFUSABLE_SCRIPTS = [
    ['latin', /[A-Za-z]/],
    ['cyrillic', new RegExp('[\\u0400-\\u04FF]')],
    ['greek', new RegExp('[\\u0370-\\u03FF]')],
];

/** y counts as a vowel, so it breaks a run rather than extending one. */
const CONSONANT_RE = /[bcdfghjklmnpqrstvwxz]/;

function hasInvisibleChars(name) {
    return INVISIBLE_RE.test(String(name ?? ''));
}

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

/** Longest run of consecutive consonants, treating y as a vowel. */
function maxConsonantRun(letters) {
    let max = 0;
    let run = 0;
    for (const ch of letters.toLowerCase()) {
        if (CONSONANT_RE.test(ch)) { run++; if (run > max) max = run; }
        else run = 0;
    }
    return max;
}

/**
 * Machine-generated name detection, for Latin-script text.
 *
 * A long run of consonants is the tell: bulk-generated usernames such as
 * "jxglybtecdmzfhwc" string five or more together constantly, and words people
 * chose to type essentially never do.
 *
 * There used to be a second test on vowel density (under 18% across ten or more
 * letters). It flagged "schwartzmann" and every other Germanic compound, and it
 * caught nothing the run test missed: with one vowel in ten letters the nine
 * consonants fall into at most two runs, so a run of five is forced anyway.
 *
 * Non-Latin names strip to nothing here and are never flagged. Romanisations of
 * them are handled by the caller, which is the only place that can see the
 * display name and know one is what it is looking at.
 */
function looksRandom(name) {
    const letters = String(name ?? '').replace(/[^A-Za-z]/g, '');
    if (letters.length < 6) return false;
    return maxConsonantRun(letters) >= 5;
}

/**
 * True when a name is written mostly outside the Latin alphabet.
 *
 * Discord allows only [a-z0-9._] in a username, so a member whose name is
 * written in Arabic, Hebrew, Japanese, Thai or anything else has no choice but
 * to transliterate it for that field. The display name is where the real one
 * survives, and it is the evidence that the username is a transliteration.
 */
function isMostlyNonLatin(text) {
    const letters = String(text ?? '').match(/\p{L}/gu) ?? [];
    if (letters.length < 2) return false;
    const latin = letters.filter(c => /[A-Za-z]/.test(c)).length;
    return latin / letters.length < 0.5;
}

// A second exemption was considered and rejected: treating the username as
// innocent when its letters appear in order inside the display name, so that
// "mhmdslh" under "Mohammed Saleh" or "llwybrcwmwd" under "Llwybr Cwmwd" would
// clear. It works, and it is too loose. Any account can author a display name
// that spells out its own generated username and buy itself 35 points, and a
// Latin-script name dense enough to trip the run test in the first place is
// rare enough in a server this size that the trade is not worth it. A false
// report costs a glance. A bot through the gate costs more.

function hasSymbolSpam(name) {
    const symbols = String(name ?? '').replace(/[\p{L}\p{N}\s._-]/gu, '');
    return symbols.length >= 4;
}

/** Folds a name for comparison: "A_d_m1n!!" -> "admin". */
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

const recentJoins = new Map();

function pruneJoins(list, now) {
    const cutoff = now - JOIN_WINDOW_MS;
    const kept = list.filter(entry => entry.at >= cutoff);
    return kept.length > MAX_TRACKED_PER_GUILD ? kept.slice(-MAX_TRACKED_PER_GUILD) : kept;
}

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

function correlateJoin(guildId, user, now = Date.now()) {
    const list = pruneJoins(recentJoins.get(guildId) ?? [], now).filter(e => e.id !== user.id);
    const createdTimestamp = Number(user.createdTimestamp);
    const foldedSelf = foldName(user.username).replace(/\d+/g, '');

    const cohort = list.filter(e => Math.abs(e.createdTimestamp - createdTimestamp) <= CLUSTER_WINDOW_MS);
    const sharedAvatar = user.avatar ? list.filter(e => e.avatar && e.avatar === user.avatar) : [];
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

function hasFlag(user, flagName) {
    try {
        if (!UserFlags[flagName]) return false;
        return Boolean(user.flags?.has?.(UserFlags[flagName]));
    } catch {
        return false;
    }
}

/**
 * Scores one account.
 *
 * Pure. Everything contextual (correlation, protected names, membership, live
 * presence) is passed in, so the panel can score existing members offline.
 *
 * @returns {{score: number, tier: string, signals: Array, trustApplied: number, trustCapped: boolean}}
 */
function scoreAccount(user, options = {}) {
    const {
        weights = {},
        keywords = DEFAULT_SCAM_KEYWORDS,
        protectedNames = [],
        correlation = null,
        inBurst = false,
        inviteFlood = false,
        member = null,
        applyTenure = true,
        tenureGraceDays = DEFAULT_TENURE_GRACE_DAYS,
        thresholds = DEFAULT_THRESHOLDS,
        now = Date.now(),
    } = options;

    const suspicious = [];
    const trust = [];

    const add = (bucket, id, label, points, detail) => {
        if (!points) return;
        bucket.push({ id, label, points, detail });
    };
    const addSus = (id, label, points, detail) => add(suspicious, id, label, points, detail);
    const addTrust = (id, label, points, detail) => add(trust, id, label, points, detail);

    const createdTimestamp = Number(user.createdTimestamp ?? SnowflakeUtil.timestampFrom(user.id));
    const ageDays = (now - createdTimestamp) / DAY_MS;
    const name = user.username ?? '';

    // 1. Discord's own verdict. If Discord says spammer, that is not a heuristic.
    if (hasFlag(user, 'Spammer')) {
        addSus('discord_spammer', 'Flagged by Discord', weightOf(weights, 'discord_spammer'), 'account carries the Spammer flag');
    }
    if (hasFlag(user, 'Quarantined')) {
        addSus('discord_quarantined', 'Quarantined by Discord', weightOf(weights, 'discord_quarantined'), 'account is quarantined');
    }

    // 2. Account age.
    const band = AGE_BANDS.find(b => ageDays < b.maxDays) ?? AGE_BANDS[AGE_BANDS.length - 1];
    if (band.points >= 0) {
        addSus('account_age', 'Account age', band.points, `${ageDays.toFixed(1)}d (${band.label})`);
    } else {
        addTrust('account_age', 'Account age', band.points, `${ageDays.toFixed(1)}d (${band.label})`);
    }

    // 3. Profile shape.
    const defaultAvatar = !user.avatar;
    if (defaultAvatar) addSus('default_avatar', 'Default avatar', weightOf(weights, 'default_avatar'), 'never set one');
    if (!user.globalName) addSus('no_global_name', 'No display name', weightOf(weights, 'no_global_name'), 'username only');

    const animatedAvatar = typeof user.avatar === 'string' && user.avatar.startsWith('a_');
    if (animatedAvatar) addTrust('nitro_avatar', 'Animated avatar', weightOf(weights, 'nitro_avatar'), 'has (or had) Nitro');
    if (user.banner) addTrust('has_banner', 'Profile banner', weightOf(weights, 'has_banner'), 'Nitro banner set');

    const flagNames = (() => {
        try { return user.flags?.toArray?.() ?? []; } catch { return []; }
    })();
    const badges = flagNames.filter(f => TRUST_FLAGS.includes(f));
    if (badges.length > 0) {
        addTrust('has_badges', 'Discord badges', weightOf(weights, 'has_badges'), badges.slice(0, 3).join(', '));
    }

    // Server tag / clan: another thing an automated account rarely bothers with.
    if (user.primaryGuild?.identityEnabled || user.clan?.identityEnabled) {
        addTrust('server_tag', 'Server tag', weightOf(weights, 'server_tag'), 'displays a server tag');
    }

    if (member?.premiumSince || member?.premiumSinceTimestamp) {
        addTrust('server_booster', 'Server booster', weightOf(weights, 'server_booster'), 'boosting this server');
    }

    const activity = member?.presence?.activities?.find(a => a.type !== 4); // 4 = Custom Status
    if (activity) {
        addTrust('rich_presence', 'Active presence', weightOf(weights, 'rich_presence'), `doing: ${activity.name}`);
    }

    // 4. Name heuristics.
    //
    // Arabic, Hebrew, Persian and Urdu are abjads: short vowels are not
    // written. A username restricted to [a-z0-9._] therefore forces speakers of
    // those languages to produce a run of consonants to write their own name.
    // "slwlmhmd" is a real phrase, not generator output, and scoring it as one
    // penalises people for the script their name happens to be in. The display
    // name is the evidence, and it is free: a generator has no real name to
    // transliterate or shorten in the first place.
    // The exemption is deliberately narrow: the display name must be written in
    // another script. That is a fact about the text, not a judgement call, and
    // it cannot be faked into by an account that simply picks a nicer-looking
    // display name. Everything else stays flagged.
    const transliterated = isMostlyNonLatin(user.globalName);

    const gibberish = looksRandom(name) && !transliterated;
    const digitSuffix = hasDigitSuffix(name);

    if (hasInvisibleChars(name)) {
        addSus('invisible_chars', 'Hidden characters', weightOf(weights, 'invisible_chars'), 'zero-width or bidi control chars');
    }
    if (hasMixedScriptToken(name)) {
        addSus('mixed_script', 'Mixed-script name', weightOf(weights, 'mixed_script'), 'one word mixes lookalike alphabets');
    }
    if (digitSuffix) {
        addSus('digit_suffix', 'Digit suffix', weightOf(weights, 'digit_suffix'), 'name ends in 4+ digits');
    }
    if (gibberish) {
        // Not "unpronounceable". Plenty of names are hard for an English
        // speaker to pronounce and entirely ordinary to the person who has one.
        // What this actually measures is the shape a generator leaves.
        addSus('gibberish_name', 'Random-looking name', weightOf(weights, 'gibberish_name'),
            'five or more consonants in a row, with no display name to explain it');
    }
    if (hasSymbolSpam(name)) {
        addSus('symbol_spam', 'Symbol-heavy name', weightOf(weights, 'symbol_spam'), '4+ decorative symbols');
    }

    const keywordHit = matchesScamKeyword(name, keywords);
    if (keywordHit) addSus('scam_keyword', 'Scam keyword', weightOf(weights, 'scam_keyword'), `matched "${keywordHit}"`);

    const impersonated = matchesProtectedName(name, protectedNames);
    if (impersonated) addSus('impersonation', 'Possible impersonation', weightOf(weights, 'impersonation'), `resembles "${impersonated}"`);

    // 5. Correlation with other recent joiners.
    if (correlation) {
        if (correlation.cohortSize >= 2) {
            addSus('creation_cluster', 'Created alongside others', weightOf(weights, 'creation_cluster'),
                `${correlation.cohortSize} other joiner(s) made within 30min of this account`);
        }
        if (correlation.sharedAvatarCount >= 1) {
            addSus('avatar_collision', 'Shared avatar', weightOf(weights, 'avatar_collision'),
                `identical avatar to ${correlation.sharedAvatarCount} other joiner(s)`);
        }
        if (correlation.similarNameCount >= 1) {
            addSus('name_similarity', 'Similar name', weightOf(weights, 'name_similarity'),
                `near-identical to ${correlation.similarNameCount} other joiner(s)`);
        }
    }
    if (inBurst) addSus('join_burst', 'Arrived in a burst', weightOf(weights, 'join_burst'), 'joined during a detected burst');
    if (inviteFlood) addSus('invite_flood', 'Invite flood', weightOf(weights, 'invite_flood'), 'invite code is minting joins rapidly');

    // 6. Combinations. A linear sum badly under-rates a signature that a human
    //    reads instantly, which is exactly how an obvious throwaway scores 48.
    const noTrustAtAll = trust.filter(t => t.id !== 'account_age').length === 0;

    if (defaultAvatar && (gibberish || digitSuffix) && noTrustAtAll) {
        addSus('bulk_signature', 'Bulk-registration signature', weightOf(weights, 'bulk_signature'),
            'default avatar + generated-looking name + nothing else on the profile');
    }
    // The name signature on its own, without needing a default avatar.
    // Every combination here used to require one, so uploading any picture at
    // all bought a generated account out of all three. An avatar is a
    // five-second upload; a name that is both random-looking AND suffixed
    // with a block of digits is what a registration script produces.
    else if (gibberish && digitSuffix) {
        addSus('generated_name', 'Generated-looking name', weightOf(weights, 'generated_name'),
            'consonant runs and a digit block, the shape a name generator makes');
    }
    if (defaultAvatar && ageDays < 7 && noTrustAtAll) {
        addSus('fresh_throwaway', 'Fresh throwaway', weightOf(weights, 'fresh_throwaway'),
            'brand new, no avatar, no badges');
    }
    // A profile with nothing lived-in about it. On its own this is mild; the
    // point is that it stacks rather than being cancelled out by one purchase.
    if (defaultAvatar && !user.globalName && noTrustAtAll) {
        addSus('barren_profile', 'Nothing on the profile', weightOf(weights, 'barren_profile'),
            'no avatar, no display name, no badges, no activity');
    }

    // 7. Membership tenure, applied outside the trust cap.
    let tenureSignal = null;
    const joinedTimestamp = Number(member?.joinedTimestamp ?? 0);
    if (applyTenure && joinedTimestamp > 0) {
        // Scaling rule: every band boundary is multiplied by
        // graceDays / DEFAULT_TENURE_GRACE_DAYS (365 reproduces the stock
        // bands, half of it earns each forgiveness step twice as fast, and
        // so on); the points per band are untouched. A zero or invalid grace
        // falls back to the stock timeline rather than damping newcomers.
        const grace = Number(tenureGraceDays);
        const scale = Number.isFinite(grace) && grace > 0 ? grace / DEFAULT_TENURE_GRACE_DAYS : 1;
        const tenureDays = (now - joinedTimestamp) / DAY_MS;
        const tBand = TENURE_BANDS.find(b => tenureDays < b.maxDays * scale) ?? TENURE_BANDS[TENURE_BANDS.length - 1];
        if (tBand.points) {
            // With a custom grace the stock band labels ("member for months")
            // would misdescribe the scaled boundaries, so describe the band by
            // its actual cutoff instead.
            const bandDesc = scale === 1
                ? tBand.label
                : (Number.isFinite(tBand.maxDays)
                    ? `forgiveness band under ${Math.round(tBand.maxDays * scale)}d`
                    : 'full tenure forgiveness');
            tenureSignal = {
                id: 'membership_tenure', label: 'Long-standing member',
                points: tBand.points, detail: `${tenureDays.toFixed(0)}d in the server (${bandDesc})`,
            };
        }
    }

    // Cap the profile-trust pull, absolutely and proportionally.
    const suspicionTotal = suspicious.reduce((sum, s) => sum + s.points, 0);
    const rawTrust = trust.reduce((sum, s) => sum + s.points, 0);
    const allowance = Math.min(TRUST_CAP, Math.round(Math.max(0, suspicionTotal) * TRUST_MAX_FRACTION));
    const cappedTrust = Math.max(rawTrust, -allowance);
    const trustCapped = rawTrust < -allowance;

    let total = suspicionTotal + cappedTrust;
    if (tenureSignal) total += tenureSignal.points;

    const score = Math.max(0, Math.round(total));

    // Discord's own verdict is not negotiable. If Discord has flagged the
    // account, no amount of Nitro or account age argues it back down.
    const forced = suspicious.some(s => s.id === 'discord_spammer' || s.id === 'discord_quarantined');

    // Present the trust bucket scaled to what was actually applied, so the
    // breakdown always adds up to the score shown.
    const scale = rawTrust < 0 ? cappedTrust / rawTrust : 1;
    const shownTrust = trust.map(s => ({ ...s, points: Math.round(s.points * scale) }));

    const signals = [...suspicious, ...shownTrust];
    if (tenureSignal) signals.push(tenureSignal);

    return {
        score,
        tier: forced ? 'malicious' : tierFor(score, thresholds),
        signals,
        trustApplied: cappedTrust,
        trustCapped,
        forcedByDiscord: forced,
    };
}

function tierFor(score, thresholds = DEFAULT_THRESHOLDS) {
    if (score >= thresholds.malicious) return 'malicious';
    if (score >= thresholds.suspect) return 'suspect';
    if (score >= thresholds.watch) return 'watch';
    return 'clear';
}

/**
 * One-line reason, for list views where the full arithmetic does not fit.
 *
 * Leads with the Discord flag when present, because a forced-malicious verdict
 * on a low score is otherwise baffling: a 65 sitting above a 79 in a list
 * sorted by tier looks like a bug until you can see that Discord flagged it.
 */
function summarise(result, maxSignals = 3) {
    if (result.forcedByDiscord) {
        const which = result.signals.find(s => s.id === 'discord_quarantined')
            ? 'quarantined by Discord'
            : 'flagged as a spammer by Discord';
        return `🚩 ${which}`;
    }
    if (!result.signals?.length) return 'no signals';

    return result.signals
        .filter(s => s.points > 0)
        .sort((a, b) => b.points - a.points)
        .slice(0, maxSignals)
        .map(s => `${s.label.toLowerCase()} +${s.points}`)
        .join(', ') || 'trust signals only';
}

/** Ranks tiers so lists can be ordered by severity rather than raw score. */
const TIER_RANK = { malicious: 3, suspect: 2, watch: 1, clear: 0 };

/** Renders the arithmetic for a log embed. */
function explain(result) {
    if (result.signals.length === 0) return 'no signals fired';
    const lines = result.signals
        .slice()
        .sort((a, b) => b.points - a.points)
        .map(s => `${s.points > 0 ? '+' : ''}${s.points} ${s.label} (${s.detail})`);
    if (result.trustCapped) lines.push('(trust pull capped: a paid profile cannot clear a bad one)');
    if (result.forcedByDiscord) lines.push('(forced to malicious: Discord itself flagged this account)');
    return lines.join('\n');
}

module.exports = {
    DAY_MS,
    DEFAULT_WEIGHTS,
    DEFAULT_SCAM_KEYWORDS,
    DEFAULT_THRESHOLDS,
    AGE_BANDS,
    TENURE_BANDS,
    DEFAULT_TENURE_GRACE_DAYS,
    TRUST_FLAGS,
    TRUST_CAP,
    TRUST_MAX_FRACTION,
    scoreAccount,
    tierFor,
    explain,
    summarise,
    TIER_RANK,
    recordJoin,
    correlateJoin,
    resetCorrelation,
    // exported for tests
    hasInvisibleChars,
    hasMixedScriptToken,
    hasDigitSuffix,
    looksRandom,
    maxConsonantRun,
    isMostlyNonLatin,
    hasSymbolSpam,
    foldName,
    matchesScamKeyword,
    matchesProtectedName,
};
