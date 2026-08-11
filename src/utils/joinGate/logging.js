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

const {
    EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const { ui, quiet } = require('../ui/panel');
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

/** A log notifies nobody, ever. See `quiet` in ui/panel for the incident. */
async function send(guild, settings, category, payload) {
    try {
        const channel = await resolveChannel(guild, settings, category);
        if (!channel) return false;
        await channel.send(quiet(payload));
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
 *
 * Read top to bottom it answers, in order: what happened, to whom, on what
 * grounds, and only then the paperwork. It used to open with a bare mention
 * and lay seven equally weighted fields under it, so the two numbers the
 * decision actually turned on (the age, the threshold) sat in the same
 * typeface as the DM receipt.
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

    let headline;
    let color;
    let lede = null;
    if (dryRun) {
        headline = result.action === 'ban' ? '🧪 Dry run: would temp-ban' : '🧪 Dry run: would kick';
        color = COLORS.preview;
    } else if (result.ok) {
        headline = result.action === 'ban' ? '🔨 Temporarily banned' : '👢 Kicked';
        color = result.action === 'ban' ? COLORS.ban : COLORS.kick;
    } else if (benign) {
        headline = '➖ No action taken';
        lede = result.error;
        color = COLORS.preview;
    } else {
        headline = `⚠️ Could not ${result.action ?? 'act'}`;
        lede = result.error ?? 'unknown error';
        color = COLORS.failure;
    }

    // The paperwork, in one subtext line. Every item is worth keeping and not
    // one of them is worth a heading.
    const paperwork = [
        `account made <t:${toUnix(user.createdTimestamp)}:D>`,
        `eligible <t:${toUnix(decision.eligibleAt)}:R>`,
        `join attempt #${attempt}`,
        `DM ${result.dm ?? 'n/a'}`,
        origin === 'sweep' ? 'caught by the catch-up sweep' : 'caught on join',
    ].join(' · ');

    const embed = new EmbedBuilder()
        .setColor(color)
        .setAuthor({
            name: `${user.tag ?? user.username} (${user.id})`,
            iconURL: user.displayAvatarURL?.() ?? undefined,
        })
        .setTitle(headline)
        // The header is plain text; this is the line you can actually click.
        // Send-side mention parsing is off, so it wakes nobody.
        .setDescription(
            `<@${user.id}>\n`
            + (lede ? `${lede}\n` : '')
            + `**${(decision.ageMs / DAY_MS).toFixed(2)} days old** at join, `
            + `threshold is ${formatDays(settings.min_account_age_minutes)} days\n`
            + `-# ${paperwork}`
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
 * An embed field value stops at 1024 characters. The arithmetic is the entire
 * point of the report, so a long breakdown continues into an unlabelled second
 * field rather than being cut off mid-signal.
 */
function chunkLines(lines, limit = 1000, maxChunks = 3) {
    const chunks = [];
    let current = '';
    for (const line of lines) {
        const next = current ? `${current}\n${line}` : line;
        if (next.length > limit && current) {
            chunks.push(current);
            if (chunks.length >= maxChunks) return chunks;
            current = line.slice(0, limit);
        } else {
            current = next.slice(0, limit);
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

/**
 * Reports a scored joiner. The whole point is that the arithmetic is visible,
 * so staff can judge the call rather than trusting a verdict.
 *
 * Laid out as a card and not a form. The header block answers who and what
 * happened to them; everything a moderator would have to read anyway is a
 * labelled group under it, and everything they would only read once is
 * subtext. The version this replaced ended in four fields of identical weight
 * ("Account created", "Source", "Outcome", "Where"), where "Outcome" was the
 * only one anybody needed at a glance, "Source" repeated the footer and "Tier"
 * repeated the title.
 */
async function logSuspicion(guild, settings, { user, result, action, actionOutcome, dryRun, channelId, evidence }) {
    const style = TIER_STYLE[result.tier] ?? TIER_STYLE.watch;
    const isBehaviour = result.source === 'behaviour';

    const signalLines = result.signals.length
        ? result.signals
            .slice()
            .sort((a, b) => b.points - a.points)
            .map(s => `\`${s.points > 0 ? '+' : ''}${String(s.points).padStart(3)}\` **${s.label}**: ${s.detail}`)
        : ['_no signals fired_'];

    // What the bot did about it, promoted: it is the first thing a moderator
    // reading this at midnight needs, and it decides whether they have to do
    // anything themselves.
    let did;
    let qualifier = null;
    if (dryRun) {
        did = '🧪 Dry run';
        qualifier = 'no action taken';
    } else if (action === 'log' || action === 'none') {
        did = 'Logged only';
        qualifier = 'no action taken';
    } else if (actionOutcome?.ok && action === 'ban') {
        did = 'Temporarily banned';
        if (actionOutcome.unbanAt) qualifier = `lifts <t:${toUnix(actionOutcome.unbanAt)}:R>`;
    }
    // Every non-ban success used to render as "kicked", so a timeout was
    // reported in the audit log as a removal that never happened.
    else if (actionOutcome?.ok && action === 'timeout') {
        did = actionOutcome.minutes ? `Timed out for ${actionOutcome.minutes} min` : 'Timed out';
    }
    else if (actionOutcome?.ok) did = 'Kicked';
    else {
        did = `⚠️ ${action} failed`;
        qualifier = actionOutcome?.error ?? 'unknown error';
    }

    if (actionOutcome?.deleted > 0) {
        const removed = `${actionOutcome.deleted} message${actionOutcome.deleted === 1 ? '' : 's'} removed`;
        qualifier = qualifier ? `${qualifier} · ${removed}` : removed;
    }

    // Where and how new the account is: worth keeping, never worth a heading.
    const context = [
        channelId ? `in <#${channelId}>` : null,
        `account made <t:${toUnix(user.createdTimestamp)}:R>`,
        isBehaviour ? 'first messages after joining' : `${result.tier} tier`,
    ].filter(Boolean).join(' · ');

    const embed = new EmbedBuilder()
        .setColor(style.color)
        .setAuthor({
            name: `${user.tag ?? user.username} (${user.id})`,
            iconURL: user.displayAvatarURL?.() ?? undefined,
        })
        .setTitle(`${style.icon} ${isBehaviour ? 'Behaviour flag' : style.word} · score ${result.score}`)
        // The clickable line. Staff were looking the offender up by hand
        // because the author header is plain text ("it doesnt say who").
        .setDescription(
            `<@${user.id}>\n`
            + `**${did}**${qualifier ? ` · ${qualifier}` : ''}\n`
            + `-# ${context}`
        )
        .setFooter({
            text: isBehaviour
                ? 'Triggered by what they posted, not by how the profile looks.'
                : 'Scores are advisory. Check the account before acting on it.',
        })
        .setTimestamp();

    chunkLines(signalLines).forEach((text, index) => {
        embed.addFields({ name: index === 0 ? 'Why it fired' : '​', value: text, inline: false });
    });

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

    return send(guild, settings, 'suspicion', ui(embed, jumpRow(guild, evidence, actionOutcome), { scope: 'mod' }));
}

/**
 * A link straight to the message that caused this, which is the one thing a
 * quoted excerpt cannot give you: context, replies, and whoever else was in
 * the channel at the time.
 *
 * Offered only while the message is still there. The gate deletes what it
 * quotes when it acts, and a jump button onto a deleted message is worse than
 * no button: it reads as a report pointing at something staff cannot see.
 */
function jumpRow(guild, evidence, actionOutcome) {
    if (Number(actionOutcome?.deleted) > 0) return [];
    const last = evidence?.length ? evidence[evidence.length - 1] : null;
    if (!guild?.id || !last?.channelId || !last?.messageId) return [];
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel('Jump to message')
            .setURL(`https://discord.com/channels/${guild.id}/${last.channelId}/${last.messageId}`),
    )];
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
        return channel.send(quiet(ui(embed, [], { scope: 'mod' }))).then(() => true).catch(() => false);
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
