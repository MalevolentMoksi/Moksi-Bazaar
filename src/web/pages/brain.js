// src/web/pages/brain.js
/**
 * The conversation system's flight recorder, readable.
 *
 * The list shows recent replies with quick good/bad verdicts; the detail page
 * shows one reply's whole pipeline (room read, drafts, judge, vision calls,
 * sentiment) with the full inputs behind <details>, plus the verdict form.
 * Ratings ride in the telemetry export, so the analyst starts from the
 * owner's judgment instead of guessing which replies were bad.
 */

const { html, raw, card, table, pill, statTile, fmtAgo, fmtNumber } = require('../html');
const telemetry = require('../../utils/telemetry');

function money(value) {
    const n = Number(value) || 0;
    return `$${n.toFixed(4)}`;
}

function verdictState(t) {
    if (Number(t.rating) === 1) return pill('on', 'good');
    if (Number(t.rating) === -1) return pill('danger', 'bad');
    return pill('off', 'unrated');
}

// ── List ────────────────────────────────────────────────────────────────────

async function data(client, guildId) {
    const [traces, stats] = await Promise.all([
        telemetry.reviewData({ limit: 50 }),
        telemetry.reviewStats(),
    ]);
    return { guildId, traces, stats };
}

function render(model) {
    const { guildId, traces, stats } = model;

    const statsRow = html`<div class="stat-row">
        ${statTile({ label: 'replies, 24h', value: stats.dayReplies })}
        ${statTile({ label: 'avg reply ms', value: stats.avgMs })}
        <div class="stat"><div class="stat-value">${money(stats.dayCostUsd)}</div><div class="stat-label">spend, 24h</div></div>
        ${statTile({ label: 'rated', value: stats.rated })}
    </div>`;

    const list = table({
        columns: [
            { key: 'when', label: 'When', render: r => fmtAgo(Number(r.started_at_ms)) },
            { key: 'trigger', label: 'Trigger', render: r => r.trigger ?? '?' },
            {
                key: 'reply_text', label: 'Reply',
                render: r => html`<a href="/brain/${r.trace_id}">${String(r.reply_text ?? '(no reply recorded)').slice(0, 110)}</a>`,
            },
            { key: 'total_ms', label: 'ms', numeric: true, render: r => fmtNumber(r.total_ms) },
            { key: 'cost_usd', label: 'cost', numeric: true, render: r => money(r.cost_usd) },
            {
                key: 'rating', label: 'Verdict',
                render: r => html`${verdictState(r)}
                    <button class="ghost" data-action="/api/guild/${guildId}/telemetry/rate?trace=${r.trace_id}&rating=1" data-reload>✓</button>
                    <button class="ghost" data-action="/api/guild/${guildId}/telemetry/rate?trace=${r.trace_id}&rating=-1" data-reload>✗</button>`,
            },
        ],
        rows: traces,
        empty: 'No traces yet. Talk to the bot, then refresh.',
    });

    return html`${statsRow}
    ${card({
        title: 'Recent replies',
        hint: 'click a reply for its whole pipeline; verdicts ride in the export',
        body: list,
        footer: html`Export:
            <a href="/brain/export/traces.csv?days=2">traces.csv</a> ·
            <a href="/brain/export/calls.csv?days=2">calls.csv</a> ·
            <a href="/brain/export/inputs.csv?days=2">inputs.csv</a>
            <span class="hint">(last 48h; drop ?days for everything retained)</span>`,
    })}`;
}

// ── Detail ──────────────────────────────────────────────────────────────────

async function detailData(traceId, guildId) {
    const detail = await telemetry.traceDetail(traceId);
    return { guildId, detail };
}

