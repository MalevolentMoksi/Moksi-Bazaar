// src/web/pages/modlog.js
/**
 * The durable moderation record, browsable.
 *
 * Discord keeps its audit log 45 days and Dyno keeps its copy on Dyno's
 * servers; mod_actions is the copy that is yours. This page is why it exists:
 * filter by action, search a name or an ID or a reason, and page through
 * years of history that an embed could only ever show fifteen rows of.
 */

const { recentModActions, modActionBreakdown, recentWarns } = require('../queries');
const { html, raw, card, pill, table, fmtNumber, fmtAgo, fmtDateTime } = require('../html');

const PER_PAGE = 25;

const ACTION_STATE = {
    ban: 'danger', kick: 'warn', timeout: 'warn',
    unban: 'on', timeout_cleared: 'on',
};

async function data(client, guildId, query = {}) {
    const q = String(query.q ?? '').trim() || null;
    const action = String(query.a ?? '').trim() || null;
    const page = Math.max(1, Number(query.p) || 1);
    const warnPage = Math.max(1, Number(query.wp) || 1);

    const [actions, breakdown, warns] = await Promise.all([
        recentModActions(guildId, {
            limit: PER_PAGE, offset: (page - 1) * PER_PAGE, action, search: q,
        }),
        modActionBreakdown(guildId),
        recentWarns(guildId, {
            limit: PER_PAGE, offset: (warnPage - 1) * PER_PAGE, search: q,
        }),
    ]);

    return { q, action, page, warnPage, actions, breakdown, warns, now: Date.now() };
}

function actionPill(action) {
    return pill(ACTION_STATE[action] ?? 'off', action);
}

/** ?q=&a=&p= links that keep the other filters as they are. */
function link(model, patch) {
    const params = new URLSearchParams();
    const next = { q: model.q, a: model.action, p: null, wp: null, ...patch };
    if (next.q) params.set('q', next.q);
    if (next.a) params.set('a', next.a);
    if (next.p && next.p > 1) params.set('p', String(next.p));
    if (next.wp && next.wp > 1) params.set('wp', String(next.wp));
    const qs = params.toString();
    return '/modlog' + (qs ? `?${qs}` : '');
}

function pager(model, key, total, current) {
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));
    if (pages === 1) return '';
    return html`<div class="pager">
        ${current > 1 ? html`<a href="${link(model, { [key]: current - 1, ...(key === 'p' ? {} : { p: model.page }) })}">&larr; newer</a>` : ''}
        <span class="hint">page ${current} of ${fmtNumber(pages)}</span>
        ${current < pages ? html`<a href="${link(model, { [key]: current + 1, ...(key === 'p' ? {} : { p: model.page }) })}">older &rarr;</a>` : ''}
    </div>`;
}

function render(model) {
    const chips = html`<div class="chips">
        <a class="chip ${model.action ? '' : 'chip-active'}" href="${link(model, { a: null })}">all</a>
        ${model.breakdown.map(b => html`<a class="chip ${model.action === b.action ? 'chip-active' : ''}"
            href="${link(model, { a: b.action })}">${b.action} <span class="mono">${fmtNumber(b.count)}</span></a>`)}
    </div>`;

    const searchBar = html`<form method="get" class="search-bar">
        <input type="text" name="q" value="${model.q ?? ''}" placeholder="Search a name, an ID, or a reason">
        ${model.action ? html`<input type="hidden" name="a" value="${model.action}">` : ''}
        <button type="submit" class="ghost">Search</button>
        ${model.q ? html`<a class="chip" href="${link(model, { q: null })}">clear</a>` : ''}
    </form>`;

    const actionsCard = card({
        title: 'Moderation actions',
        hint: model.actions.total
            ? `${fmtNumber(model.actions.total)} matching, newest first`
            : 'recorded from the audit log as they happen',
        body: html`
            ${table({
        columns: [
            { key: 'action', label: 'Action', render: r => actionPill(r.action) },
            {
                key: 'target', label: 'Member',
                render: r => html`<a href="/members/${r.target_id}">${r.target_tag ?? r.target_id}</a><span class="sub mono">${r.target_id}</span>`,
            },
            {
                key: 'actor', label: 'By',
                render: r => html`${r.actor_tag ?? 'unknown'}${r.actor_is_bot ? raw(' <span class="hint">(bot)</span>') : ''}`,
            },
            { key: 'reason', label: 'Reason', render: r => r.reason ?? '' },
            {
                key: 'at', label: 'When', numeric: true,
                render: r => html`<span title="${fmtDateTime(r.at_ms)}">${fmtAgo(r.at_ms, model.now)}</span>`,
            },
        ],
        rows: model.actions.rows,
        empty: model.q || model.action
            ? 'Nothing matches those filters.'
            : 'No actions recorded yet. History accumulates from here.',
    })}
            ${pager(model, 'p', model.actions.total, model.page)}`,
    });

    const warnsCard = card({
        title: 'Warns',
        // Provenance stated where the data is read: the actions table above
        // comes from the audit log (fact), this one is scraped from Dyno's
        // confirmation embeds (best effort), and the two should not be read
        // with the same confidence.
        hint: model.warns.total
            ? `${fmtNumber(model.warns.total)} matching, mirrored from Dyno's confirmations`
            : 'mirrored from Dyno\'s confirmations and kept',
        body: html`
            ${table({
        columns: [
            {
                key: 'user', label: 'Member',
                render: r => r.user_id
                    ? html`<a href="/members/${r.user_id}">${r.user_label}</a><span class="sub mono">${r.user_id}</span>`
                    : html`${r.user_label}<span class="sub">unlinked</span>`,
            },
            { key: 'moderator', label: 'By', render: r => r.moderator ?? 'unknown' },
            { key: 'reason', label: 'Reason', render: r => r.reason ?? '' },
            { key: 'case_id', label: 'Case', render: r => r.case_id ? html`<span class="mono">${r.case_id}</span>` : '' },
            {
                key: 'state', label: 'State',
                render: r => r.removed_at_ms
                    ? html`${pill('off', 'removed')}<span class="sub" title="${fmtDateTime(Number(r.removed_at_ms))}">${r.removed_by ? `by ${r.removed_by}` : ''}</span>`
                    : pill('on', 'standing'),
            },
            {
                key: 'at', label: 'When', numeric: true,
                render: r => html`<span title="${fmtDateTime(r.created_at_ms)}">${fmtAgo(r.created_at_ms, model.now)}</span>`,
            },
        ],
        rows: model.warns.rows,
        empty: model.q ? 'No warns match.' : 'No warns on record.',
    })}
            ${pager(model, 'wp', model.warns.total, model.warnPage)}`,
    });

    return html`${searchBar}${chips}${actionsCard}${warnsCard}`;
}

module.exports = { data, render, PER_PAGE };
