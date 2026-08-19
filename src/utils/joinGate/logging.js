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
const { ui, quiet } = require('../ui/panel');
const { recordSuspicionReport } = require('../db');
const { reportRows } = require('./reportActions');
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

// ── FACTS, RANKED ───────────────────────────────────────────────────────────
/**
 * These reports are read once, late, by someone deciding in five seconds
 * whether they have to do anything. Ranking is the whole job, and there are
 * exactly three weights available:
 *
 *   the header block  what happened, to whom, on what grounds, and what
 *                     happens next. Enough on its own to close the tab.
 *   a fact            one line, one label, below the rule. Reserved for what
 *                     varies per case and could change what a moderator does.
 *   an aside          background, several items to a line, grey. Never
 *                     actionable, never absent either.
 *
 * The previous version had one weight. Five items were strung onto a single
 * subtext line with dots between them, so "eligible in 12 days", which is the
 * answer to the only question staff ever ask about a kicked joiner, sat in the
 * same grey as "caught on join", and the line wrapped mid-item on a normal
 * window.
 */

/**
 * One fact, one line.
 *
 * Deliberately not inline: an inline field shares its row with the next two,
 * which is the compression this exists to undo. In the Components V2 rendering
 * a short value sits beside its label; in the classic embed it sits under it.
 * Both read as one fact either way.
 */
function fact(name, value) {
    return { name, value: String(value), inline: false };
}

/** Discord's idiom for a field with no label. Written as an escape on purpose. */
const BLANK_FIELD_NAME = '​';

/**
 * Background, clumped on purpose.
 *
 * This is the one place a run of items separated by dots is right, because
 * here they really are equals: circumstances, none of which changes what
 * anybody does, all of which you want on the record. Anything that would
 * change a decision has no business in here.
 */
function aside(...items) {
    const kept = items.filter(Boolean);
    if (!kept.length) return null;
    return { name: BLANK_FIELD_NAME, value: `-# ${kept.join(' · ')}`, inline: false };
}

/** True for the trivia line, which several callers need to tell apart. */
function isAside(field) {
    return String(field?.value ?? '').startsWith('-# ');
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
 * When the door opens again, which is the only question anybody asks about a
 * joiner the gate turned away.
 *
 * An age ban schedules its own lift for the exact instant the account becomes
 * old enough (enforcement passes `decision.eligibleAt` straight through as
 * `unbanAt`), so the report used to state one moment twice: once as "eligible
 * in 12 days" buried in the grey line, and once as a full "Auto-unban" field.
 * Two weights, one fact, and the louder of the two was the less useful.
 */
function returnLine(decision, result, dryRun) {
    const at = result.action === 'ban' && result.unbanAt ? result.unbanAt : decision.eligibleAt;
    if (!Number.isFinite(Number(at))) return null;

    // A relative stamp carries the absolute one in its tooltip, so the long
    // form is only worth the room when a ban is holding someone out and the
    // exact moment is something staff might plan around.
    if (!dryRun && result.ok && result.action === 'ban') {
        return `Ban lifts <t:${toUnix(at)}:R>, on <t:${toUnix(at)}:F>`;
    }
    if (!dryRun && result.ok) return `Can rejoin <t:${toUnix(at)}:R>`;
    // Nothing was done, so nothing is holding them out; the date is still the
    // date they stop being too new.
    return `Eligible <t:${toUnix(at)}:R>`;
}

/**
 * Reports the outcome of a single evaluated member.
 * Dry-run outcomes go to the preview category; everything else splits between
 * kick and failure so the two can live in different channels.
 *
 * Read top to bottom it answers, in order: what happened, to whom, on what
 * grounds, what happens next, and only then the paperwork.
 *
 * @returns {{embed: import('discord.js').EmbedBuilder, category: string}}
 */
function outcomeEmbed(settings, entry) {
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

    const returns = returnLine(decision, result, dryRun);

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
            + `threshold is ${formatDays(settings.min_account_age_minutes)} days`
            + (returns ? `\n${returns}` : '')
        )
        .setTimestamp();

    const repeat = Number(attempt) > 1;

    embed.addFields([
        // Whether they were told why. The one thing that decides how the
        // conversation goes when they turn up in modmail asking.
        // "DM: suppressed" read to moderators as the bot restricting the
        // user's DMs rather than declining to send its own, which is the
        // opposite of what it meant. The label now names the question the
        // field actually answers, and every value answers it as yes or no.
        fact('Told them why', result.dm ?? 'unknown'),
        // At #1 this is noise on every single report. Past that it is somebody
        // working out how to get in, which is worth a line of its own.
        repeat ? fact('Join attempt', `#${attempt}`) : null,
        result.hint ? fact('How to fix', result.hint.slice(0, 1024)) : null,
        // What a moderator reading this should DO, which the report used to
        // leave them to guess. Seeing "Temporarily banned" on an obvious
        // throwaway, the natural instinct is to reach for a permanent ban,
        // and that is exactly what happened: the gate's lift was still
        // scheduled underneath it. A manual ban now cancels the lift, and
        // saying so here is what stops the next person having to find out.
        // A fact, not an aside: this is the one line that asks for a decision.
        !dryRun && result.ok && result.action === 'ban'
            ? fact('What to do', 'Nothing. This lifts by itself. Ban them yourself only if you want it '
                + 'permanent, which cancels the automatic lift.')
            : null,
        aside(
            `account made <t:${toUnix(user.createdTimestamp)}:D>`,
            origin === 'sweep' ? 'caught by the catch-up sweep' : 'caught on join',
            repeat ? null : 'first attempt',
        ),
    ].filter(Boolean));

    return { embed, category };
}

