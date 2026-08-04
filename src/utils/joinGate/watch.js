// src/utils/joinGate/watch.js
/**
 * Join Gate: post-join behaviour window.
 *
 * Profile heuristics can only ever describe how an account looks. Most real
 * abuse is only visible in what it DOES in its first minute: post a phishing
 * link, drop an invite to another server, ping everyone, or paste the same
 * message into six channels.
 *
 * Scope is deliberately narrow. Only members who joined within the configured
 * window are examined, so this can never turn into a general-purpose automod
 * policing regulars. Once the window passes, a member is forgotten entirely.
 */

const logger = require('../logger');
const phishing = require('./phishing');

/** Behaviour points. Deliberately harsher than profile signals: this is evidence. */
const BEHAVIOUR_WEIGHTS = Object.freeze({
    scam_link: 100,
    invite_link: 30,
    mass_mention: 35,
    everyone_attempt: 25,
    cross_channel_spam: 45,
    duplicate_spam: 30,
    link_in_first_message: 12,
});

/**
 * Combinations, because a sum under-rates the ones that matter.
 *
 * This is the same rule the profile scorer states in its own header: a default
 * avatar is weak evidence, a default avatar plus a gibberish name plus a digit
 * suffix is a bulk-registered account. The behaviour scorer had no equivalent,
 * so an invite link (30) plus an @everyone attempt (25) plus a link (12) came
 * to 67 and read as three unrelated mild signals. It is not three signals. It
 * is one thing: an advertising bot, doing the only thing advertising bots do.
 */
const COMBO_WEIGHTS = Object.freeze({
    advert_broadcast: 35,
    link_sweep: 25,
});

const MASS_MENTION_THRESHOLD = 5;
/**
 * Two channels, not three. The same text in a second channel is already a
 * sweep; requiring a third only mattered back when a member stopped being
 * watched after their first flagged message, which meant this rarely counted
 * at all.
 */
const CROSS_CHANNEL_THRESHOLD = 2;
const DUPLICATE_THRESHOLD = 3;
/**
 * How much a bad profile lowers the behavioural bar.
 *
 * Someone the gate already scored as suspicious on arrival needs less
 * behavioural evidence than someone who looked ordinary. A quarter of the join
 * score, capped, so this nudges and never decides on its own.
 */
const PRIOR_SUSPICION_FRACTION = 0.25;
const PRIOR_SUSPICION_CAP = 25;
/** A re-report has to be materially worse than the last one, not just noisier. */
const ESCALATION_DELTA = 25;
/** Never track more than this many watched members per guild. */
const MAX_WATCHED = 500;

const INVITE_RE = /(?:discord\.(?:gg|com\/invite)|discordapp\.com\/invite)\/[A-Za-z0-9-]+/i;

/**
 * guildId -> Map<userId, entry>, where entry is
 * `{joinedAt, messages: [{content, channelId, at}], seen: Map<signalId, signal>,
 *   joinScore, joinTier, reportedScore}`.
 *
 * `seen` is what makes the score cumulative across the window rather than per
 * message. It is a union, not a sum: posting the same invite five times counts
 * the invite once, and it is the repetition signals that escalate instead.
 */
const watched = new Map();

function guildBucket(guildId) {
    let bucket = watched.get(guildId);
    if (!bucket) { bucket = new Map(); watched.set(guildId, bucket); }
    return bucket;
}

/** Begins watching a member. Called for every join while the feature is on. */
function watchMember(guildId, userId, now = Date.now()) {
    const bucket = guildBucket(guildId);
    if (bucket.size >= MAX_WATCHED) {
        // Drop the oldest rather than growing without bound.
        const oldest = [...bucket.entries()].sort((a, b) => a[1].joinedAt - b[1].joinedAt)[0];
        if (oldest) bucket.delete(oldest[0]);
    }
    bucket.set(userId, {
        joinedAt: now,
        messages: [],
        seen: new Map(),
        joinScore: 0,
        joinTier: 'clear',
        reportedScore: undefined,
    });
}

function forget(guildId, userId) {
    watched.get(guildId)?.delete(userId);
}

/**
 * Records what the profile scorer made of this member when they arrived.
 *
 * Called after the join is scored, which is necessarily after watchMember, so
 * it updates an entry rather than creating one. A member who is not being
 * watched is simply not carrying anything over.
 */
function setJoinScore(guildId, userId, score, tier) {
    const entry = watched.get(guildId)?.get(userId);
    if (!entry) return;
    entry.joinScore = Number(score) || 0;
    entry.joinTier = tier || 'clear';
}

/** Notes the score a report was filed at, so the next one has to beat it. */
function markReported(guildId, userId, score) {
    const entry = watched.get(guildId)?.get(userId);
    if (entry) entry.reportedScore = score;
}

