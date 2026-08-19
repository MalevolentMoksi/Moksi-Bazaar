// src/utils/joinGate/explain.js
/**
 * What the bot is allowed to say about its own moderation, in its own words.
 *
 * It once explained a log line in chat like this: "dm suppression is me
 * throttling their ability to message people... the spam detector flags the
 * account and i put a mute on their dms." Every clause of that was invented.
 * The owner had to tell the channel to ignore it, and a moderator had already
 * banned somebody partly on the strength of the misunderstanding.
 *
 * The writer had no way to do better. The prompt forbids inventing what is in
 * an image and says nothing about inventing how the bot's own systems work,
 * so a confident guess was the only thing available to it.
 *
 * THREE RULES, because a description of internals is the easiest thing in a
 * codebase to leave behind:
 *
 *  1. NUMBERS ARE NEVER WRITTEN DOWN HERE. Every threshold, count and window
 *     is interpolated from that guild's live settings at the moment of
 *     asking. Prose cannot go stale if it contains no fact that can change.
 *  2. PROSE DESCRIBES MECHANISMS ONLY, and only ones that change about as
 *     often as the architecture does.
 *  3. NUMBERS ARE FOR STAFF. "Your account was too new and it lifts on its
 *     own" is something anybody deserves to hear. "The bar is 12 days and the
 *     third try earns a temp-ban" is a specification for getting in, and goes
 *     only to people who can already read the mod channels.
 *
 * This module answers questions. It changes nothing, reads no user data, and
 * is never consulted unless somebody asked.
 */

const { getSettings, formatDays } = require('./config');

/**
 * Phrases that mean somebody is asking how the moderation works.
 *
 * Deliberately specific. A bare "ban" or "kick" is ordinary chat in a server
 * with a casino in it, and firing on those would put a paragraph of
 * moderation trivia in front of the writer during a joke about blackjack.
 */
const ASKS_ABOUT_MODERATION = new RegExp([
    'dm suppress', 'suppressed', 'told them why',
    'join ?gate',
    'account (?:is |was )?too new', 'too new to join',
    'temp(?:orary|orarily)? ?ban', 'auto[- ]?unban',
    'why (?:did|was|were|do|does) (?:you|the bot|it) (?:kick|ban|remove|flag)',
    'suspicion (?:score|report)', 'watch window',
    'how (?:do|does) (?:you|your|the) (?:gate|moderation|automod|scoring)',
].join('|'), 'i');

/**
 * A looser word list, used ONLY on the scout's summary of the moment.
 *
 * The scout writes free prose ("why the bot kicked someone"), so the strict
 * phrasings above would almost never match it. They do not need to: this is
 * only ever consulted once the scout has already said mode is 'callout',
 * meaning the moment is about the bot itself. The narrowing is done; this
 * only has to decide whether the subject is moderation.
 */
const CALLOUT_MODERATION_WORDS =
    /\b(?:kick(?:s|ed|ing)?|ban(?:s|ned|ning)?|gates?|moderat\w*|remov\w*|flag(?:s|ged|ging)?|warn(?:s|ed|ing)?|muted?|automod|suspicio\w*)\b/i;

/**
 * Whether this moment is about the bot's own moderation.
 *
 * The scout already classifies a moment as 'callout', meaning "it is about
 * the bot itself", and that classification is paid for whether or not this
 * uses it. The text check exists because the pre-pass is skipped when a reply
 * is running late, which is exactly when somebody might have asked.
 */
function wantsExplanation(text, roomRead = null) {
    if (ASKS_ABOUT_MODERATION.test(String(text ?? ''))) return true;
    // A callout alone is not enough: most callouts are "you're annoying", not
    // "how does your join gate work". It counts only alongside a hint that
    // moderation is the subject.
    return roomRead?.mode === 'callout'
        && CALLOUT_MODERATION_WORDS.test(String(roomRead.focus ?? ''));
}

/** The vocabulary of the removal log, which is what actually got misread. */
const LOG_VOCABULARY = Object.freeze([
    'In your removal logs, the "Told them why" line is about whether you managed to send the '
    + 'person a DM explaining their removal. It is never a restriction placed on them. '
    + '"no, already told them Xm ago" means you chose not to repeat yourself, nothing more. '
    + 'You have never muted anybody\'s DMs and have no ability to.',
    'A temp-ban you issue lifts itself at a set time. It needs no unbanning by hand, and if a '
    + 'moderator bans the account themselves, their ban replaces yours and stops the automatic lift.',
]);

