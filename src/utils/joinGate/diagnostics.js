// src/utils/joinGate/diagnostics.js
/**
 * Join Gate: self-check.
 *
 * The failure modes of an auto-kicker are quiet ones: a missing privileged
 * intent means the event never fires, a low role means every kick 403s. Both
 * look identical to "working fine, nobody has joined". This turns those into
 * something the panel can show.
 */

const { GatewayIntentBits, PermissionFlagsBits } = require('discord.js');
const { thresholdMs, formatDays } = require('./config');

/**
 * @returns {Promise<{ok: boolean, checks: Array<{level: 'ok'|'warn'|'fail', label: string, detail: string}>}>}
 */
async function checkGuildHealth(guild, settings) {
    const checks = [];
    const add = (level, label, detail) => checks.push({ level, label, detail });

    // 1. Privileged intent. Without it guildMemberAdd never fires at all.
    const hasMembersIntent = guild.client.options.intents.has(GatewayIntentBits.GuildMembers);
    add(
        hasMembersIntent ? 'ok' : 'fail',
        'Server Members Intent',
        hasMembersIntent
            ? 'Enabled. Join events will be received.'
            : 'MISSING. The gate can never fire. Enable "Server Members Intent" in the '
              + 'Discord Developer Portal → your app → Bot → Privileged Gateway Intents, then restart.'
    );

    const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    if (!me) {
        add('fail', 'Bot member', 'Could not resolve the bot\'s own member object in this server.');
        return { ok: false, checks };
    }

    // 2. Kick permission.
    const canKick = me.permissions.has(PermissionFlagsBits.KickMembers);
    add(
        canKick ? 'ok' : 'fail',
        'Kick Members',
        canKick ? 'Granted.' : 'MISSING. Every removal will fail. Grant the permission to the bot\'s role.'
    );

    // 3. Ban permission, only relevant when escalation is armed.
    if (settings.escalate_enabled) {
        const canBan = me.permissions.has(PermissionFlagsBits.BanMembers);
        add(
            canBan ? 'ok' : 'fail',
            'Ban Members',
            canBan
                ? 'Granted. Escalation temp-bans can be applied and lifted.'
                : 'MISSING, but escalation is on. Repeat offenders will fall back to a failed ban.'
        );
    }

    // 4. Role position. This is the one that bites servers with an autorole bot.
    const botPosition = me.roles.highest.position;
    const rolesAbove = guild.roles.cache.filter(
        r => r.position >= botPosition && r.id !== guild.id && !r.managed
    ).size;
    if (botPosition <= 1) {
        add('fail', 'Role hierarchy', 'The bot\'s highest role sits at the bottom. It cannot remove anyone.');
    } else if (rolesAbove > 0) {
        add(
            'warn',
            'Role hierarchy',
            `${rolesAbove} role(s) sit at or above **${me.roles.highest.name}**. Members holding one of `
            + 'them cannot be removed. Make sure the role your autorole bot assigns is below it.'
        );
    } else {
        add('ok', 'Role hierarchy', `**${me.roles.highest.name}** is above every other role.`);
    }

    // 5. Threshold sanity.
    if (thresholdMs(settings) <= 0) {
        add('warn', 'Threshold', 'Set to 0 days, so the gate will never remove anyone.');
    } else {
        add('ok', 'Threshold', `${formatDays(settings.min_account_age_minutes)} days.`);
    }

    // 6. Invite URL, if the DM promises one.
    if (settings.dm_enabled && settings.dm_append_invite && !settings.dm_invite_url) {
        add('warn', 'Rejoin invite', 'No invite is set, so removed users get no link back. Set one under Messaging.');
    }

    // 7. Dry run is a state people forget they left on.
    if (settings.enabled && settings.dry_run) {
        add('warn', 'Dry run', 'ACTIVE. The gate is only logging. Nobody is actually being removed.');
    }

    const ok = !checks.some(c => c.level === 'fail');
    return { ok, checks };
}

module.exports = { checkGuildHealth };
