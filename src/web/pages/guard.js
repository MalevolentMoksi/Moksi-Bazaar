// src/web/pages/guard.js
/**
 * The anti-nuke pieces on one page: what the guard is armed to notice, the
 * snapshot that survives a nuke, and a live view of the audit log so "what
 * has been happening structurally" does not require opening Discord's own
 * clunky audit UI.
 *
 * Everything here is watch-only, like the guard itself. The one button that
 * DOES something builds a snapshot, which writes nothing to the server.
 */

const { AuditLogEvent } = require('discord.js');
const { getSettings } = require('../../utils/joinGate/config');
const { WATCHED } = require('../../utils/joinGate/guard');
const { resolveChannel } = require('../../utils/joinGate/snapshot');
const { html, raw, card, pill, table, fmtNumber, fmtAgo, fmtDateTime } = require('../html');

/** discord.js enums have no reverse index; build one once. */
const EVENT_NAME = Object.fromEntries(
    Object.entries(AuditLogEvent).filter(([, v]) => typeof v === 'number').map(([k, v]) => [v, k]));

async function data(client, guildId) {
    const guild = client.guilds.cache.get(guildId);
    const settings = await getSettings(guildId);

    let auditEntries = [];
    let auditError = null;
    try {
        const logs = await guild.fetchAuditLogs({ limit: 20 });
        auditEntries = [...logs.entries.values()].map(entry => ({
            noun: WATCHED[entry.action]?.noun ?? null,
            name: EVENT_NAME[entry.action] ?? `event ${entry.action}`,
            watched: Boolean(WATCHED[entry.action]),
            executorTag: entry.executor?.username ?? null,
            executorId: entry.executorId ?? null,
            targetId: entry.targetId ?? null,
            reason: entry.reason ?? null,
            at: entry.createdTimestamp,
        }));
    } catch (error) {
        auditError = error.message;
    }

    const channelName = id => guild?.channels.cache.get(id)?.name ?? null;
    const snapshotChannelId = resolveChannel(settings);

    return {
        settings,
        guildId,
        guardChannelName: channelName(settings.guard_channel_id),
        snapshotChannelName: channelName(snapshotChannelId),
        snapshotHasDm: Boolean(settings.snapshot_dm_owner),
        auditEntries,
        auditError,
        watchedNouns: [...new Set(Object.values(WATCHED).map(w => w.noun))],
        now: Date.now(),
    };
}

function render(model) {
    const s = model.settings;

    const guardCard = card({
        title: 'The guard',
        hint: 'watch-only; it notices, it never intercepts',
        body: html`<dl class="kv">
            <dt>Status</dt><dd>${s.guard_enabled ? pill('on', 'watching') : pill('off', 'off')}</dd>
            <dt>Alerts go to</dt><dd>${model.guardChannelName ? html`#${model.guardChannelName}` : html`<span class="hint">no channel set</span>`}
                ${s.guard_dm_owner ? pill('on', '+ DM to you') : ''}</dd>
            <dt>Window</dt><dd class="mono">${s.guard_window_seconds}s</dd>
            <dt>Alert at</dt><dd class="mono">${s.guard_delete_limit} deleted · ${s.guard_create_limit} created · ${s.guard_perm_limit} perm grants · ${s.guard_webhook_limit} webhooks</dd>
            <dt>Identity changes</dt><dd>${s.guard_watch_identity ? pill('on', 'reported alone') : pill('off', 'ignored')}</dd>
            <dt>Bot additions</dt><dd>${s.guard_watch_bots ? pill('on', 'reported alone') : pill('off', 'ignored')}</dd>
            <dt>Exempt</dt><dd>${fmtNumber(s.guard_exempt_user_ids.length)} user(s)</dd>
        </dl>`,
        footer: html`Limits and exemptions are edited under <a href="/gate#guard">Join Gate &rarr; Guard</a>.`,
    });

    const watchesCard = card({
        title: 'What trips it',
        body: html`<ul class="plain-list">
            ${model.watchedNouns.map(noun => html`<li>${noun}</li>`)}
        </ul>
        <p class="hint">Bans, kicks and timeouts are deliberately not on this list. A nuke's damage is structural
        and irreversible; bans are routine and undoable, and watching them is how a bot ends up owning your
        moderation. Dyno at 3am trips nothing here.</p>`,
    });

    const nowhere = !model.snapshotChannelName && !model.snapshotHasDm;
    const snapshotCard = card({
        title: 'Structure snapshot',
        hint: 'channels, roles, overwrites, member roles, emoji, stickers',
        body: html`<dl class="kv">
            <dt>Weekly</dt><dd>${s.snapshot_enabled ? pill('on', 'on') : pill('off', 'off')}</dd>
            <dt>Copies</dt><dd>
                ${model.snapshotChannelName ? html`#${model.snapshotChannelName} ` : ''}
                ${model.snapshotHasDm ? pill('on', 'DM to you') : pill('warn', 'no DM copy')}
            </dd>
        </dl>
        ${nowhere ? html`<p class="form-error">Nowhere to send one. Set a guard channel or turn the DM copy on under <a href="/gate#snapshot">Join Gate &rarr; Snapshot</a>.</p>` : ''}
        ${!nowhere && !model.snapshotHasDm ? html`<p class="form-error">Without the DM copy, the only backup lives inside the server it backs up.</p>` : ''}
        <div class="form-actions">
            <button data-action="/api/guild/${model.guildId}/snapshot" data-busy="Building (fetching every member)..." ${nowhere ? raw('disabled') : ''}>Snapshot now</button>
        </div>`,
        footer: html`Built in memory and sent as a file; nothing is stored on the server running the bot.`,
    });

    const auditCard = card({
        title: 'Audit log, live',
        hint: 'the last 20 entries, straight from Discord',
        body: model.auditError
            ? html`<p class="form-error">Could not read the audit log: ${model.auditError}. The guard needs View Audit Log.</p>`
            : table({
                columns: [
                    {
                        key: 'what', label: 'What',
                        render: r => html`${r.watched ? pill('warn', r.noun) : html`<span class="hint">${r.name}</span>`}`,
                    },
                    {
                        key: 'who', label: 'By',
                        render: r => r.executorTag
                            ? html`${r.executorTag}<span class="sub mono">${r.executorId}</span>`
                            : html`<span class="mono">${r.executorId ?? 'unknown'}</span>`,
                    },
                    { key: 'target', label: 'Target', render: r => r.targetId ? html`<span class="mono">${r.targetId}</span>` : '' },
                    { key: 'reason', label: 'Reason', render: r => r.reason ?? '' },
                    { key: 'at', label: 'When', numeric: true, render: r => html`<span title="${fmtDateTime(r.at)}">${fmtAgo(r.at, model.now)}</span>` },
                ],
                rows: model.auditEntries,
                empty: 'A quiet log. Good.',
            }),
    });

    return html`
        <div class="row-cards">${guardCard}${watchesCard}</div>
        <div class="spacer"></div>
        <div class="row-cards">${snapshotCard}</div>
        <div class="spacer"></div>
        ${auditCard}`;
}

module.exports = { data, render };