function renderDetail(model) {
    const { detail } = model;
    if (!detail) {
        return card({ title: 'No such trace', body: html`<p class="empty">Pruned, or never existed. <a href="/brain">Back to the list.</a></p>` });
    }
    const { trace, calls, inputs } = detail;
    const startedAt = Number(trace.started_at_ms);
    const drafts = calls.filter(c => c.kind === 'draft');
    const judge = calls.find(c => c.kind === 'judge');
    const judgePickText = judge?.output_text ? String(judge.output_text).match(/\d+/)?.[0] ?? null : null;

    const header = card({
        title: 'The reply',
        hint: `${trace.trigger ?? '?'} · ${fmtAgo(startedAt)} · v${trace.version ?? '?'} · ${fmtNumber(trace.total_ms)} ms · ${trace.outcome ?? 'ok'}`,
        body: html`<blockquote class="reply-quote">${trace.reply_text ?? '(no reply recorded)'}</blockquote>
            ${trace.flags ? html`<details><summary>Pipeline flags</summary><pre>${JSON.stringify(trace.flags, null, 2)}</pre></details>` : ''}`,
    });

    const verdictForm = card({
        title: 'Your verdict',
        hint: 'saved onto the trace; rated traces are never pruned',
        body: html`<form data-api="telemetry/verdict" data-reload class="verdict-form">
            <input type="hidden" name="trace" value="${trace.trace_id}">
            <label><input type="radio" name="rating" value="1" ${Number(trace.rating) === 1 ? raw('checked') : ''}> good</label>
            <label><input type="radio" name="rating" value="-1" ${Number(trace.rating) === -1 ? raw('checked') : ''}> bad</label>
            <label><input type="radio" name="rating" value="" ${trace.rating == null ? raw('checked') : ''}> unrated</label>
            <label><input type="checkbox" name="wrongpick" value="1" ${trace.judge_wrong_pick ? raw('checked') : ''}> the judge picked the wrong draft</label>
            <input name="comment" maxlength="1000" placeholder="optional: what was wrong (or right) with it" value="${trace.rating_comment ?? ''}">
            <button type="submit">Save verdict</button>
        </form>`,
    });

    const draftCards = drafts.length ? card({
        title: `Drafts (${drafts.length})`,
        hint: judgePickText ? `judge picked #${judgePickText}` : 'no judge verdict recorded',
        body: html`${drafts.map((d, i) => {
            const index = d.extra?.index ?? i + 1;
            const won = judgePickText != null && String(index) === judgePickText;
            return html`<div class="draft ${won ? 'draft-won' : ''}">
                <div class="draft-head">#${index} · ${d.model ?? '?'} · ${fmtNumber(d.latency_ms)} ms · ${money(d.cost_usd)} ${won ? pill('on', 'picked') : ''}</div>
                <blockquote>${d.output_text ?? '(nothing came back)'}</blockquote>
            </div>`;
        })}`,
    }) : '';

    const callsTable = card({
        title: 'Every call in this trace',
        body: table({
            columns: [
                { key: 'at_ms', label: 't+', numeric: true, render: r => `${fmtNumber(Number(r.at_ms) - startedAt)} ms` },
                { key: 'kind', label: 'Kind' },
                { key: 'model', label: 'Model', render: r => r.model ?? '' },
                { key: 'latency_ms', label: 'ms', numeric: true, render: r => fmtNumber(r.latency_ms) },
                { key: 'tokens', label: 'in/out', numeric: true, render: r => `${r.tokens_in ?? ''}${r.tokens_in != null || r.tokens_out != null ? '/' : ''}${r.tokens_out ?? ''}` },
                { key: 'cost_usd', label: 'cost', numeric: true, render: r => (r.cost_usd != null ? money(r.cost_usd) : '') },
                {
                    key: 'outcome', label: 'Outcome',
                    render: r => (r.outcome === 'ok' ? pill('on', 'ok') : pill('danger', r.outcome)),
                },
                { key: 'output_text', label: 'Output', render: r => String(r.output_text ?? r.error ?? '').slice(0, 80) },
            ],
            rows: calls,
            empty: 'No calls recorded on this trace.',
        }),
    });

    const inputBlocks = card({
        title: `Inputs (${inputs.length} distinct)`,
        hint: 'stored once per trace; call rows reference them by hash',
        body: inputs.length
            ? html`${inputs.map(inp => html`<details>
                <summary><code>${inp.input_hash}</code> · ${fmtNumber(inp.input_text.length)} chars</summary>
                <pre class="input-text">${inp.input_text}</pre>
            </details>`)}`
            : html`<p class="empty">No inputs recorded.</p>`,
    });

    return html`<p><a href="/brain">← all replies</a></p>
        ${header}${verdictForm}${draftCards}${callsTable}${inputBlocks}
        ${raw('<style>.reply-quote{white-space:pre-wrap}.draft{margin:0 0 12px}.draft-head{opacity:.75;font-size:.85em;margin-bottom:4px}.draft-won blockquote{border-left:3px solid var(--ok,#4a4)}.verdict-form{display:flex;flex-wrap:wrap;gap:10px;align-items:center}.verdict-form input[name=comment]{flex:1 1 260px}.input-text{white-space:pre-wrap;max-height:420px;overflow:auto}</style>')}`;
}

module.exports = { data, render, detailData, renderDetail };
