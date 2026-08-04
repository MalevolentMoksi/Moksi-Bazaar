// src/events/client/dynoWarnListener.js
/**
 * Watches a moderation bot's warn confirmations and keeps a record of its own.
 *
 * Two things happen per warn now. The reminder scheduler works exactly as it
 * did, and separately the warn is written to the `warns` table with a resolved
 * user id wherever one can be worked out. The old flow kept a row only long
 * enough to fire one reminder, then deleted it, and keyed everything on the
 * display name printed in the embed: a rename split someone's history in two
 * and nothing could ever be tied back to an account.
 */

const {
    WARN_REMINDER_DAYS,
    insertWarnReminder,
    findRecentWarnReminderForUser,
    appendWarnToReminder,
    scheduleNext,
} = require('../../utils/warnReminderScheduler');
const { recordWarn, linkWarnsToUser } = require('../../utils/db');
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
 * Works out who was actually warned.
 *
 * Ordered most reliable first. A mention carries the id outright; a bare
 * snowflake in the footer usually does too. Matching the printed label against
 * the member list is the last resort and is only accepted when exactly one
 * member matches, because acting on the wrong person is worse than storing a
 * label with no id attached.
 *
 * @returns {Promise<string|null>}
 */
async function resolveWarnedUserId(message, embed, label) {
    const text = embedText(embed);

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

module.exports = {
    name: 'messageCreate',
    async execute(message, client) {
        if (message.guildId !== WARN_GUILD_ID) return;
        if (message.author.id !== DYNO_BOT_ID) return;
        if (!message.embeds?.length) return;

        for (const embed of message.embeds) {
            const info = extractWarnInfo(embed);
            if (!info) continue;

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
                    moderator: embed.author?.name ?? fieldLike(embed, /moderator|mod|issued/i),
                    reason: fieldLike(embed, /reason/i),
                });
                // Anything filed under this label before an id was resolvable
                // now belongs to a real account.
                if (userId) await linkWarnsToUser(message.guildId, warnedUser, userId);
                logger.info('[WARN] Recorded', { userId, label: warnedUser, caseId: warnId, fresh });
            } catch (error) {
                logger.error('[WARN] Could not record warn', {
                    label: warnedUser, error: error.message,
                });
            }

            try {
                const existing = await findRecentWarnReminderForUser(warnedUser);

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
            break;
        }
    }
};
