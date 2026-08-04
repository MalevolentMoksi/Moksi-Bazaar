// src/web/pages/members.js
/**
 * The member activity browser: who talks, who lurks, who has never said a
 * word. Rows come from member_activity; names come from the live guild cache,
 * because the database deliberately stores no usernames it does not need.
 */

const { memberActivity } = require('../queries');
const { html, card, table, fmtNumber, fmtAgo, fmtDateTime, avatarUrl } = require('../html');

const PER_PAGE = 50;
const DISCORD_EPOCH = 1420070400000n;
const SORTS = [
    ['last', 'recently active'],
    ['most', 'most messages'],
    ['least', 'fewest messages'],
    ['first', 'earliest tracked'],
];

function createdMsOf(userId) {
    try { return Number((BigInt(userId) >> 22n) + DISCORD_EPOCH); } catch { return 0; }
}

async function data(client, guildId, query = {}) {
    const guild = client.guilds.cache.get(guildId);
    const q = String(query.q ?? '').trim() || null;
    const sort = SORTS.some(([key]) => key === query.sort) ? query.sort : 'last';
    const page = Math.max(1, Number(query.p) || 1);

    let userId = null;
    let userIds = null;
    let nameMatchCapped = false;
    if (q) {
        if (/^\d{17,20}$/.test(q)) {
            userId = q;
        } else if (guild) {
            const needle = q.toLowerCase();
            const matched = [];
            for (const member of guild.members.cache.values()) {
                if (member.user.username?.toLowerCase().includes(needle)
                    || member.user.globalName?.toLowerCase().includes(needle)
                    || member.nickname?.toLowerCase().includes(needle)) {
                    matched.push(member.id);
                    if (matched.length >= 500) { nameMatchCapped = true; break; }
                }
            }
            userIds = matched;
        }
    }

    const result = await memberActivity(guildId, {
        limit: PER_PAGE, offset: (page - 1) * PER_PAGE, sort, userId, userIds,
    });

    const rows = result.rows.map(row => {
        const member = guild?.members.cache.get(row.user_id) ?? null;
        return {
            ...row,
            name: member ? (member.user.globalName ?? member.user.username) : null,
            username: member?.user.username ?? null,
            avatar: member ? avatarUrl(row.user_id, member.user.avatar, 64) : avatarUrl(row.user_id, null, 64),
            present: Boolean(member),
            createdMs: createdMsOf(row.user_id),
        };
    });

    return {
        q, sort, page, rows, total: result.total, nameMatchCapped,
        trackedCount: result.total, now: Date.now(),
    };
}

function sortLink(model, sort) {
    const params = new URLSearchParams();
    if (model.q) params.set('q', model.q);
    if (sort !== 'last') params.set('sort', sort);
    const qs = params.toString();
    return '/members' + (qs ? `?${qs}` : '');
}

function render(model) {
    const searchBar = html`<form method="get" class="search-bar">
        <input type="text" name="q" value="${model.q ?? ''}" placeholder="Search a name, nickname, or paste an ID">
        ${model.sort !== 'last' ? html`<input type="hidden" name="sort" value="${model.sort}">` : ''}
        <button type="submit" class="ghost">Search</button>
        ${model.q ? html`<a class="chip" href="${sortLink({ ...model, q: null }, model.sort)}">clear</a>` : ''}
    </form>`;

    const sortChips = html`<div class="chips">
        ${SORTS.map(([key, label]) => html`<a class="chip ${model.sort === key ? 'chip-active' : ''}"
            href="${sortLink(model, key)}">${label}</a>`)}
    </div>`;

    const pages = Math.max(1, Math.ceil(model.total / PER_PAGE));
    const pageParams = (p) => {
        const params = new URLSearchParams();
        if (model.q) params.set('q', model.q);
        if (model.sort !== 'last') params.set('sort', model.sort);
        if (p > 1) params.set('p', String(p));
        const qs = params.toString();
        return '/members' + (qs ? `?${qs}` : '');
    };

    const list = card({
        title: 'Tracked members',
        hint: model.total
            ? `${fmtNumber(model.total)} matching; counting started when activity tracking shipped`
            : 'message counting fills this in as people talk',
        body: html`
            ${model.nameMatchCapped ? html`<p class="notice">That name matches a lot of people; showing the first 500. Narrow the search or paste an ID.</p>` : ''}
            ${table({
        columns: [
            {
                key: 'member', label: 'Member',
                render: r => html`<span class="member-cell"><img src="${r.avatar}" alt="" width="24" height="24">
                    <a href="/members/${r.user_id}">${r.name ?? r.user_id}</a>
                    ${r.present ? '' : html`<span class="hint">(left)</span>`}</span>
                    <span class="sub mono">${r.user_id}</span>`,
            },
            { key: 'message_count', label: 'Messages', numeric: true, render: r => fmtNumber(r.message_count) },
            {
                key: 'last_message_ms', label: 'Last spoke', numeric: true,
                render: r => html`<span title="${fmtDateTime(r.last_message_ms)}">${fmtAgo(r.last_message_ms, model.now)}</span>`,
            },
            {
                key: 'first_message_ms', label: 'First tracked', numeric: true,
                render: r => html`<span title="${fmtDateTime(r.first_message_ms)}">${fmtAgo(r.first_message_ms, model.now)}</span>`,
            },
            {
                key: 'createdMs', label: 'Account age', numeric: true,
                render: r => fmtAgo(r.createdMs, model.now).replace(' ago', ''),
            },
        ],
        rows: model.rows,
        empty: model.q
            ? 'Nobody matches. A member with zero tracked messages has no row yet; paste their ID to open them directly.'
            : 'No activity tracked yet.',
    })}
            ${pages > 1 ? html`<div class="pager">
                ${model.page > 1 ? html`<a href="${pageParams(model.page - 1)}">&larr; back</a>` : ''}
                <span class="hint">page ${model.page} of ${fmtNumber(pages)}</span>
                ${model.page < pages ? html`<a href="${pageParams(model.page + 1)}">more &rarr;</a>` : ''}
            </div>` : ''}`,
        footer: html`Anyone can be opened directly at /members/&lt;id&gt;, tracked or not.`,
    });

    return html`${searchBar}${sortChips}${list}`;
}

module.exports = { data, render, PER_PAGE, createdMsOf };