/**
 * What the member has actually said in the window, newest last.
 *
 * Returned as a copy so a caller cannot reach in and mutate the history the
 * duplicate and cross-channel detection depends on.
 *
 * @returns {Array<{content: string, messageId: string, channelId: string, at: number}>}
 */
function evidenceFor(guildId, userId) {
    const entry = watched.get(guildId)?.get(userId);
    if (!entry) return [];
    return entry.messages.map(m => ({
        content: m.raw ?? m.content,
        messageId: m.messageId,
        channelId: m.channelId,
        at: m.at,
    }));
}

/** Drops anyone whose window has closed. */
function prune(guildId, windowMs, now = Date.now()) {
    const bucket = watched.get(guildId);
    if (!bucket) return;
    for (const [userId, entry] of bucket) {
        if (now - entry.joinedAt > windowMs) bucket.delete(userId);
    }
    if (bucket.size === 0) watched.delete(guildId);
}

/**
 * Prunes every guild at once. Members who never post are otherwise only
 * evicted by the 500-entry cap, so a periodic janitor calls this with the
 * largest window any guild could have configured; per-guild expiry is still
 * enforced lazily by isWatched.
 */
function pruneAll(windowMs, now = Date.now()) {
    for (const guildId of [...watched.keys()]) prune(guildId, windowMs, now);
}

function isWatched(guildId, userId, windowMs, now = Date.now()) {
    const entry = watched.get(guildId)?.get(userId);
    if (!entry) return false;
    if (now - entry.joinedAt > windowMs) {
        forget(guildId, userId);
        return false;
    }
    return true;
}

/**
 * Combinations earned by the signals seen so far.
 *
 * Kept as explicit checks rather than a rule table: there are two of them, and
 * a reader should be able to see exactly what fires without decoding a matcher.
 */
function combosFor(seen) {
    const has = id => seen.has(id);
    const anyLink = has('scam_link') || has('invite_link') || has('link_in_first_message');
    const anyPing = has('everyone_attempt') || has('mass_mention');
    const repeated = has('cross_channel_spam') || has('duplicate_spam');
    const combos = [];

    // An invite plus a mass ping, from an account that arrived minutes ago, is
    // not a coincidence. This is the payload; everything else is packaging.
    if (has('invite_link') && anyPing) {
        combos.push({
            id: 'advert_broadcast',
            label: 'Advertising broadcast',
            points: COMBO_WEIGHTS.advert_broadcast,
            detail: 'an invite to another server, pushed with a mass ping',
        });
    }

    // A link is one thing. The same link pushed into more than one place is a
    // campaign, and campaigns are never accidental.
    if (anyLink && repeated) {
        combos.push({
            id: 'link_sweep',
            label: 'Link sweep',
            points: COMBO_WEIGHTS.link_sweep,
            detail: 'the same link pushed into more than one place',
        });
    }

    return combos;
}

/**
 * Scores a watched member on everything they have done so far in the window.
 *
 * The score is cumulative but not additive-per-message: signals are collected
 * into a union, so the same invite posted five times counts once and it is the
 * repetition signals that escalate. Previously this scored one message in
 * isolation and the caller then stopped watching, which meant the cross-channel
 * and duplicate weights could almost never fire for the sweep they were written
 * to catch.
 *
 * @param {{windowMs: number, threshold?: number, now?: number}} options
 * @returns {{score: number, signals: Array, report: boolean, fresh: string[]}}
 *   `report` is whether this is worth telling anyone about: the first time it
 *   scores anything, when it newly crosses the action threshold, or when it has
 *   got materially worse since the last report.
 */
