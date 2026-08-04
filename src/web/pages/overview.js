// src/web/pages/overview.js
/**
 * The morning glance: is the gate up, what has it done lately, is anything
 * armed that should not be, did anyone get moderated overnight.
 *
 * data() gathers, render() draws. render() never touches the database or the
 * client, which is what lets the tests hand it fixtures.
 */

const { getSettings } = require('../../utils/joinGate/config');
const { watchedCount } = require('../../utils/joinGate/watch');
const { getModActionSummary } = require('../../utils/db');
const { recentModActions, pendingUnbans } = require('../queries');
const { html, card, statTile, pill, table, fmtNumber, fmtAgo, fmtDateTime, raw } = require('../html');

async function data(client, guildId) {
    const guild = client.guilds.cache.get(guildId);
    const settings = await getSettings(guildId);
    const [modSummary, recent, unbans] = await Promise.all([
        getModActionSummary(guildId).catch(() => null),
        recentModActions(guildId, { limit: 8 }).catch(() => ({ rows: [] })),
        pendingUnbans(guildId, { limit: 5 }).catch(() => []),
    ]);

    return {
        guildName: guild?.name ?? 'Unknown server',
        memberCount: guild?.memberCount ?? 0,
        uptimeMs: client.uptime ?? 0,
        settings,
        watching: watchedCount(guildId),
        modSummary,
        recentActions: recent.rows,
        unbans,
        commandCount: client.commands?.size ?? 0,
        commandFailures: client.commandLoadFailures ?? [],
        now: Date.now(),
    };
}

/** 'log' is a pill that says so; a real action says what it does. */
function actionPill(action) {
    if (!action || action === 'log' || action === 'none') return pill('off', action === 'none' ? 'off' : 'log only');
    return pill(action === 'ban' ? 'danger' : 'warn', action);
}

function render(model) {
    const s = model.settings;

    const armed = card({
        title: 'What is armed',
        hint: 'every automatic action, in one glance',
        body: html`<dl class="kv">
            <dt>Age gate</dt><dd>${s.enabled ? pill('on', 'on') : pill('off', 'off')} ${s.dry_run ? pill('warn', 'dry run') : ''}</dd>
            <dt>Suspicion tiers</dt><dd>${s.suspicion_enabled
                ? html`${actionPill(s.suspicion_watch_action)} ${actionPill(s.suspicion_suspect_action)} ${actionPill(s.suspicion_malicious_action)}`
                : pill('off', 'off')}</dd>
            <dt>Behaviour watch</dt><dd>${s.watch_enabled
                ? html`${actionPill(s.watch_action)} <span class="hint">${s.watch_window_minutes} min window, acts at ${s.watch_action_at}</span>`
                : pill('off', 'off')}</dd>
            <dt>Audit-log guard</dt><dd>${s.guard_enabled ? pill('on', 'watching') : pill('off', 'off')}</dd>
            <dt>Weekly snapshot</dt><dd>${s.snapshot_enabled ? pill('on', 'on') : pill('off', 'off')}
                ${s.snapshot_enabled && !s.snapshot_dm_owner ? pill('warn', 'no DM copy') : ''}</dd>
            <dt>Watched right now</dt><dd><span class="mono">${fmtNumber(model.watching)}</span> recent joiner(s) in the window</dd>
        </dl>`,
        footer: html`Change any of these under <a href="/gate">Join Gate</a>.`,
    });

    const recentTable = card({
        title: 'Recent moderation',
        hint: model.modSummary?.total
            ? `${fmtNumber(model.modSummary.total)} actions on record`
            : 'recorded from the audit log, kept forever',
        body: table({
            columns: [
                { key: 'action', label: 'Action', render: r => actionPill(r.action) },
                { key: 'target', label: 'Member', render: r => html`${r.target_tag ?? 'unknown'}<span class="sub mono">${r.target_id}</span>` },
                { key: 'actor', label: 'By', render: r => html`${r.actor_tag ?? 'unknown'}${r.actor_is_bot ? raw(' <span class="hint">(bot)</span>') : ''}` },
                { key: 'reason', label: 'Reason', render: r => r.reason ?? '' },
                { key: 'at', label: 'When', numeric: true, render: r => html`<span title="${fmtDateTime(r.at_ms)}">${fmtAgo(r.at_ms, model.now)}</span>` },
            ],
            rows: model.recentActions,
            empty: 'No moderation actions recorded yet. They accumulate as they happen.',
        }),
        footer: html`Full history under <a href="/modlog">Mod History</a>.`,
    });

    const unbanRows = model.unbans.length ? card({
        title: 'Bans lifting soon',
        hint: 'temporary bans the bot promised to undo',
        body: table({
            columns: [
                { key: 'user_id', label: 'User', render: r => html`<span class="mono">${r.user_id}</span>` },
                { key: 'kind', label: 'Kind', render: r => r.kind === 'age' ? 'until account matures' : 'timed cooldown' },
                { key: 'unban_at_ms', label: 'Lifts', numeric: true, render: r => html`<span title="${fmtDateTime(r.unban_at_ms)}">${fmtAgo(r.unban_at_ms, model.now)}</span>` },
            ],
            rows: model.unbans,
        }),
    }) : '';

    // Only ever shown when something is actually wrong: a slash command that
    // spins forever looks like a hung bot, and this is where that gets a name.
    const failures = model.commandFailures ?? [];
    const commandTrouble = failures.length ? card({
        title: 'Commands that failed to load',
        hint: `${fmtNumber(model.commandCount ?? 0)} command(s) answered for; these files did not`,
        body: html`<ul class="plain-list">
            ${failures.map(f => html`<li><span class="mono">${f.file}</span>: ${f.error}</li>`)}
        </ul>
        <p class="hint">Discord still offers whatever was registered last, so those commands appear in the
        picker and then answer with a fault notice. Fixing the file and redeploying is the whole cure.</p>`,
    }) : '';

    return html`
        ${commandTrouble}
        ${failures.length ? html`<div class="spacer"></div>` : ''}
        <div class="stats">
            ${statTile({ label: 'Members', value: model.memberCount })}
            ${statTile({ label: 'Gate kicks', value: s.total_kicks, tone: s.total_kicks > 0 ? 'warn' : '' })}
            ${statTile({ label: 'Gate bans', value: s.total_bans, tone: s.total_bans > 0 ? 'danger' : '' })}
            ${statTile({ label: 'Flagged', value: s.total_flagged })}
            ${statTile({ label: 'DM failures', value: s.total_failures })}
        </div>
        <div class="row-cards">
            ${armed}
            ${unbanRows}
        </div>
        <div class="spacer"></div>
        ${recentTable}
        <p class="hint">Bot up ${Math.floor(model.uptimeMs / 3_600_000)}h ${Math.floor((model.uptimeMs % 3_600_000) / 60_000)}m.</p>
    `;
}

module.exports = { data, render };
