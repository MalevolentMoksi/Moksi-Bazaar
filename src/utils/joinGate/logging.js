// src/utils/joinGate/logging.js
/**
 * Join Gate: log routing.
 *
 * Four independent categories, each with its own optional channel and its own
 * on/off switch. A category with no channel of its own falls back to the
 * default log channel, so "kicks and failures in the same place" is just
 * leaving both overrides unset, while "failures to staff, kicks to audit"
 * is setting two overrides.
 *
 * Nothing in here is allowed to throw. A broken log channel must never stop
 * the gate from doing its job.
 */

const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const logger = require('../logger');
const { formatDays, DAY_MS } = require('./config');

const CATEGORIES = {
    kick: { channelKey: 'log_kick_channel_id', toggleKey: 'log_kicks', label: 'Kicks & bans' },
    failure: { channelKey: 'log_failure_channel_id', toggleKey: 'log_failures', label: 'Failures' },
    preview: { channelKey: 'log_preview_channel_id', toggleKey: 'log_previews', label: 'Dry-run previews' },
    config: { channelKey: 'log_config_channel_id', toggleKey: 'log_config', label: 'Config changes' },
};

const COLORS = {
    kick: 0xe8a33d,
    ban: 0xd64545,
    failure: 0xd64545,
    preview: 0x8a8a8a,
    config: 0x5865f2,
    burst: 0xff4d4d,
};

const REQUIRED_PERMS = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
];

function toUnix(ms) {
    return Math.floor(Number(ms) / 1000);
}

/**
 * Resolves the channel a category should be written to, or null.
 * Only channels inside the same guild are ever considered; a stale ID from
 * another server must not become a leak.
 *
 * @returns {Promise<import('discord.js').GuildTextBasedChannel|null>}
 */
async function resolveChannel(guild, settings, category) {
    const meta = CATEGORIES[category] ?? CATEGORIES.failure;
    if (settings[meta.toggleKey] === false) return null;

    const channelId = settings[meta.channelKey] || settings.log_channel_id;
    if (!channelId) return null;

    const channel = guild.channels.cache.get(channelId)
        ?? await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased() || channel.guild?.id !== guild.id) return null;

    const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    if (!me) return null;
    if (!channel.permissionsFor(me)?.has(REQUIRED_PERMS)) {
        logger.warn('[JOIN-GATE] Missing permissions in log channel', {
            guildId: guild.id, channelId, category,
        });
        return null;
    }
    return channel;
}

/** Diagnostic view of where each category currently points. */
async function describeRouting(guild, settings) {
    const out = {};
    for (const [category, meta] of Object.entries(CATEGORIES)) {
        const overrideId = settings[meta.channelKey];
        const effectiveId = overrideId || settings.log_channel_id;
        const channel = await resolveChannel(guild, settings, category);
        out[category] = {
            label: meta.label,
            enabled: settings[meta.toggleKey] !== false,
            overrideId,
            effectiveId,
            usable: Boolean(channel),
        };
    }
    return out;
}

async function send(guild, settings, category, payload) {
    try {
        const channel = await resolveChannel(guild, settings, category);
        if (!channel) return false;
        await channel.send(payload);
        return true;
    } catch (error) {
        logger.warn('[JOIN-GATE] Log send failed', {
            guildId: guild?.id, category, error: error.message,
        });
        return false;
    }
}

/**
 * Reports the outcome of a single evaluated member.
 * Dry-run outcomes go to the preview category; everything else splits between
 * kick and failure so the two can live in different channels.
 */
