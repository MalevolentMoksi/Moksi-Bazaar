// src/events/client/dynoWarnListener.js
/**
 * Watches a moderation bot's confirmations and keeps a record of its own.
 *
 * Warns: two things happen per warn. The reminder scheduler works exactly as
 * it did, and separately the warn is written to the `warns` table with a
 * resolved user id wherever one can be worked out. The old flow kept a row
 * only long enough to fire one reminder, then deleted it, and keyed
 * everything on the display name printed in the embed: a rename split
 * someone's history in two and nothing could ever be tied back to an account.
 *
 * Removals: the reminder text has told staff to run `?delwarn` since the day
 * it shipped, and nothing ever listened for the confirmation, so the durable
 * record diverged from Dyno by design: deleted warns stayed on file forever.
 * A recognised delwarn/clearwarns confirmation now soft-deletes the matching
 * rows (marked removed, never erased: the history keeps both the warn and
 * its withdrawal).
 *
 * Everything here is scraping another bot's wording, so two honesty rules:
 *
 *   1. CONFIDENT MATCHES ONLY. A removal is only recorded off an explicit
 *      case number, or a cleared-user line whose subject resolves. Guessing
 *      would un-record the wrong person's history.
 *   2. NEAR MISSES ARE REPORTED, NOT SWALLOWED. If Dyno's wording drifts,
 *      the failure used to be silence: the record just stopped growing and
 *      nobody was told. An embed that smells like a warn or a removal but
 *      does not parse now degrades the health panel and logs its own text,
 *      so the drift is a sample to fix rather than a mystery.
 */

const {
    WARN_REMINDER_DAYS,
    insertWarnReminder,
    findRecentWarnReminderForUser,
    appendWarnToReminder,
    scheduleNext,
} = require('../../utils/warnReminderScheduler');
const { recordWarn, linkWarnsToUser, removeWarnByCase, removeWarnsForUser } = require('../../utils/db');
const health = require('../../utils/health');
const logger = require('../../utils/logger');

const DYNO_BOT_ID   = '155149108183695360';
const WARN_GUILD_ID = '1271818662839451699';
const WARN_MS       = WARN_REMINDER_DAYS * 24 * 60 * 60 * 1000;

