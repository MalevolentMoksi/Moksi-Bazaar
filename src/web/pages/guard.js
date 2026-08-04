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
const { getBackupChannelId, LAST_RUN_KEY } = require('../../utils/backup');
const { getSpeakConfigValue } = require('../../utils/db');
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

    // Guard alerts are a per-guild setting, so this guild's cache is right
    // for them. The archive is not: it is one destination for every server,
    // and looking it up here is what made a channel in another server render
    // as "not set" and made the picker able to erase it.
    const localName = id => guild?.channels.cache.get(id)?.name ?? null;
    const describe = (id) => {
        const channel = id ? client.channels.cache.get(id) : null;
        if (!channel) return null;
        return {
            id: channel.id,
            name: channel.name,
            guildName: channel.guild?.name ?? null,
            elsewhere: channel.guild?.id !== guildId,
        };
    };

    const backupChannelId = await getBackupChannelId();
    const archive = describe(backupChannelId);
    // The archive channel wins for both weekly files when one is set.
    const snapshotChannel = describe(backupChannelId || resolveChannel(settings));

    // One global setting deserves one global picker: every server the bot is
    // in, current one first, so the cross-server choice is a choice and not a
    // guess about which page to be on when making it.
    const channelGroups = [...client.guilds.cache.values()]
        .sort((a, b) => {
            if (a.id === guildId) return -1;
            if (b.id === guildId) return 1;
            return a.name.localeCompare(b.name);
        })
        .map(g => ({
            guildName: g.name,
            isCurrent: g.id === guildId,
            channels: [...g.channels.cache.values()]
                .filter(c => c.isTextBased?.() && !c.isThread?.())
                .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
                .map(c => ({ id: c.id, name: c.name })),
        }))
        .filter(g => g.channels.length);

    return {
        settings,
        guildId,
        guildName: guild?.name ?? null,
        guardChannelName: localName(settings.guard_channel_id),
        snapshotChannel,
        // What will actually happen, not what the toggle says in isolation:
        // an archive channel supersedes the DM copy, the same way it does for
        // the database dump.
        snapshotHasDm: Boolean(settings.snapshot_dm_owner) && !archive,
        snapshotDmSetting: Boolean(settings.snapshot_dm_owner),
        archive,
        backupLastMs: Number(await getSpeakConfigValue(LAST_RUN_KEY, 0)) || 0,
        channelGroups,
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
        footer: html`Limits and exemptions are edited under <a href="/gate?s=guard">Join Gate &rarr; Guard</a>.`,
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

    const snap = model.snapshotChannel;
    const nowhere = !snap && !model.snapshotHasDm;
    // Only a snapshot filed inside the very server it describes shares that
    // server's fate; one sitting in another server is already safe.
    const insideItself = Boolean(snap) && !snap.elsewhere;
    const snapshotCard = card({
        title: 'Structure snapshot',
        hint: 'channels, roles, overwrites, member roles, emoji, stickers',
        body: html`<dl class="kv">
            <dt>Weekly</dt><dd>${s.snapshot_enabled ? pill('on', 'on') : pill('off', 'off')}</dd>
            <dt>Copies</dt><dd>
                ${snap ? html`#${snap.name}${snap.elsewhere ? html` <span class="hint">in ${snap.guildName}</span>` : ''} ` : ''}
                ${model.snapshotHasDm ? pill('on', 'DM to you') : ''}
                ${!snap && !model.snapshotHasDm ? pill('warn', 'nowhere') : ''}
            </dd>
        </dl>
        ${nowhere ? html`<p class="form-error">Nowhere to send one. Pick an archive channel beside this, or turn the DM copy on under <a href="/gate?s=snapshot">Join Gate &rarr; Snapshot</a>.</p>` : ''}
        ${insideItself && !model.snapshotHasDm ? html`<p class="form-error">Without the DM copy, the only backup lives inside the server it backs up.</p>` : ''}
        <div class="form-actions">
            <button data-action="/api/guild/${model.guildId}/snapshot" data-busy="Building (fetching every member)..." ${nowhere ? raw('disabled') : ''}>Snapshot now</button>
        </div>`,
        footer: html`Built in memory and sent as a file; nothing is stored on the server running the bot.`,
    });

    const backupCard = card({
        title: 'Archive',
        hint: 'the weekly database dump and structure snapshot, filed together',
        body: html`<dl class="kv">
            <dt>Filed in</dt><dd>${model.archive
                ? html`#${model.archive.name}${model.archive.elsewhere
                    ? html` <span class="hint">in ${model.archive.guildName}</span>`
                    : html` ${pill('warn', 'this server')}`}`
                : html`${pill('warn', 'your DMs')} <span class="hint">no channel set, so it has to interrupt you</span>`}</dd>
            <dt>Last run</dt><dd>${model.backupLastMs
                ? html`<span title="${fmtDateTime(model.backupLastMs)}">${fmtAgo(model.backupLastMs, model.now)}</span>`
                : html`<span class="hint">never yet</span>`}</dd>
        </dl>
        <form data-api="backup-channel" class="field" data-reload>
            <label for="bch">Archive channel <span class="hint">one destination, every server</span></label>
            <div class="inline-fields">
                <select id="bch" name="channel">
                    <option value="">(none: DM me instead)</option>
                    ${model.channelGroups.map(g => html`<optgroup label="${g.guildName}${g.isCurrent ? ' (this server)' : ''}">
                        ${g.channels.map(c => html`<option value="${c.id}" ${model.archive && c.id === model.archive.id ? raw('selected') : ''}>#${c.name}</option>`)}
                    </optgroup>`)}
                </select>
                <button type="submit" class="ghost">Save</button>
            </div>
        </form>
        <p class="hint">Every server's weekly files land here, wherever here is. Prefer a quiet channel in a
        <strong>server other than the one being backed up</strong>: an archive filed inside the server it protects
        dies with it. Mute it and forget it exists until the day you need it.</p>
        ${model.archive && model.snapshotDmSetting ? html`<p class="hint">The DM copy under
            <a href="/gate?s=snapshot">Join Gate &rarr; Snapshot</a> is on but no longer used for this server:
            the archive channel supersedes it.</p>` : ''}
        <div class="form-actions">
            <button data-action="/api/guild/${model.guildId}/backup" data-busy="Dumping every table..." data-reload>Back up now</button>
        </div>`,
        footer: html`A gzipped dump of every table, restored with <span class="mono">scripts/restore-backup.js</span>. A backup nobody has restored is a rumour; the script dry-runs by default.`,
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
        <div class="row-cards">${snapshotCard}${backupCard}</div>
        <div class="spacer"></div>
        ${auditCard}`;
}

module.exports = { data, render };
