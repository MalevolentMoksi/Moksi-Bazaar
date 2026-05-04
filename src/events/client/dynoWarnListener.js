const {
    WARN_REMINDER_DAYS,
    insertWarnReminder,
    findRecentWarnReminderForUser,
    appendWarnToReminder,
    scheduleNext,
} = require('../../utils/warnReminderScheduler');

const DYNO_BOT_ID   = '155149108183695360';
const WARN_GUILD_ID = '1271818662839451699';
const WARN_MS       = WARN_REMINDER_DAYS * 24 * 60 * 60 * 1000;

// Matches bold or bold+italic formatting: **user has been warned.** or ***user has been warned.***
// Does not anchor on the emoji — Dyno uses a custom guild emoji (<:dynoSuccess:ID>), not a Unicode one
const WARN_DESC_RE = /\*{2,3}(.+?) has been warned\.(?:[^*]*?Case #(\d+))?\*{2,3}/;
const CASE_RE      = /Case #(\d+)/;

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
                console.error('[WARN-REMINDER] Failed to process warn:', err);
            }
            break;
        }
    }
};