async function logOutcome(guild, settings, entry) {
    const { embed, category } = outcomeEmbed(settings, entry);
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
            // Padded inside the code span, not outside it: "+ 35" was the sign
            // and the number separated by the padding meant to align them.
            .map(s => `\`${`${s.points > 0 ? '+' : ''}${s.points}`.padStart(4)}\` **${s.label}**: ${s.detail}`)
        : ['_no signals fired_'];

    // What the bot did about it, promoted: it is the first thing a moderator
    // reading this at midnight needs, and it decides whether they have to do
    // anything themselves.
    let did;
    let qualifier = null;
    // When it ends is not a footnote to what was done, it is the next thing
    // anybody has to know, so it gets a line of its own rather than becoming
    // the middle item of "banned · lifts in 7 days · 2 messages removed".
    let until = null;
    if (dryRun) {
        did = '🧪 Dry run';
        qualifier = 'no action taken';
    } else if (action === 'log' || action === 'none') {
        did = 'Logged only';
        qualifier = 'no action taken';
    } else if (actionOutcome?.ok && action === 'ban') {
        did = 'Temporarily banned';
        if (actionOutcome.unbanAt) until = `Ban lifts <t:${toUnix(actionOutcome.unbanAt)}:R>`;
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

    const embed = new EmbedBuilder()
        .setColor(style.color)
        .setAuthor({
            name: `${user.tag ?? user.username} (${user.id})`,
            iconURL: user.displayAvatarURL?.() ?? undefined,
        })
        .setTitle(`${style.icon} ${isBehaviour ? 'Behaviour flag' : style.word} · score ${result.score}`)
        // The clickable line. Staff were looking the offender up by hand
        // because the author header is plain text ("it doesnt say who").
        //
        // Where it happened is a link, and following it is the next thing a
        // moderator does, so it is a line rather than the third item in a grey
        // run. What left that run entirely is the tier: "suspect tier" under a
        // title reading "Suspicious · score 51" is the same word twice, and
        // "first messages after joining" is what the footer already says.
        .setDescription(
            `<@${user.id}>\n`
            + `**${did}**${qualifier ? ` · ${qualifier}` : ''}`
            + (until ? `\n${until}` : '')
            + (channelId ? `\nSeen in <#${channelId}>` : '')
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
        embed.addFields(fact(
            'Invite used',
            `\`${inv.code}\`${inv.inviterId ? ` from <@${inv.inviterId}>` : ''}`
                + (inv.usesInWindow > 1 ? ` (${inv.usesInWindow} joins in 5min)` : '')
                // Several codes moved between snapshots, so this is the most
                // likely one rather than a known one. Say so.
                + (inv.ambiguous ? '\n-# several invites moved at once; best guess' : ''),
        ));
    }

    // Last, because it is the least of it. How new the account is repeats a
    // signal above whenever the age is what fired the report, and matters on
    // its own when something else did.
    embed.addFields(aside(`account made <t:${toUnix(user.createdTimestamp)}:R>`));

    // Filed before it is posted, because the buttons need the row id and the
    // signals only exist here. A failed write costs the panel its mark button
    // and nothing else; the report still goes out.
    const reportId = await recordSuspicionReport({
        guildId: guild.id,
        userId: user.id,
        score: result.score,
        tier: result.tier,
        source: result.source ?? 'profile',
        action: dryRun ? 'dry-run' : action,
        signals: result.signals,
        channelId,
    }).catch((error) => {
        logger.warn('[JOIN-GATE] Could not file report', { error: error.message });
        return null;
    });

    const rows = reportRows({
        reportId,
        userId: user.id,
        jumpUrl: jumpUrl(guild, evidence, actionOutcome),
    });

    return send(guild, settings, 'suspicion', ui(embed, rows, { scope: 'mod' }));
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
function jumpUrl(guild, evidence, actionOutcome) {
    if (Number(actionOutcome?.deleted) > 0) return null;
    const last = evidence?.length ? evidence[evidence.length - 1] : null;
    if (!guild?.id || !last?.channelId || !last?.messageId) return null;
    return `https://discord.com/channels/${guild.id}/${last.channelId}/${last.messageId}`;
}

/** Raid alert. Routed to the failure channel; it is a "look at me" event. */
async function logBurst(guild, settings, { count, gatedCount = count, windowSeconds }) {
    // With burst_count_all_joins on, the window holds clean arrivals too, and
    // the difference between "a raid" and "the server got popular for an hour"
    // has to be visible in the alert itself. A surge of people who all passed
    // the gate is announced as a surge, never as an attack.
    const mostlyClean = gatedCount <= Math.floor(count / 2);
    const title = mostlyClean ? '📈 Join surge' : '🚨 Join burst detected';
    const description = mostlyClean
        ? `**${count}** accounts joined within ${windowSeconds}s, and **${gatedCount}** of them were caught `
            + 'by the join gate. Most of this wave passed every check: it reads as popularity, not a raid, '
            + 'but it seemed worth telling you the door is busy.'
        : `**${gatedCount}** of **${count}** accounts arriving within ${windowSeconds}s were caught by the join gate.\n`
            + 'Removals are being processed one at a time to stay inside Discord\'s rate limits, '
            + 'so there may be a short delay before the server looks clean again.';

    const embed = new EmbedBuilder()
        .setColor(COLORS.burst)
        .setTitle(title)
        .setDescription(description)
        .setTimestamp();

    return send(guild, settings, 'failure', ui(embed, [], { scope: 'mod' }));
}

/** Audit trail for panel edits. */
async function logConfigChange(guild, settings, { actor, summary, details }) {
    const embed = new EmbedBuilder()
        .setColor(COLORS.config)
        .setTitle('⚙️ Join gate configuration changed')
        .setDescription(summary.slice(0, 4096))
        .setTimestamp();

    if (details) embed.addFields(fact('Details', details.slice(0, 1024)));
    // Who did it is provenance: always wanted on an audit line, never the
    // reason anybody opened it.
    embed.addFields(aside(`changed by <@${actor.id}> (${actor.id})`));

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
        .addFields(aside(`requested by <@${actor.id}>`))
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
        .addFields(aside(`banned <t:${toUnix(bannedAtMs)}:R>`))
        .setTimestamp();

    return send(guild, settings, ok ? 'kick' : 'failure', ui(embed, [], { scope: 'mod' }));
}

/**
 * A pending automatic lift was cancelled because a human outranked it.
 *
 * The scenario is real and was watched happening: the gate temp-bans a
 * throwaway, a moderator decides it deserves better and bans it outright
 * through their own tools, and ten days later the scheduler would have
 * quietly lifted the moderator's ban with a log line saying the account is
 * now old enough. A human's verdict outranks the gate's cooldown, and the
 * cancellation is said out loud so nobody has to reverse-engineer it.
 */
async function logSupersededUnban(guild, settings, { userId, cause }) {
    const banned = cause === 'ban';
    const embed = new EmbedBuilder()
        .setColor(COLORS.config)
        .setTitle('⚖️ Scheduled lift cancelled')
        .setDescription(banned
            ? `<@${userId}> (${userId}) was banned by a moderator while under a gate temp-ban. `
                + 'That ban outranks the gate: the automatic lift is cancelled, and the ban now '
                + 'stands until a human lifts it.'
            : `<@${userId}> (${userId}) was unbanned by a moderator before the gate's own lift. `
                + 'Nothing left to schedule.')
        .setTimestamp();

    return send(guild, settings, 'kick', ui(embed, [], { scope: 'mod' }));
}

module.exports = {
    CATEGORIES,
    resolveChannel,
    describeRouting,
    logOutcome,
    // Rendering, separated from routing so the layout can be pinned without a
    // fake guild and a fake channel in front of it.
    outcomeEmbed,
    fact,
    aside,
    isAside,
    logBurst,
    logConfigChange,
    logUnban,
    logSupersededUnban,
    logTest,
    logSuspicion,
};