async function logOutcome(guild, settings, entry) {
    const {
        user, decision, result, origin, attempt, dryRun,
    } = entry;

    // "The member already left" is not a failure worth putting in a staff
    // channel; it is the gate discovering it had nothing left to do. Route it
    // with the normal outcomes so the failure channel stays meaningful.
    const benign = !result.ok && result.benign;
    const category = dryRun ? 'preview' : (result.ok || benign ? 'kick' : 'failure');

    let status;
    let color;
    if (dryRun) {
        status = result.action === 'ban'
            ? '🧪 **Dry run**: would temp-ban'
            : '🧪 **Dry run**: would kick';
        color = COLORS.preview;
    } else if (result.ok) {
        status = result.action === 'ban' ? '🔨 **Temporarily banned**' : '👢 **Kicked**';
        color = result.action === 'ban' ? COLORS.ban : COLORS.kick;
    } else if (benign) {
        status = `➖ **No action taken**: ${result.error}`;
        color = COLORS.preview;
    } else {
        status = `⚠️ **Failed**: ${result.error ?? 'unknown error'}`;
        color = COLORS.failure;
    }

    const embed = new EmbedBuilder()
        .setColor(color)
        .setAuthor({
            name: `${user.tag ?? user.username} (${user.id})`,
            iconURL: user.displayAvatarURL?.() ?? undefined,
        })
        .setDescription(status)
        .addFields(
            { name: 'Account created', value: `<t:${toUnix(user.createdTimestamp)}:F>`, inline: false },
            { name: 'Age at join', value: `${(decision.ageMs / DAY_MS).toFixed(2)} days`, inline: true },
            { name: 'Threshold', value: `${formatDays(settings.min_account_age_minutes)} days`, inline: true },
            { name: 'Eligible', value: `<t:${toUnix(decision.eligibleAt)}:R>`, inline: true },
            { name: 'Join attempt', value: `#${attempt}`, inline: true },
            { name: 'DM', value: result.dm ?? 'n/a', inline: true },
            { name: 'Trigger', value: origin === 'sweep' ? 'catch-up sweep' : 'on join', inline: true },
        )
        .setTimestamp();

    if (result.action === 'ban' && result.unbanAt) {
        embed.addFields({
            name: 'Auto-unban',
            value: `<t:${toUnix(result.unbanAt)}:F> (<t:${toUnix(result.unbanAt)}:R>)`,
            inline: false,
        });
    }

    if (result.hint) {
        embed.addFields({ name: 'How to fix', value: result.hint.slice(0, 1024), inline: false });
    }

    return send(guild, settings, category, { embeds: [embed] });
}

/** Raid alert. Routed to the failure channel; it is a "look at me" event. */
async function logBurst(guild, settings, { count, windowSeconds }) {
    const embed = new EmbedBuilder()
        .setColor(COLORS.burst)
        .setTitle('🚨 Join burst detected')
        .setDescription(
            `**${count}** accounts were caught by the join gate within ${windowSeconds}s.\n` +
            'Removals are being processed one at a time to stay inside Discord\'s rate limits, ' +
            'so there may be a short delay before the server looks clean again.'
        )
        .setTimestamp();

    return send(guild, settings, 'failure', { embeds: [embed] });
}

/** Audit trail for panel edits. */
async function logConfigChange(guild, settings, { actor, summary, details }) {
    const embed = new EmbedBuilder()
        .setColor(COLORS.config)
        .setTitle('⚙️ Join gate configuration changed')
        .setDescription(summary.slice(0, 4096))
        .addFields({ name: 'Changed by', value: `<@${actor.id}> (${actor.id})`, inline: false })
        .setTimestamp();

    if (details) {
        embed.addFields({ name: 'Details', value: details.slice(0, 1024), inline: false });
    }

    return send(guild, settings, 'config', { embeds: [embed] });
}

/**
 * Sends a probe to whatever channel a given category currently resolves to.
 * `category` may be 'default', which tests the fallback channel directly.
 */
async function logTest(guild, settings, category, actor) {
    const isDefault = category === 'default';
    const label = isDefault ? 'Default channel' : (CATEGORIES[category]?.label ?? category);

    const embed = new EmbedBuilder()
        .setColor(COLORS.config)
        .setTitle('🧪 Join gate: routing test')
        .setDescription(`This is where **${label}** entries will appear.`)
        .addFields({ name: 'Requested by', value: `<@${actor.id}>`, inline: true })
        .setTimestamp();

    if (isDefault) {
        // Bypass category resolution: test the fallback channel on its own.
        const channelId = settings.log_channel_id;
        if (!channelId) return false;
        const channel = guild.channels.cache.get(channelId)
            ?? await guild.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased() || channel.guild?.id !== guild.id) return false;
        return channel.send({ embeds: [embed] }).then(() => true).catch(() => false);
    }

    return send(guild, settings, category, { embeds: [embed] });
}

/** Reports an automatic unban after a temp-ban expires. */
async function logUnban(guild, settings, { userId, bannedAtMs, ok, error }) {
    const embed = new EmbedBuilder()
        .setColor(ok ? 0x3ba55d : COLORS.failure)
        .setTitle(ok ? '🔓 Temp-ban lifted' : '⚠️ Failed to lift temp-ban')
        .setDescription(
            ok
                ? `<@${userId}> (${userId}) can rejoin. Their account is now old enough.`
                : `Could not unban <@${userId}> (${userId}): ${error ?? 'unknown error'}`
        )
        .addFields({ name: 'Banned', value: `<t:${toUnix(bannedAtMs)}:R>`, inline: true })
        .setTimestamp();

    return send(guild, settings, ok ? 'kick' : 'failure', { embeds: [embed] });
}

module.exports = {
    CATEGORIES,
    resolveChannel,
    describeRouting,
    logOutcome,
    logBurst,
    logConfigChange,
    logUnban,
    logTest,
};
