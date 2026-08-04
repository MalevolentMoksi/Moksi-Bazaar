// src/web/pages/backtest.js
/**
 * The backtest, on a screen big enough for it.
 *
 * Same engine as the panel button: score every current member with the live
 * settings, twice (with and without tenure forgiveness), and find cohorts in
 * the roster. What the embed had to truncate to 25 lines gets a full table,
 * and every row links into the dossier.
 *
 * The run is gated behind ?run=1 on purpose. Scoring means fetching every
 * member, which on a 1,600-member server takes real seconds; a page that
 * costs that much should never run because somebody breathed on a nav link.
 *
 * Ban commands are rendered as PASTE BLOCKS, never buttons. A ban this bot
 * issues is attributed to this bot and vanishes from Dyno's ?modstats; pasted
 * by you, it counts as yours. That decision predates this page.
 */

const { getSettings } = require('../../utils/joinGate/config');
const { backtestGuild } = require('../../utils/joinGate/enforcement');
const { describeShape } = require('../../utils/joinGate/cohorts');
const { html, raw, card, pill, table, fmtNumber, fmtAgo, fmtDateTime } = require('../html');

const TIER_STATE = { clear: 'on', watch: 'warn', suspect: 'warn', malicious: 'danger' };
const MAX_LIMIT = 200;