function inspectMessage(guildId, message, { windowMs, threshold = Infinity, now = Date.now() } = {}) {
    const empty = { score: 0, signals: [], report: false, fresh: [] };
    const entry = watched.get(guildId)?.get(message.author.id);
    if (!entry) return empty;
    if (now - entry.joinedAt > windowMs) {
        forget(guildId, message.author.id);
        return empty;
    }

    const content = String(message.content ?? '');
    const signals = [];
    const add = (id, label, points, detail) => signals.push({ id, label, points, detail });

    // Track history before scoring so this message counts toward repetition.
    // `raw` and `messageId` are kept alongside the normalised copy: the
    // normalised one is for comparison, the other two are for showing a human
    // what was said and for cleaning it up afterwards.
    entry.messages.push({
        content: content.trim().toLowerCase(),
        raw: content.slice(0, 300),
        messageId: message.id,
        channelId: message.channelId,
        at: now,
    });
    if (entry.messages.length > 25) entry.messages.shift();

    // 1. Known-scam domain. The strongest single thing this bot can observe.
    const { urls, hits } = phishing.scanText(content);
    if (hits.length > 0) {
        add('scam_link', 'Known scam domain', BEHAVIOUR_WEIGHTS.scam_link, hits.slice(0, 3).join(', '));
    } else if (urls.length > 0) {
        add('link_in_first_message', 'Posted a link immediately', BEHAVIOUR_WEIGHTS.link_in_first_message,
            `${urls.length} link(s) within the watch window`);
    }

    // 2. Advertising another server straight after arriving.
    if (INVITE_RE.test(content)) {
        add('invite_link', 'Server invite', BEHAVIOUR_WEIGHTS.invite_link, 'posted an invite to another server');
    }

    // 3. Mention spam.
    const mentionCount = (message.mentions?.users?.size ?? 0) + (message.mentions?.roles?.size ?? 0);
    if (mentionCount >= MASS_MENTION_THRESHOLD) {
        add('mass_mention', 'Mass mention', BEHAVIOUR_WEIGHTS.mass_mention, `${mentionCount} mentions in one message`);
    }
    // `mentions.everyone` is only true when it actually pinged; the raw text
    // check catches someone trying it without permission, which is just as telling.
    if (message.mentions?.everyone || /@(everyone|here)\b/.test(content)) {
        add('everyone_attempt', 'Tried @everyone', BEHAVIOUR_WEIGHTS.everyone_attempt, 'used an @everyone/@here ping');
    }

    // 4. Same text across several channels, the classic advert sweep.
    const normalized = content.trim().toLowerCase();
    if (normalized.length >= 8) {
        const same = entry.messages.filter(m => m.content === normalized);
        const channels = new Set(same.map(m => m.channelId));
        if (channels.size >= CROSS_CHANNEL_THRESHOLD) {
            add('cross_channel_spam', 'Cross-channel spam', BEHAVIOUR_WEIGHTS.cross_channel_spam,
                `same message in ${channels.size} channels`);
        } else if (same.length >= DUPLICATE_THRESHOLD) {
            add('duplicate_spam', 'Repeated message', BEHAVIOUR_WEIGHTS.duplicate_spam,
                `sent ${same.length} times`);
        }
    }

    // Fold this message into everything already seen in the window. Highest
    // points win for a repeated signal, so a later mass mention of 40 replaces
    // an earlier one of 6 rather than stacking with it.
    const fresh = [];
    for (const signal of signals) {
        const prior = entry.seen.get(signal.id);
        if (!prior) fresh.push(signal.id);
        if (!prior || signal.points > prior.points) entry.seen.set(signal.id, signal);
    }

    // A profile that already looked wrong on arrival lowers the bar here.
    if (entry.joinTier && entry.joinTier !== 'clear' && entry.joinScore > 0 && !entry.seen.has('prior_suspicion')) {
        const carried = Math.min(PRIOR_SUSPICION_CAP, Math.round(entry.joinScore * PRIOR_SUSPICION_FRACTION));
        if (carried > 0) {
            entry.seen.set('prior_suspicion', {
                id: 'prior_suspicion',
                label: 'Already flagged on arrival',
                points: carried,
                detail: `profile scored ${entry.joinScore} (${entry.joinTier}) when they joined`,
            });
            fresh.push('prior_suspicion');
        }
    }

    const base = [...entry.seen.values()];
    const combos = combosFor(entry.seen);
    const all = [...base, ...combos];
    const score = all.reduce((sum, s) => sum + s.points, 0);

    // Worth reporting when it is new, when it has just become actionable, or
    // when it has got materially worse. Without this the caller had to stop
    // watching after one report to avoid repeating itself, which is exactly
    // what stopped a sweep across channels from ever being seen as a sweep.
    const previously = entry.reportedScore;
    const report = score > 0 && (
        previously === undefined
        || (score >= threshold && previously < threshold)
        || score - previously >= ESCALATION_DELTA
    );

    if (score > 0) {
        logger.debug('[JOIN-GATE] Watch-window signals', {
            guildId, userId: message.author.id, score, report,
            signals: all.map(s => s.id),
        });
    }
    return { score, signals: all, report, fresh };
}

function watchedCount(guildId) {
    return watched.get(guildId)?.size ?? 0;
}

function reset(guildId) {
    if (guildId) watched.delete(guildId);
    else watched.clear();
}

module.exports = {
    BEHAVIOUR_WEIGHTS,
    COMBO_WEIGHTS,
    CROSS_CHANNEL_THRESHOLD,
    ESCALATION_DELTA,
    watchMember,
    setJoinScore,
    markReported,
    evidenceFor,
    isWatched,
    inspectMessage,
    forget,
    prune,
    pruneAll,
    watchedCount,
    reset,
};
