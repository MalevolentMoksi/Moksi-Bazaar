// src/web/pages/member.js
/**
 * One member, everything known: the dossier /lookup shows in an embed, with
 * room to actually read it. Live profile from the gateway, durable history
 * from the database, and a suspicion evaluation run fresh on the spot with
 * the guild's real settings.
 */

const { getSettings } = require('../../utils/joinGate/config');
const suspicion = require('../../utils/joinGate/suspicion');
const { collectProtectedNames } = require('../../utils/joinGate/enforcement');
const watch = require('../../utils/joinGate/watch');
const activity = require('../../utils/joinGate/activity');
const { memberActivityOne, gateAttempts, recentWarns, recentModActions } = require('../queries');
const {
    html, card, pill, table, fmtNumber, fmtAgo, fmtDateTime, avatarUrl,
    discordUserUrl, discordMessageUrl,
} = require('../html');

const TIER_STATE = { clear: 'on', watch: 'warn', suspect: 'warn', malicious: 'danger' };
const ACTION_STATE = { ban: 'danger', kick: 'warn', timeout: 'warn', unban: 'on', timeout_cleared: 'on' };

async function data(client, guildId, userId) {
    const guild = client.guilds.cache.get(guildId);
    const settings = await getSettings(guildId);

    const member = await guild?.members.fetch(userId).catch(() => null) ?? null;
    const user = member?.user ?? await client.users.fetch(userId).catch(() => null);

    const [activityRow, trackingSince, warns, actions, attempts] = await Promise.all([
        memberActivityOne(guildId, userId).catch(() => null),
        activity.trackingSince().catch(() => 0),
        recentWarns(guildId, { userId, limit: 10 }).catch(() => ({ rows: [], total: 0 })),
        recentModActions(guildId, { targetId: userId, limit: 15 }).catch(() => ({ rows: [], total: 0 })),
        gateAttempts(guildId, userId).catch(() => null),
    ]);

    // The same call the join path makes, minus the context that only exists at
    // join time (burst, correlation). Participation mirrors the backtest: only
    // time the counter was actually running counts as observed.
    let evaluation = null;
    if (user && guild) {
        const now = Date.now();
        let participation = null;
        if (trackingSince) {
            const watchedFrom = Math.max(trackingSince, Number(member?.joinedTimestamp) || trackingSince);
            participation = {
                messages: activityRow?.message_count ?? 0,
                observedDays: (now - watchedFrom) / suspicion.DAY_MS,
            };
        }
        evaluation = suspicion.scoreAccount(user, {
            weights: settings.suspicion_weights,
            keywords: settings.suspicion_keywords ?? suspicion.DEFAULT_SCAM_KEYWORDS,
            protectedNames: collectProtectedNames(guild),
            correlation: null,
            inBurst: false,
            member,
            participation,
            tenureGraceDays: Number(settings.suspicion_tenure_grace_days),
            thresholds: {
                watch: Number(settings.suspicion_watch_at),
                suspect: Number(settings.suspicion_suspect_at),
                malicious: Number(settings.suspicion_malicious_at),
            },
        });
    }

    const windowMs = Number(settings.watch_window_minutes) * 60_000;
    return {
        userId,
        guildId,
        user: user ? {
            id: user.id,
            username: user.username,
            globalName: user.globalName ?? null,
            avatar: user.avatar ?? null,
            bot: Boolean(user.bot),
            createdTimestamp: Number(user.createdTimestamp),
        } : null,
        member: member ? {
            joinedTimestamp: Number(member.joinedTimestamp),
            nickname: member.nickname ?? null,
            roleCount: Math.max(0, (member.roles?.cache?.size ?? 1) - 1),
            timedOutUntil: member.communicationDisabledUntilTimestamp ?? null,
        } : null,
        activityRow,
        evaluation,
        explainText: evaluation ? suspicion.explain(evaluation) : null,
        warns,
        actions,
        attempts,
        watched: watch.isWatched(guildId, userId, windowMs),
        // The channel id is not information; the name is. The gateway has it
        // for nothing, so a row says where this was said rather than making
        // the reader go and find out.
        evidence: watch.evidenceFor(guildId, userId).map(item => ({
            ...item,
            channelName: guild?.channels?.cache?.get(item.channelId)?.name ?? null,
        })),
        now: Date.now(),
    };
}