function fmtSpan(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '0m';
    const days = Math.floor(n / 86_400_000);
    const hours = Math.floor((n % 86_400_000) / 3_600_000);
    const minutes = Math.floor((n % 3_600_000) / 60_000);
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

async function data(client, guildId, query = {}) {
    const run = query.run === '1';
    const limit = Math.min(MAX_LIMIT, Math.max(5, Number(query.n) || 50));
    const applyTenure = query.tenure === '1';

    if (!run) return { ran: false, limit, applyTenure };

    const guild = client.guilds.cache.get(guildId);
    const settings = await getSettings(guildId);
    const report = await backtestGuild(guild, settings, { limit, applyTenure });
    return { ran: true, limit, applyTenure, report, now: Date.now() };
}

function renderLanding(model) {
    return card({
        title: 'Backtest the suspicion settings',
        body: html`
            ${model.notice ? html`<p class="form-error">${model.notice}</p>` : ''}
            <p>Scores <strong>every current member</strong> with the live weights and thresholds,
            exactly as the join path would, and reports who would be flagged today. Nothing is
            actioned; this is a simulation with a report at the end.</p>
            <p class="hint">It fetches the full member list, so it takes a few seconds. Tenure
            forgiveness is reported both ways regardless of the toggle: applied, it shows what live
            scoring does; ignored, it shows what a fresh join with this profile would score, which
            is the honest tuning view.</p>
            <form method="get" class="search-bar">
                <input type="hidden" name="run" value="1">
                <label for="bt_n" class="compact-label">Show top</label>
                <input type="number" id="bt_n" name="n" value="${model.limit}" min="5" max="${MAX_LIMIT}" class="num-small">
                <label class="toggle compact-label"><input type="checkbox" name="tenure" value="1" ${model.applyTenure ? raw('checked') : ''}><span class="track"></span>apply tenure forgiveness</label>
                <button type="submit">Run the backtest</button>
            </form>`,
        footer: html`<a href="/gate?s=suspicion">The settings it will use</a> are live and current.`,
    });
}

function renderReport(model) {
    const r = model.report;
    if (r.skipped) {
        return card({ title: 'Backtest failed', body: html`<p class="form-error">${r.skipped}</p>` });
    }

    const summary = html`<div class="stats">
        ${raw(statHtml('Scanned', r.scanned, ''))}
        ${raw(statHtml('Clear', r.distribution.clear ?? 0, 'ok'))}
        ${raw(statHtml('Watch', r.distribution.watch ?? 0, 'warn'))}
        ${raw(statHtml('Suspect', r.distribution.suspect ?? 0, 'warn'))}
        ${raw(statHtml('Malicious', r.distribution.malicious ?? 0, 'danger'))}
    </div>`;

    const tenureNote = r.appliedTenure
        ? `Tenure forgiveness applied, as live scoring would. ${fmtNumber(r.stillFlaggedWithTenure)} member(s) stay flagged even so.`
        : `Scored as fresh joins. With tenure forgiveness applied, ${fmtNumber(r.stillFlaggedWithTenure)} of these would still be flagged.`;

    const flaggedCard = card({
        title: 'Flagged members',
        hint: `showing ${r.flagged.length} of ${fmtNumber(r.totalFlagged)}, worst first`,
        body: html`
            <p class="hint">${tenureNote}
            ${r.activityTracked ? '' : ' Activity counting has not started; participation could not soften anything.'}</p>
            ${table({
        columns: [
            {
                key: 'tag', label: 'Member',
                render: f => html`<a href="/members/${f.id}">${f.tag}</a><span class="sub mono">${f.id}</span>`,
            },
            { key: 'tier', label: 'Tier', render: f => pill(TIER_STATE[f.tier] ?? 'off', f.tier) },
            { key: 'score', label: 'Score', numeric: true, render: f => html`<span class="mono">${f.score}</span>` },
            { key: 'tenureScore', label: 'With tenure', numeric: true, render: f => html`<span class="mono">${f.tenureScore}</span>` },
            { key: 'reason', label: 'Why', render: f => html`${f.forcedByDiscord ? raw('🚩 ') : ''}${f.reason}` },
        ],
        rows: r.flagged,
        empty: 'Nobody flagged. Either the server is clean or the thresholds are asleep.',
    })}`,
    });

    const cohortCards = r.cohorts.slice(0, 10).map((cohort, index) => card({
        title: `Batch ${index + 1}: ${cohort.size} accounts, ${describeShape(cohort.shape)}`,
        hint: cohort.basis === 'creation'
            ? `registered within ${fmtSpan(cohort.creationSpanMs)} of each other`
            : `joined within ${fmtSpan(cohort.joinSpanMs)} of each other`,
        body: html`
            <p class="hint">${fmtNumber(cohort.defaultAvatars)} of ${cohort.size} with default avatars;
            ${fmtNumber(cohort.silent)} have never sent a tracked message.</p>
            ${table({
        columns: [
            {
                key: 'username', label: 'Username',
                render: m => html`<a href="/members/${m.id}">${m.username}</a>${m.defaultAvatar ? raw(' <span class="hint">(no avatar)</span>') : ''}`,
            },
            { key: 'created', label: 'Created', numeric: true, render: m => html`<span title="${fmtDateTime(m.createdTimestamp)}">${fmtAgo(m.createdTimestamp, model.now)}</span>` },
            { key: 'joined', label: 'Joined', numeric: true, render: m => html`<span title="${fmtDateTime(m.joinedTimestamp)}">${fmtAgo(m.joinedTimestamp, model.now)}</span>` },
            { key: 'messages', label: 'Messages', numeric: true, render: m => fmtNumber(m.messages ?? 0) },
        ],
        rows: cohort.members,
    })}
            <details class="reference">
                <summary>Ban commands, ready to paste into Dyno</summary>
                <pre class="mono">${cohort.members.map(m => `?ban ${m.id} Suspected Bot`).join('\n')}</pre>
                <p class="hint">Pasted by you so the bans land in your ?modstats, not the bot's.</p>
            </details>`,
    }));

    return html`
        ${summary}
        ${flaggedCard}
        ${r.cohorts.length
            ? html`<h2 class="section-title">Batches in the roster</h2>${cohortCards}`
            : card({ title: 'Batches', body: html`<p class="empty">No structural batches found in the roster.</p>` })}
        <p><a class="btn" href="/gate/backtest">Run again with different knobs</a></p>`;
}

/** Stat tile without importing statTile's number coercion for the label case. */
function statHtml(label, value, tone) {
    const cls = tone ? ` stat-${tone}` : '';
    return `<div class="stat${cls}"><div class="stat-value">${fmtNumber(value)}</div><div class="stat-label">${label}</div></div>`;
}

function render(model) {
    return model.ran ? renderReport(model) : renderLanding(model);
}

module.exports = { data, render, fmtSpan, MAX_LIMIT };
