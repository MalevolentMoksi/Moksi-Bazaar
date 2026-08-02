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

const MASS_MENTION_THRESHOLD = 5;
const CROSS_CHANNEL_THRESHOLD = 3;
const DUPLICATE_THRESHOLD = 3;
/** Never track more than this many watched members per guild. */
const MAX_WATCHED = 500;

const INVITE_RE = /(?:discord\.(?:gg|com\/invite)|discordapp\.com\/invite)\/[A-Za-z0-9-]+/i;

/** guildId -> Map<userId, {joinedAt, messages: [{content, channelId, at}]}> */
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
    bucket.set(userId, { joinedAt: now, messages: [] });
}

function forget(guildId, userId) {
    watched.get(guildId)?.delete(userId);
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
 * Scores one message from a watched member.
 *
 * Pure apart from the per-member message history it accumulates, which is what
 * makes cross-channel and duplicate detection possible.
 *
 * @returns {{score: number, signals: Array<{id,label,points,detail}>}}
 */
function inspectMessage(guildId, message, { windowMs, now = Date.now() } = {}) {
    const entry = watched.get(guildId)?.get(message.author.id);
    if (!entry) return { score: 0, signals: [] };
    if (now - entry.joinedAt > windowMs) {
        forget(guildId, message.author.id);
        return { score: 0, signals: [] };
    }

    const content = String(message.content ?? '');
    const signals = [];
    const add = (id, label, points, detail) => signals.push({ id, label, points, detail });

    // Track history before scoring so this message counts toward repetition.
    entry.messages.push({ content: content.trim().toLowerCase(), channelId: message.channelId, at: now });
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

    const score = signals.reduce((sum, s) => sum + s.points, 0);
    if (score > 0) {
        logger.debug('[JOIN-GATE] Watch-window signals', {
            guildId, userId: message.author.id, score, signals: signals.map(s => s.id),
        });
    }
    return { score, signals };
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
    watchMember,
    isWatched,
    inspectMessage,
    forget,
    prune,
    watchedCount,
    reset,
};
