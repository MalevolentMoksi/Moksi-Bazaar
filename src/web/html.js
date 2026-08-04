// src/web/html.js
/**
 * Dashboard rendering: tagged templates with escaping as the default.
 *
 * Every interpolated value is HTML-escaped unless explicitly marked raw().
 * That direction matters: forgetting a raw() shows &lt;b&gt; on a page, which
 * is ugly; forgetting an escape ships XSS to the one browser that holds an
 * owner session. Ugly loses to unsafe every time.
 *
 * Pages are pure functions of data. Routes fetch, pages render, and the tests
 * can feed the renderers fixtures without a database or a Discord client.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' };

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ESCAPES[ch]);
}

/** Wraps a string so html`` interpolates it verbatim. Use sparingly, on purpose. */
function raw(value) {
    return { __raw: String(value ?? '') };
}

/** Tagged template: html`<b>${userText}</b>` escapes userText automatically. */
function html(strings, ...values) {
    let out = '';
    strings.forEach((part, i) => {
        out += part;
        if (i >= values.length) return;
        const value = values[i];
        if (value == null || value === false) return;
        if (Array.isArray(value)) {
            out += value.map(v => (v?.__raw != null ? v.__raw : esc(v))).join('');
        } else if (value.__raw != null) {
            out += value.__raw;
        } else {
            out += esc(value);
        }
    });
    return raw(out);
}

// ── Formatting ──────────────────────────────────────────────────────────────

const NUMBER_FORMAT = new Intl.NumberFormat('en-US');

function fmtNumber(n) {
    return Number.isFinite(Number(n)) ? NUMBER_FORMAT.format(Number(n)) : '0';
}

/** "3 days ago" / "in 2 hours"; falls back to the date for old things. */
function fmtAgo(ms, now = Date.now()) {
    const t = Number(ms);
    if (!Number.isFinite(t) || t <= 0) return 'never';
    const diff = now - t;
    const abs = Math.abs(diff);
    const units = [
        [60_000, 'just now', null],
        [3_600_000, null, 60_000],
        [86_400_000, null, 3_600_000],
        [2_592_000_000, null, 86_400_000],
    ];
    if (abs < units[0][0]) return diff >= 0 ? 'just now' : 'moments away';
    for (const [ceiling, , unit] of units.slice(1)) {
        if (abs < ceiling) {
            const n = Math.floor(abs / unit);
            const name = unit === 60_000 ? 'min' : unit === 3_600_000 ? 'h' : 'd';
            return diff >= 0 ? `${n}${name} ago` : `in ${n}${name}`;
        }
    }
    return new Date(t).toISOString().slice(0, 10);
}

