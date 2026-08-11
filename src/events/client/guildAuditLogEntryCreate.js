// src/events/client/guildAuditLogEntryCreate.js
/**
 * The audit-log guard's ear.
 *
 * Discord writes an audit-log entry AFTER carrying an action out, so everything
 * downstream of here is observation. Nothing in this path can block, undo or
 * intercept anything: not a ban through Dyno, not a channel delete by the
 * owner, not another bot's work. It reads, it counts, and when a count looks
 * like an attack it says so.
 */

const { EmbedBuilder } = require('discord.js');
const logger = require('../../utils/logger');
const guard = require('../../utils/joinGate/guard');
const modlog = require('../../utils/joinGate/modlog');
const { getSettings } = require('../../utils/joinGate/config');
const { ui, quiet } = require('../../utils/ui/panel');

const ALERT_COLOR = 0xd64545;

async function alert(guild, settings, verdict, client) {
    const actor = await client.users.fetch(verdict.actorId).catch(() => null);

    let detail;
    if (verdict.bucket === guard.BUCKETS.BOT) {
        detail = verdict.targetId
            ? `Added <@${verdict.targetId}> (\`${verdict.targetId}\`).`
            : 'Added a bot.';
    } else if (verdict.identity) {
        detail = `Changed **${verdict.identity.join('**, **')}**.`;
    } else {
        detail = `**${verdict.count}** ${verdict.actions[0]} in ${verdict.windowSeconds}s `
            + `(limit is ${verdict.limit}).`;
    }

    // Who and what up top, the paperwork in subtext, and the standing advice as
    // its own block rather than a third paragraph nobody reaches. "Who" and
    // "Server" used to be fields repeating the first line and the channel the
    // alert was posted in.
    const embed = new EmbedBuilder()
        .setTitle(`🚨 ${verdict.label}`)
        .setColor(ALERT_COLOR)
        .setDescription(
            `<@${verdict.actorId}> tripped the audit-log guard.\n`
            + `${detail}\n`
            + `-# ${actor ? `${actor.username} · ` : ''}\`${verdict.actorId}\``
            + ` · ${verdict.actions.join(', ')} · in ${guild.name}`
        )
        .addFields({
            name: 'This is a report, not an action',
            value: 'Nothing has been undone and nobody has been touched. If this is an attack, '
                + 'the fastest response is `?lockdown` and removing their roles.',
            inline: false,
        })
        .setTimestamp();

    // Silenced like every other report: the one person who must not be told
    // the guard just fired is the account that tripped it.
    const payload = quiet(ui(embed, [], { scope: 'mod' }));

    // The log channel, if one is set.
    const channelId = settings.guard_channel_id || settings.log_channel_id;
    if (channelId) {
        const channel = guild.channels.cache.get(channelId)
            ?? await guild.channels.fetch(channelId).catch(() => null);
        if (channel?.isTextBased()) {
            await channel.send(payload).catch(error =>
                logger.warn('[GUARD] Could not post alert', { error: error.message }));
        }
    }

    // And the owner directly. A nuke usually starts by making the log channel
    // unreadable, so the DM is the copy that actually arrives.
    if (settings.guard_dm_owner && process.env.OWNER_ID) {
        const owner = await client.users.fetch(process.env.OWNER_ID).catch(() => null);
        await owner?.send(payload).catch(() => { /* DMs closed */ });
    }
}

module.exports = {
    name: 'guildAuditLogEntryCreate',
    async execute(entry, guild, client) {
        try {
            if (!guild) return;

            // Never react to our own actions. The join gate kicks and bans, and
            // a guard that alerted on its own work would be pure noise.
            if (entry.executorId && entry.executorId === client?.user?.id) return;

            let settings;
            try {
                settings = await getSettings(guild.id);
            } catch {
                return; // fail open, same as every other gate path
            }
            if (!settings.enabled) return;

            // Bookkeeping first, and independent of the guard. Discord discards
            // its audit log after 45 days, so a history only exists if it was
            // being kept before anyone thought to ask for it. This records and
            // returns: it raises nothing and feeds no threshold.
            await modlog.record(guild, entry);

            if (!settings.guard_enabled) return;

            const verdict = guard.record(guild.id, entry, settings);
            if (!verdict) return;

            logger.warn('[GUARD] Threshold crossed', {
                guildId: guild.id, actorId: verdict.actorId,
                bucket: verdict.bucket, count: verdict.count, limit: verdict.limit,
            });

            await alert(guild, settings, verdict, client);
        } catch (error) {
            logger.error('Audit-log guard failed', { error: error.message, stack: error.stack });
        }
    },
};
