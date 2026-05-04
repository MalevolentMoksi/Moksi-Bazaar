const { insertWarnReminder, scheduleNext } = require('../../utils/warnReminderScheduler');

const DYNO_BOT_ID    = '155149108183695360';
const WARN_GUILD_ID  = '1271818662839451699';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const WARN_EMBED_REGEX = /^✅ \*\*(.+) has been warned\.\*\*$/;

module.exports = {
    name: 'messageCreate',
    async execute(message, client) {
        if (message.guildId !== WARN_GUILD_ID) return;
        if (message.author.id !== DYNO_BOT_ID) return;
        if (!message.embeds?.length) return;

        for (const embed of message.embeds) {
            const match = embed.description?.match(WARN_EMBED_REGEX);
            if (!match) continue;

            const warnedUser = match[1];
            const dueAt = Date.now() + THIRTY_DAYS_MS;

            try {
                await insertWarnReminder(message.channel.id, message.guild.id, warnedUser, dueAt);
                await scheduleNext(client);

                const epoch = Math.floor(dueAt / 1000);
                await message.channel.send(
                    `Got it! I've noted the warning for **${warnedUser}**. ` +
                    `I'll remind staff to review it on <t:${epoch}:F> (<t:${epoch}:R>).`
                );
            } catch (err) {
                console.error('[WARN-REMINDER] Failed to insert warn reminder:', err);
            }
            break;
        }
    }
};