function fmtDateTime(ms) {
    const t = Number(ms);
    if (!Number.isFinite(t) || t <= 0) return 'never';
    return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function avatarUrl(userId, avatarHash, size = 64) {
    if (avatarHash) {
        const ext = String(avatarHash).startsWith('a_') ? 'gif' : 'png';
        return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}?size=${size}`;
    }
    let index = 0;
    try { index = Number((BigInt(userId) >> 22n) % 6n); } catch { /* fine */ }
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

// ── Atoms ───────────────────────────────────────────────────────────────────

/** on/off/warn/danger state, readable at a glance without reading the word. */
function pill(state, label) {
    return html`<span class="pill pill-${state}">${label}</span>`;
}

function card({ title, hint, body, footer }) {
    return html`<section class="stall">
        ${title ? html`<header class="stall-head"><h2>${title}</h2>${hint ? html`<span class="hint">${hint}</span>` : ''}</header>` : ''}
        <div class="stall-body">${body}</div>
        ${footer ? html`<footer class="stall-foot">${footer}</footer>` : ''}
    </section>`;
}

function statTile({ label, value, tone = '' }) {
    return html`<div class="stat ${tone ? `stat-${tone}` : ''}">
        <div class="stat-value">${fmtNumber(value)}</div>
        <div class="stat-label">${label}</div>
    </div>`;
}

/**
 * A data table. `columns` is [{key, label, numeric?, render?}]; render, when
 * given, receives the row and must return html`` or a plain string.
 */
function table({ columns, rows, empty = 'Nothing here yet.' }) {
    if (!rows?.length) return html`<p class="empty">${empty}</p>`;
    return html`<div class="table-scroll"><table>
        <thead><tr>${columns.map(c => html`<th class="${c.numeric ? 'num' : ''}">${c.label}</th>`)}</tr></thead>
        <tbody>${rows.map(row => html`<tr>${columns.map(c => html`<td class="${c.numeric ? 'num' : ''}">${c.render ? c.render(row) : row[c.key]}</td>`)}</tr>`)}</tbody>
    </table></div>`;
}

// ── Layout ──────────────────────────────────────────────────────────────────

const NAV = [
    { href: '/', label: 'Overview', match: p => p === '/' },
    { href: '/gate', label: 'Join Gate', match: p => p.startsWith('/gate') },
    { href: '/modlog', label: 'Mod History', match: p => p.startsWith('/modlog') },
    { href: '/members', label: 'Members', match: p => p.startsWith('/members') },
    { href: '/guard', label: 'Guard', match: p => p.startsWith('/guard') },
];

const LANTERN = raw(
    '<svg class="lantern" viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M12 2v2M8 4h8M9 4c-2 2.5-3 4.5-3 7 0 4 2.5 7 6 7s6-3 6-7c0-2.5-1-4.5-3-7'
    + 'M12 18v2M10 22h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
    + '<circle cx="12" cy="11" r="2.4" fill="currentColor" opacity=".85"/></svg>'
);

/**
 * The page shell. `guilds` is [{id, name, memberCount}] for the picker;
 * `guildId` is the one in view. `owner` comes from the session.
 */
function layout({ title, path = '/', body, owner, csrfToken, guilds = [], guildId = null }) {
    const activeGuild = guilds.find(g => g.id === guildId);
    const content = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="csrf" content="${csrfToken ?? ''}">
<meta name="guild" content="${guildId ?? ''}">
<title>${title} · Moksi's Bazaar</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ctext y='19' font-size='19'%3E%F0%9F%8F%AE%3C/text%3E%3C/svg%3E">
<link rel="stylesheet" href="/assets/bazaar.css">
</head>
<body>
<div class="glow" aria-hidden="true"></div>
<div class="frame">
    <aside class="side">
        <a class="wordmark" href="/">${LANTERN}<span>Moksi's<br>Bazaar</span></a>
        <nav>${NAV.map(item => html`<a href="${item.href}" class="${item.match(path) ? 'active' : ''}">${item.label}</a>`)}</nav>
        <div class="side-foot">
            ${owner ? html`<div class="owner-chip">
                <img src="${avatarUrl(owner.uid, owner.av, 64)}" alt="" width="26" height="26">
                <span>${owner.tag}</span>
            </div>
            <form method="post" action="/logout"><input type="hidden" name="_csrf" value="${csrfToken ?? ''}"><button class="ghost" type="submit">Sign out</button></form>` : ''}
        </div>
    </aside>
    <main class="main">
        <div class="topbar">
            <h1>${title}</h1>
            ${guilds.length ? html`<form method="get" class="guild-pick">
                <select name="g" aria-label="Server">
                    ${guilds.map(g => html`<option value="${g.id}" ${g.id === guildId ? raw('selected') : ''}>${g.name} (${fmtNumber(g.memberCount)})</option>`)}
                </select>
            </form>` : ''}
        </div>
        ${activeGuild ? '' : (guilds.length ? html`<p class="notice">Pick a server above.</p>` : '')}
        ${body}
    </main>
</div>
<div id="toast" role="status" aria-live="polite"></div>
<script src="/assets/bazaar.js"></script>
</body>
</html>`;
    return content.__raw;
}

/** Standalone page (login, rejection, errors): no sidebar, just the lantern. */
function doorPage({ title, body }) {
    const content = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Moksi's Bazaar</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ctext y='19' font-size='19'%3E%F0%9F%8F%AE%3C/text%3E%3C/svg%3E">
<link rel="stylesheet" href="/assets/bazaar.css">
</head>
<body class="door">
<div class="glow" aria-hidden="true"></div>
<div class="door-card">
    <div class="door-lantern">${LANTERN}</div>
    ${body}
</div>
</body>
</html>`;
    return content.__raw;
}

module.exports = {
    esc, raw, html,
    fmtNumber, fmtAgo, fmtDateTime, avatarUrl,
    pill, card, statTile, table,
    layout, doorPage,
    NAV,
};
