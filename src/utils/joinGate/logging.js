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
const { ui } = require('../ui/panel');
const logger = require('../logger');
const { formatDays, DAY_MS } = require('./config');

const CATEGORIES = {
    kick: { channelKey: 'log_kick_channel_id', toggleKey: 'log_kicks', label: 'Kicks & bans' },
    failure: { channelKey: 'log_failure_channel_id', toggleKey: 'log_failures', label: 'Failures' },
    preview: { channelKey: 'log_preview_channel_id', toggleKey: 'log_previews', label: 'Dry-run previews' },
    config: { channelKey: 'log_config_channel_id', toggleKey: 'log_config', label: 'Config changes' },
    // The toggle governs only the LOG category. `suspicion_enabled` is the
    // scoring engine itself; using it here would let "stop logging this"
    // silently disarm the whole engine.
    suspicion: { channelKey: 'suspicion_log_channel_id', toggleKey: 'suspicion_log_enabled', label: 'Suspicion reports' },
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

/**
 * A log notifies nobody, ever. Panels quote what offenders posted verbatim,
 * and on a Components V2 surface that quote is real message content: one
 * quoted "@everyone" pinged the whole server from its own incident report.
 * Mentions still RENDER as clickable chips with parsing off, which is exactly
 * the combination a log wants: click through to the profile, wake no one.
 */
function silenced(payload) {
    return { ...payload, allowedMentions: { parse: [] } };
}

async function send(guild, settings, category, payload) {
    try {
        const channel = await resolveChannel(guild, settings, category);
        if (!channel) return false;
        await channel.send(silenced(payload));
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
        // The header is plain text; this is the line you can actually click.
        // Send-side mention parsing is off, so it wakes nobody.
        .setDescription(`<@${user.id}>\n${status}`)
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

    return send(guild, settings, category, ui(embed, [], { scope: 'mod' }));
}

const TIER_STYLE = {
    watch: { color: 0xf0c419, icon: '👁️', word: 'Worth a look' },
    suspect: { color: 0xe8732d, icon: '⚠️', word: 'Suspicious' },
    malicious: { color: 0xd64545, icon: '🚨', word: 'Highly suspicious' },
};

/**
 * Reports a scored joiner. The whole point is that the arithmetic is visible,
 * so staff can judge the call rather than trusting a verdict.
 */
async function logSuspicion(guild, settings, { user, result, action, actionOutcome, dryRun, channelId, evidence }) {
    const style = TIER_STYLE[result.tier] ?? TIER_STYLE.watch;
    const isBehaviour = result.source === 'behaviour';

    const breakdown = result.signals.length
        ? result.signals
            .slice()
            .sort((a, b) => b.points - a.points)
            .map(s => `\`${s.points > 0 ? '+' : ''}${String(s.points).padStart(3)}\` **${s.label}**: ${s.detail}`)
            .join('\n')
        : '_no signals fired_';

    let outcome;
    if (dryRun) outcome = '🧪 dry run, no action';
    else if (action === 'log' || action === 'none') outcome = 'logged only, no action taken';
    else if (actionOutcome?.ok && action === 'ban') {
        outcome = actionOutcome.unbanAt
            ? `temporarily banned, lifts <t:${toUnix(actionOutcome.unbanAt)}:R>`
            : 'temporarily banned';
    }
    // Every non-ban success used to render as "kicked", so a timeout was
    // reported in the audit log as a removal that never happened.
    else if (actionOutcome?.ok && action === 'timeout') {
        outcome = actionOutcome.minutes
            ? `timed out for ${actionOutcome.minutes} min`
            : 'timed out';
    }
    else if (actionOutcome?.ok) outcome = 'kicked';
    else outcome = `⚠️ ${action} failed: ${actionOutcome?.error ?? 'unknown error'}`;

    if (actionOutcome?.deleted > 0) {
        outcome += `, ${actionOutcome.deleted} message${actionOutcome.deleted === 1 ? '' : 's'} removed`;
    }

    const embed = new EmbedBuilder()
        .setColor(style.color)
        .setAuthor({
            name: `${user.tag ?? user.username} (${user.id})`,
            iconURL: user.displayAvatarURL?.() ?? undefined,
        })
        .setTitle(`${style.icon} ${isBehaviour ? 'Behaviour flag' : style.word}: score ${result.score}`)
        // The clickable line. Staff were looking the offender up by hand
        // because the author header is plain text ("it doesnt say who").
        .setDescription(`<@${user.id}>\n${breakdown.slice(0, 4000)}`)
        .addFields(
            { name: 'Account created', value: `<t:${toUnix(user.createdTimestamp)}:R>`, inline: true },
            { name: isBehaviour ? 'Source' : 'Tier', value: isBehaviour ? 'first messages after joining' : result.tier, inline: true },
            { name: 'Outcome', value: outcome, inline: true },
        )
        .setFooter({
            text: isBehaviour
                ? 'Triggered by what they posted, not by how the profile looks.'
                : 'Scores are advisory. Check the account before acting on it.',
        })
        .setTimestamp();

    if (channelId) {
        embed.addFields({ name: 'Where', value: `<#${channelId}>`, inline: true });
    }

    // What they actually posted. A report that says "score 117, invite link"
    // still leaves you opening three channels to find out what happened, and
    // by the time an action fired the messages may already be gone.
    if (evidence?.length) {
        const quoted = evidence
            .slice(-3)
            .map(item => {
                const text = String(item.content ?? '').replace(/\s+/g, ' ').trim();
                const shown = text.length > 180 ? `${text.slice(0, 180)}...` : (text || '(no text)');
                // Blockquoted so a scam link in the evidence is not rendered as
                // a clickable embed in the log channel.
                return `> <#${item.channelId}> \`${shown.replace(/`/g, "'")}\``;
            })
            .join('\n');
        embed.addFields({ name: 'What they posted', value: quoted.slice(0, 1000), inline: false });
    }
    if (result.inviteInfo?.known) {
        const inv = result.inviteInfo;
        embed.addFields({
            name: 'Invite used',
            value: `\`${inv.code}\`${inv.inviterId ? ` from <@${inv.inviterId}>` : ''}`
                + (inv.usesInWindow > 1 ? ` (${inv.usesInWindow} joins in 5min)` : '')
                // Several codes moved between snapshots, so this is the most
                // likely one rather than a known one. Say so.
                + (inv.ambiguous ? '\n-# several invites moved at once; best guess' : ''),
            inline: true,
        });
    }

    return send(guild, settings, 'suspicion', ui(embed, [], { scope: 'mod' }));
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

    return send(guild, settings, 'failure', ui(embed, [], { scope: 'mod' }));
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

    return send(guild, settings, 'config', ui(embed, [], { scope: 'mod' }));
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
        return channel.send(silenced(ui(embed, [], { scope: 'mod' }))).then(() => true).catch(() => false);
    }

    return send(guild, settings, category, ui(embed, [], { scope: 'mod' }));
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

    return send(guild, settings, ok ? 'kick' : 'failure', ui(embed, [], { scope: 'mod' }));
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
    logSuspicion,
};