// Matches bold or bold+italic formatting: **user has been warned.** or ***user has been warned.***
// Does not anchor on the emoji: Dyno uses a custom guild emoji (<:dynoSuccess:ID>), not a Unicode one
const WARN_DESC_RE = /\*{2,3}(.+?) has been warned\.(?:[^*]*?Case #(\d+))?\*{2,3}/;
const CASE_RE      = /Case #(\d+)/;
const MENTION_RE   = /<@!?(\d{17,20})>/;
const RAW_ID_RE    = /\b(\d{17,20})\b/;

/**
 * Removal confirmations. Dyno's exact wording is not documented and can
 * drift, so these are deliberately tolerant about ordering, and anything
 * that mentions warns and a deletion verb without matching one of them is
 * logged as a sample (see reportNearMiss) rather than silently ignored.
 */
const DELWARN_RES = [
    // "Deleted warning #123", "Removed warn 123", "Deleted Case #123"
    /(?:deleted|removed)\s+(?:warning|warn|case)\s*#?(\d+)/i,
    // "Warning #123 deleted", "Case #123 has been removed"
    /(?:warning|warn|case)\s*#?(\d+)\s+(?:has been\s+)?(?:deleted|removed)/i,
];
const CLEARWARNS_RES = [
    // "Cleared 3 warnings for someone", "Cleared warnings for @someone"
    /cleared\s+(?:\d+\s+)?warn(?:ing)?s?\s+(?:for|from)\s+(.+?)(?:\.|$)/im,
];
/** The smell of a removal this file failed to parse. */
const REMOVAL_SMELL_RE = /\bwarn(?:ing)?s?\b.*\b(?:deleted|removed|cleared)\b|\b(?:deleted|removed|cleared)\b.*\bwarn(?:ing)?s?\b/is;
/** The smell of a warn this file failed to parse. */
const WARN_SMELL_RE = /\bhas been warned\b/i;

/** Everything the embed might carry, flattened into one searchable string. */
function embedText(embed) {
    return [
        embed.description ?? '',
        embed.title ?? '',
        embed.footer?.text ?? '',
        embed.author?.name ?? '',
        ...(embed.fields ?? []).flatMap(f => [f.name, f.value]),
    ].join('\n');
}

/**
 * The embed minus its reason-shaped fields.
 *
 * Id resolution used to scan the whole flattened embed, so a reason reading
 * "harassing <@victim>" attributed the warn to the victim: the first mention
 * anywhere won, and the reason is exactly where somebody ELSE'S mention is
 * most likely to appear.
 */
function embedTextWithoutReasons(embed) {
    return [
        embed.description ?? '',
        embed.title ?? '',
        embed.footer?.text ?? '',
        embed.author?.name ?? '',
        ...(embed.fields ?? [])
            .filter(f => !/reason/i.test(f.name ?? ''))
            .flatMap(f => [f.name, f.value]),
    ].join('\n');
}

function fieldLike(embed, pattern) {
    const field = (embed.fields ?? []).find(f => pattern.test(f.name ?? ''));
    return field?.value?.trim() || null;
}

function extractWarnInfo(embed) {
    const desc  = embed.description ?? '';
    const match = desc.match(WARN_DESC_RE);
    if (!match) return null;

    const warnedUser = match[1];
    const warnId     = match[2]
        ?? embed.footer?.text?.match(CASE_RE)?.[1]
        ?? null;

    return { warnedUser, warnId };
}

/**
 * A recognised removal, or null.
 * @returns {{kind: 'case', caseId: string} | {kind: 'clear', subject: string} | null}
 */
function extractRemovalInfo(embed) {
    const text = embedText(embed);

    for (const re of DELWARN_RES) {
        const match = text.match(re);
        if (match) return { kind: 'case', caseId: match[1] };
    }
    for (const re of CLEARWARNS_RES) {
        const match = text.match(re);
        if (match) return { kind: 'clear', subject: match[1].trim() };
    }
    return null;
}

/**
 * Works out who was actually warned.
 *
 * Ordered most reliable first, and never read out of a reason field: a
 * mention carries the id outright; a bare snowflake in the footer usually
 * does too. Matching the printed label against the member list is the last
 * resort and is only accepted when exactly one member matches, because
 * acting on the wrong person is worse than storing a label with no id.
 *
 * @returns {Promise<string|null>}
 */
async function resolveWarnedUserId(message, embed, label) {
    const text = embedTextWithoutReasons(embed);

    const mention = text.match(MENTION_RE);
    if (mention) return mention[1];

    // A raw id, but never the moderation bot's own or this guild's.
    const raw = text.match(RAW_ID_RE);
    if (raw && raw[1] !== DYNO_BOT_ID && raw[1] !== message.guildId) return raw[1];

    const needle = String(label).replace(/^@/, '').trim().toLowerCase();
    if (!needle) return null;

    try {
        const members = await message.guild.members.fetch({ query: needle, limit: 10 });
        const exact = members.filter(m =>
            m.user.username.toLowerCase() === needle
            || m.user.tag?.toLowerCase() === needle
            || m.displayName.toLowerCase() === needle);
        if (exact.size === 1) return exact.first().id;
    } catch (error) {
        logger.debug('[WARN] Member lookup failed', { needle, error: error.message });
    }
    return null;
}

/**
 * An embed that smells like something this file should have understood but
 * did not. The one symptom Dyno rewording its confirmations produces.
 */
function reportNearMiss(kind, embed) {
    const sample = embedText(embed).slice(0, 400);
    health.report('dynoWarn', 'degraded', `a Dyno embed looked like a ${kind} but did not parse`);
    logger.warn('[WARN] Unparsed Dyno confirmation, wording may have drifted', { kind, sample });
}

async function handleWarn(message, client, embed, info) {
    const { warnedUser, warnId } = info;

    // The durable record first, and on its own error boundary: the
    // reminder is the nice-to-have, the history is the thing that has
    // to survive.
    try {
        const userId = await resolveWarnedUserId(message, embed, warnedUser);
        const fresh = await recordWarn({
            guildId: message.guildId,
            userId,
            userLabel: warnedUser,
            caseId: warnId,
            // The explicit field wins. Dyno's embed author is routinely the
            // TARGET, so preferring it filed warns as issued by the person
            // who received them.
            moderator: fieldLike(embed, /moderator|mod|issued/i) ?? embed.author?.name ?? null,
            reason: fieldLike(embed, /reason/i),
        });
        // Anything filed under this label before an id was resolvable
        // now belongs to a real account.
        if (userId) await linkWarnsToUser(message.guildId, warnedUser, userId);
        health.report('dynoWarn', 'ok');
        logger.info('[WARN] Recorded', { userId, label: warnedUser, caseId: warnId, fresh });
    } catch (error) {
        logger.error('[WARN] Could not record warn', {
            label: warnedUser, error: error.message,
        });
    }

    try {
        const existing = await findRecentWarnReminderForUser(warnedUser, message.guild.id);

        if (existing) {
            await appendWarnToReminder(existing.id, warnId);
            const newCount = existing.warn_count + 1;
            await message.channel.send(
                `Added to existing reminder: **${warnedUser}** now has ${newCount} recorded warns. Staff will be reminded in ${WARN_REMINDER_DAYS} days.`
            );
        } else {
            const dueAt = Date.now() + WARN_MS;
            await insertWarnReminder(message.channel.id, message.guild.id, warnedUser, dueAt, warnId);
            await scheduleNext(client);

            const epoch = Math.floor(dueAt / 1000);
            const idNote = warnId ? ` (Case #${warnId})` : '';
            await message.channel.send(
                `Got it! I've noted the warning for **${warnedUser}**${idNote}. I'll remind staff to review it on <t:${epoch}:F> (<t:${epoch}:R>).`
            );
        }
    } catch (err) {
        logger.error('[WARN-REMINDER] Failed to process warn', { error: err.message });
    }
}

async function handleRemoval(message, embed, removal) {
    try {
        if (removal.kind === 'case') {
            const marked = await removeWarnByCase(message.guildId, removal.caseId, embed.author?.name ?? null);
            if (marked) {
                logger.info('[WARN] Marked removed', { caseId: removal.caseId, label: marked.userLabel });
            } else {
                // A delwarn for a case this record never saw: nothing to
                // mark, but worth a line, since it means the mirror missed
                // the original warn too.
                logger.info('[WARN] Removal for an unknown case', { caseId: removal.caseId });
            }
        } else {
            const userId = await resolveWarnedUserId(message, embed, removal.subject);
            const marked = await removeWarnsForUser(
                message.guildId,
                { userId, label: removal.subject },
                embed.author?.name ?? null
            );
            logger.info('[WARN] Cleared warns marked removed', {
                subject: removal.subject, userId, marked,
            });
        }
        health.report('dynoWarn', 'ok');
    } catch (error) {
        logger.error('[WARN] Could not record removal', { error: error.message });
    }
}

module.exports = {
    name: 'messageCreate',
    async execute(message, client) {
        if (message.guildId !== WARN_GUILD_ID) return;
        if (message.author.id !== DYNO_BOT_ID) return;
        if (!message.embeds?.length) return;

        for (const embed of message.embeds) {
            const info = extractWarnInfo(embed);
            if (info) {
                await handleWarn(message, client, embed, info);
                break; // one warn per message max
            }

            const removal = extractRemovalInfo(embed);
            if (removal) {
                await handleRemoval(message, embed, removal);
                break;
            }

            // Neither parsed. If it smells like one, that is the only symptom
            // wording drift produces: say so instead of silently shrinking
            // the record.
            const text = embedText(embed);
            if (WARN_SMELL_RE.test(text)) reportNearMiss('warn', embed);
            else if (REMOVAL_SMELL_RE.test(text)) reportNearMiss('warn removal', embed);
        }
    },
    // Exported for tests: the parsing is the fragile part, so it is pinned.
    extractWarnInfo,
    extractRemovalInfo,
    resolveWarnedUserId,
    embedTextWithoutReasons,
    WARN_SMELL_RE,
    REMOVAL_SMELL_RE,
};