/**
 * A compact briefing on this guild's moderation, for the writer only.
 *
 * @param {string} guildId
 * @param {{staff?: boolean}} options staff sees the exact configuration
 * @returns {Promise<string>} '' when nothing can be said
 */
async function describeOwnModeration(guildId, { staff = false } = {}) {
    let s;
    try {
        s = await getSettings(guildId);
    } catch {
        return '';
    }

    const header = 'FACTS ABOUT YOUR OWN MODERATION (true right now, for this server; say them '
        + 'plainly if asked, and never invent anything beyond them):';

    if (!s.enabled) {
        return `${header}\n- Your join gate is switched off in this server. You are not screening `
            + 'or removing anybody here.';
    }

    const lines = [];

    // ── The age gate ────────────────────────────────────────────────────
    lines.push(staff
        ? `You screen every arrival on account age. The bar here is ${formatDays(s.min_account_age_minutes)} days: `
          + 'a younger account is kicked as it joins, and told why by DM.'
        : 'You screen new arrivals on how old their Discord account is. Too new, and they are '
          + 'kicked as they join and told why by DM. You do not read their messages to decide this.');

    lines.push('A kick from the gate is not a punishment and not permanent. They can come back the '
        + 'moment their account is old enough, on their own, with nobody to ask.');

    if (s.escalate_enabled) {
        lines.push(staff
            ? `Somebody who keeps trying is temp-banned instead on attempt ${s.escalate_after_attempts}, `
              + 'until their account reaches the age bar. That ban lifts itself.'
            : 'Somebody who keeps retrying is temporarily blocked instead of kicked again, until '
              + 'their account is old enough. That block lifts itself.');
    }

    if (s.dm_enabled) {
        lines.push(staff
            ? `You DM the reason on removal, at most once every ${s.dm_cooldown_minutes} minutes per `
              + 'person so a rapid rejoiner is not spammed. The escalation DM ignores that cooldown.'
            : 'You DM people the reason when you remove them, but you will not send the same person '
              + 'the same message over and over.');
    }

    // ── The scorer ──────────────────────────────────────────────────────
    if (s.suspicion_enabled) {
        lines.push('Separately, you score the PROFILE of arrivals who pass the age check: a default '
            + 'avatar, a generated-looking name, several accounts arriving together. It is fixed '
            + 'arithmetic with fixed weights, not a judgement and not an AI, and it shows its '
            + 'working on every report it files.');
        lines.push(staff
            ? `Its tiers here are watch at ${s.suspicion_watch_at}, suspect at ${s.suspicion_suspect_at} `
              + `and malicious at ${s.suspicion_malicious_at}, and those tiers currently do: `
              + `${[s.suspicion_watch_action, s.suspicion_suspect_action, s.suspicion_malicious_action].join(' / ')}.`
            : 'Do not recite its thresholds or weights to anyone who is not staff. Describe what it '
              + 'looks at, never the numbers that would let somebody tune an account to slip past it.');
    }

    if (s.watch_enabled) {
        lines.push(staff
            ? `You also watch what brand-new members POST for their first ${s.watch_window_minutes} minutes `
              + `(scam links, invites elsewhere, mass pings), acting at ${s.watch_action_at} points with: `
              + `${s.watch_action}. After that window they are forgotten entirely.`
            : 'You also watch what brand-new members post for their first few minutes, for scam links '
              + 'and spam. After that short window they are forgotten entirely, and you do not read '
              + 'established members\' messages for moderation.');
    }

    lines.push(...LOG_VOCABULARY);

    lines.push('If somebody asks something about your moderation that is not covered above, say you '
        + 'are not sure rather than working it out from first principles. You have been confidently '
        + 'wrong about your own internals before.');

    return `${header}\n${lines.map(l => `- ${l}`).join('\n')}`;
}

module.exports = {
    describeOwnModeration,
    wantsExplanation,
    ASKS_ABOUT_MODERATION,
    CALLOUT_MODERATION_WORDS,
    LOG_VOCABULARY,
};