function render(model) {
    if (!model.user) {
        return card({
            title: 'Unknown account',
            body: html`<p class="empty">Discord returned nothing for <span class="mono">${model.userId}</span>.
                Deleted account, or a mistyped ID.</p>`,
        });
    }

    const u = model.user;
    const m = model.member;

    const profile = card({
        title: 'Profile',
        body: html`<div class="profile-head">
            <img src="${avatarUrl(u.id, u.avatar, 128)}" alt="" width="72" height="72">
            <div>
                <div class="profile-name">${u.globalName ?? u.username}
                    ${u.bot ? pill('warn', 'bot') : ''}
                    ${m ? pill('on', 'in server') : pill('off', 'not in server')}
                    ${m?.timedOutUntil && m.timedOutUntil > model.now ? pill('danger', 'timed out') : ''}
                    ${model.watched ? pill('warn', 'in watch window') : ''}
                </div>
                <div class="hint">@${u.username}${m?.nickname ? html` · goes by "${m.nickname}"` : ''}</div>
                <div class="sub mono">${u.id}
                    <a class="out" href="${discordUserUrl(u.id)}" target="_blank" rel="noopener">open in Discord</a>
                </div>
            </div>
        </div>
        <dl class="kv kv-below">
            <dt>Account created</dt><dd><span title="${fmtDateTime(u.createdTimestamp)}">${fmtAgo(u.createdTimestamp, model.now)}</span></dd>
            ${m ? html`<dt>Joined</dt><dd><span title="${fmtDateTime(m.joinedTimestamp)}">${fmtAgo(m.joinedTimestamp, model.now)}</span></dd>
            <dt>Roles</dt><dd>${fmtNumber(m.roleCount)}</dd>` : ''}
            ${model.attempts ? html`<dt>Gate rejoins</dt><dd>${fmtNumber(model.attempts.attempts)} attempt(s), last ${fmtAgo(model.attempts.last_seen_ms, model.now)}</dd>` : ''}
        </dl>`,
    });

    const e = model.evaluation;
    const scoreCard = e ? card({
        title: 'Suspicion, evaluated now',
        hint: 'same scorer as the join path, current settings',
        body: html`
            <div class="score-line">
                <span class="score mono">${e.score}</span>
                ${pill(TIER_STATE[e.tier] ?? 'off', e.tier)}
                ${e.forcedByDiscord ? pill('danger', 'flagged by Discord') : ''}
            </div>
            <pre class="mono breakdown">${model.explainText}</pre>`,
        footer: html`Trust applied: ${e.trustApplied}${e.trustCapped ? ' (capped)' : ''}. A paid profile cannot clear a bad one.`,
    }) : '';

    const a = model.activityRow;
    const activityCard = card({
        title: 'Activity',
        body: a ? html`<dl class="kv">
            <dt>Messages tracked</dt><dd class="mono">${fmtNumber(a.message_count)}</dd>
            <dt>First tracked</dt><dd><span title="${fmtDateTime(a.first_message_ms)}">${fmtAgo(a.first_message_ms, model.now)}</span></dd>
            <dt>Last spoke</dt><dd><span title="${fmtDateTime(a.last_message_ms)}">${fmtAgo(a.last_message_ms, model.now)}</span></dd>
        </dl>` : html`<p class="empty">Not a single tracked message. Counting only covers time since tracking shipped, so long-quiet members and pure lurkers both look like this.</p>`,
    });

    const evidenceCard = model.evidence.length ? card({
        title: 'Watch window evidence',
        hint: 'what they said since joining, in memory only',
        body: table({
            columns: [
                { key: 'content', label: 'Message', render: r => r.content },
                {
                    key: 'channelId', label: 'Channel',
                    render: r => (r.channelName
                        ? html`#${r.channelName}`
                        : html`<span class="mono">${r.channelId}</span>`),
                },
                {
                    key: 'at', label: 'When', numeric: true,
                    // The excerpt is what was said; the link is everything
                    // around it. A message the bot has since deleted 404s to
                    // the reader, which is itself the answer to "is it gone".
                    render: (r) => {
                        const url = discordMessageUrl(model.guildId, r.channelId, r.messageId);
                        const when = fmtAgo(r.at, model.now);
                        return url
                            ? html`<a href="${url}" target="_blank" rel="noopener">${when}</a>`
                            : when;
                    },
                },
            ],
            rows: model.evidence,
        }),
    }) : '';

    const historyCard = card({
        title: 'Moderation history',
        hint: model.actions.total ? `${fmtNumber(model.actions.total)} action(s) on record` : '',
        body: table({
            columns: [
                { key: 'action', label: 'Action', render: r => pill(ACTION_STATE[r.action] ?? 'off', r.action) },
                { key: 'actor', label: 'By', render: r => r.actor_tag ?? 'unknown' },
                { key: 'reason', label: 'Reason', render: r => r.reason ?? '' },
                { key: 'at', label: 'When', numeric: true, render: r => html`<span title="${fmtDateTime(r.at_ms)}">${fmtAgo(r.at_ms, model.now)}</span>` },
            ],
            rows: model.actions.rows,
            empty: 'Clean. Nothing recorded against them.',
        }),
    });

    const warnsCard = model.warns.rows.length ? card({
        title: 'Warns',
        body: table({
            columns: [
                { key: 'moderator', label: 'By', render: r => r.moderator ?? 'unknown' },
                { key: 'reason', label: 'Reason', render: r => r.reason ?? '' },
                { key: 'at', label: 'When', numeric: true, render: r => fmtAgo(r.created_at_ms, model.now) },
            ],
            rows: model.warns.rows,
        }),
    }) : '';

    return html`
        <p><a href="/members">&larr; all members</a></p>
        <div class="row-cards">${profile}${scoreCard}</div>
        <div class="spacer"></div>
        <div class="row-cards">${activityCard}${evidenceCard}</div>
        <div class="spacer"></div>
        ${historyCard}
        ${warnsCard}`;
}

module.exports = { data, render };
