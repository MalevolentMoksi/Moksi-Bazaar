// src/web/pages/gate.js
/**
 * The whole join-gate configuration on one page, which is the thing a Discord
 * embed can never be: every section visible at once, forms instead of modals,
 * and nothing hidden behind a select menu five rows deep.
 *
 * Reads come from the same getSettings as the panel; writes go to /api routes
 * that call the same validate.js. This page is only a different pair of hands
 * on the same controls.
 */

const { getSettings, TIER_ACTIONS, formatDays, LIMITS,
    DEFAULT_DM_MESSAGE, DEFAULT_DM_BAN_MESSAGE,
    DEFAULT_DM_SUSPICION_MESSAGE, DEFAULT_DM_WATCH_MESSAGE } = require('../../utils/joinGate/config');
const { NUMERIC_FIELDS } = require('../../utils/joinGate/validate');
const { DEFAULT_WEIGHTS } = require('../../utils/joinGate/suspicion');
const { BEHAVIOUR_WEIGHTS, COMBO_WEIGHTS } = require('../../utils/joinGate/watch');
const { html, raw, card, pill } = require('../html');

async function data(client, guildId, query = {}) {
    const guild = client.guilds.cache.get(guildId);
    const settings = await getSettings(guildId, { fresh: true });
    const channels = guild
        ? [...guild.channels.cache.values()]
            .filter(c => c.isTextBased?.() && !c.isThread?.())
            .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
            .map(c => ({ id: c.id, name: c.name }))
        : [];
    const section = SECTIONS.some(s => s.key === query.s) ? query.s : SECTIONS[0].key;
    return { settings, channels, section };
}

// ── Form atoms ──────────────────────────────────────────────────────────────

function toggle(column, label, checked, hint = null) {
    return html`<div class="toggle-row">
        <label class="toggle"><input type="checkbox" data-toggle="${column}" ${checked ? raw('checked') : ''}><span class="track"></span>${label}</label>
        ${hint ? html`<span class="hint">${hint}</span>` : ''}
    </div>`;
}

function numInput(key, value, { label = null, boundsNote = null } = {}) {
    const meta = NUMERIC_FIELDS[key];
    return html`<div class="field">
        <label for="f_${key}">${label ?? meta.label}</label>
        <input id="f_${key}" type="number" name="${key}" value="${value}" min="0" step="any">
        <div class="bounds">${boundsNote ?? `${meta.unit}, ${meta.bounds.min} to ${meta.bounds.max}`}</div>
    </div>`;
}

function saveButton(label = 'Save') {
    return html`<div class="form-actions"><button type="submit">${label}</button></div>`;
}

function actionSelect(name, current, { id = null } = {}) {
    return html`<select name="${name}" ${id ? html`id="${id}"` : ''}>
        ${TIER_ACTIONS.map(a => html`<option value="${a}" ${a === current ? raw('selected') : ''}>${a}</option>`)}
    </select>`;
}

function channelForm(key, label, current, channels) {
    return html`<form data-api="channel" class="field">
        <input type="hidden" name="key" value="${key}">
        <label>${label}</label>
        <div class="inline-fields">
            <select name="channel">
                <option value="">(not set)</option>
                ${channels.map(c => html`<option value="${c.id}" ${c.id === current ? raw('selected') : ''}>#${c.name}</option>`)}
            </select>
            <button type="submit" class="ghost">Save</button>
        </div>
    </form>`;
}

function templateForm(key, label, current, fallback) {
    return html`<form data-api="message" class="field">
        <input type="hidden" name="key" value="${key}">
        <label for="t_${key}">${label}</label>
        <textarea id="t_${key}" name="text" rows="4" maxlength="${LIMITS.DM_MESSAGE_LENGTH}"
            placeholder="${fallback}">${current ?? ''}</textarea>
        <div class="bounds">Blank restores the default text. {days} and {server} fill themselves in.</div>
        ${saveButton()}
    </form>`;
}

// ── Sections ────────────────────────────────────────────────────────────────

function renderMaster(s) {
    return card({
        title: 'The gate itself',
        hint: s.configured ? '' : 'this server has never been configured',
        body: html`
            ${toggle('enabled', 'Age gate', s.enabled, 'removes accounts younger than the minimum age below')}
            ${toggle('dry_run', 'Dry run', s.dry_run, 'evaluate and log, but never actually remove anyone')}`,
        footer: html`Lifetime: ${s.total_kicks} kicks, ${s.total_bans} bans, ${s.total_flagged} flagged, ${s.total_failures} failures.`,
    });
}

function renderRules(s) {
    return card({
        title: 'Rules',
        body: html`
            <form data-api="numerics">
                <div class="field-row">
                    ${numInput('min_account_age_minutes', formatDays(s.min_account_age_minutes),
        { label: 'Minimum account age (days)', boundsNote: 'days, 0 to 365; decimals fine (0.5 = 12 hours)' })}
                    ${numInput('escalate_after_attempts', s.escalate_after_attempts)}
                </div>
                ${saveButton()}
            </form>
            ${toggle('gate_bots', 'Gate bots too', s.gate_bots, 'apply the age rule to bot accounts as well')}
            ${toggle('escalate_enabled', 'Escalate repeat rejoins', s.escalate_enabled, 'temp-ban after too many kick-and-rejoin loops; needs Ban Members')}
            <form data-api="exempt" class="field">
                <input type="hidden" name="target" value="gate">
                <label for="ex_gate">Exempt user IDs</label>
                <textarea id="ex_gate" name="list" rows="3"
                    placeholder="IDs or @mentions, separated by spaces, commas or lines">${s.exempt_user_ids.join('\n')}</textarea>
                <div class="bounds">These users pass every gate check, always. Up to ${LIMITS.EXEMPT_IDS}.</div>
                ${saveButton()}
            </form>`,
    });
}

function renderAlerts(s) {
    return card({
        title: 'Burst alert & catch-up sweep',
        body: html`
            ${toggle('burst_alert_enabled', 'Join burst alert', s.burst_alert_enabled, 'warn when joins spike, the usual shape of a raid')}
            ${toggle('burst_count_all_joins', 'Count clean joins too', s.burst_count_all_joins, 'a raid of old-enough accounts is invisible to a window that only counts gated joins; clean surges are announced as surges, not raids')}
            <form data-api="numerics">
                <div class="field-row">
                    ${numInput('burst_threshold', s.burst_threshold)}
                    ${numInput('burst_window_seconds', s.burst_window_seconds)}
                    ${numInput('sweep_window_hours', s.sweep_window_hours)}
                </div>
                ${saveButton()}
            </form>
            ${toggle('sweep_enabled', 'Catch-up sweep', s.sweep_enabled, 'on restart, re-check members who joined while the bot was down')}`,
    });
}

function renderMessaging(s) {
    return card({
        title: 'Messaging',
        hint: 'what a removed person is told',
        body: html`
            ${toggle('dm_enabled', 'Send removal DMs', s.dm_enabled)}
            ${toggle('dm_append_eligible', 'Append the date they become eligible', s.dm_append_eligible)}
            ${toggle('dm_append_invite', 'Append a rejoin invite', s.dm_append_invite)}
            <form data-api="numerics">
                <div class="field-row">${numInput('dm_cooldown_minutes', s.dm_cooldown_minutes)}</div>
                ${saveButton()}
            </form>
            <form data-api="invite" class="field">
                <label for="inv">Rejoin invite link</label>
                <div class="inline-fields">
                    <input type="text" id="inv" name="url" value="${s.dm_invite_url ?? ''}"
                        placeholder="https://discord.gg/...">
                    <button type="submit" class="ghost">Save</button>
                </div>
                <div class="bounds">Discord invite links only; this string is DMed to strangers. Blank clears it.</div>
            </form>
            ${templateForm('dm_message', 'Removal DM: account age', s.dm_message === DEFAULT_DM_MESSAGE ? '' : s.dm_message, DEFAULT_DM_MESSAGE)}
            ${templateForm('dm_ban_message', 'Removal DM: escalated ban', s.dm_ban_message === DEFAULT_DM_BAN_MESSAGE ? '' : s.dm_ban_message, DEFAULT_DM_BAN_MESSAGE)}
            ${templateForm('dm_suspicion_message', 'Removal DM: suspicion', s.dm_suspicion_message === DEFAULT_DM_SUSPICION_MESSAGE ? '' : s.dm_suspicion_message, DEFAULT_DM_SUSPICION_MESSAGE)}
            ${templateForm('dm_watch_message', 'Removal DM: behaviour watch', s.dm_watch_message === DEFAULT_DM_WATCH_MESSAGE ? '' : s.dm_watch_message, DEFAULT_DM_WATCH_MESSAGE)}`,
    });
}

function renderSuspicion(s, channels) {
    const overrides = Object.entries(s.suspicion_weights).map(([k, v]) => `${k} = ${v}`).join('\n');
    return card({
        title: 'Suspicion scoring',
        hint: 'profile signals at join time',
        body: html`
            ${toggle('suspicion_enabled', 'Suspicion scoring', s.suspicion_enabled)}
            ${toggle('suspicion_log_enabled', 'Log suspicion verdicts', s.suspicion_log_enabled)}
            <form data-api="thresholds">
                <label>Tier thresholds (must rise)</label>
                <div class="field-row">
                    <div class="field"><label for="th_w">Watch at</label><input id="th_w" type="number" name="watch" value="${s.suspicion_watch_at}"></div>
                    <div class="field"><label for="th_s">Suspect at</label><input id="th_s" type="number" name="suspect" value="${s.suspicion_suspect_at}"></div>
                    <div class="field"><label for="th_m">Malicious at</label><input id="th_m" type="number" name="malicious" value="${s.suspicion_malicious_at}"></div>
                </div>
                ${saveButton()}
            </form>
            <form data-api="tier-actions">
                <label>What each tier does</label>
                <div class="field-row">
                    <div class="field"><label for="ta_w">Watch</label>${actionSelect('watch', s.suspicion_watch_action, { id: 'ta_w' })}</div>
                    <div class="field"><label for="ta_s">Suspect</label>${actionSelect('suspect', s.suspicion_suspect_action, { id: 'ta_s' })}</div>
                    <div class="field"><label for="ta_m">Malicious</label>${actionSelect('malicious', s.suspicion_malicious_action, { id: 'ta_m' })}</div>
                </div>
                <div class="bounds">kick needs Kick Members, ban needs Ban Members, timeout needs Moderate Members. The save is refused if the bot lacks the permission.</div>
                ${saveButton()}
            </form>
            <form data-api="numerics">
                <div class="field-row">
                    ${numInput('suspicion_tenure_grace_days', s.suspicion_tenure_grace_days)}
                    ${numInput('suspicion_ban_hours', s.suspicion_ban_hours)}
                </div>
                ${saveButton()}
            </form>
            <form data-api="weights" class="field">
                <label for="wts">Signal weight overrides</label>
                <textarea id="wts" name="text" rows="4" placeholder="signal = points, one per line. Empty means all defaults.">${overrides}</textarea>
                <div class="bounds">A typo is refused, never silently skipped. Points from -100 to 100.</div>
                ${saveButton()}
            </form>
            <details class="reference">
                <summary>Every signal and its default weight</summary>
                <pre class="mono">${Object.entries(DEFAULT_WEIGHTS).map(([k, v]) => `${k} = ${v}`).join('\n')}

# behaviour window
${Object.entries({ ...BEHAVIOUR_WEIGHTS, ...COMBO_WEIGHTS }).map(([k, v]) => `${k} = ${v}`).join('\n')}</pre>
            </details>
            ${channelForm('suspicion_log_channel_id', 'Suspicion log channel', s.suspicion_log_channel_id, channels)}`,
        footer: html`<a href="/gate/backtest">Backtest these settings</a> against everyone already in the server.`,
    });
}

function renderWatch(s, channels) {
    return card({
        title: 'Behaviour watch',
        hint: 'what new members do right after joining',
        body: html`
            ${toggle('watch_enabled', 'Behaviour watch', s.watch_enabled)}
            ${toggle('watch_automod_enabled', 'Count AutoMod verdicts', s.watch_automod_enabled, 'Discord AutoMod blocks add to a watched member\'s score')}
            <form data-api="watch-window">
                <div class="field-row">
                    <div class="field"><label for="ww_m">Window (minutes)</label><input id="ww_m" type="number" name="minutes" value="${s.watch_window_minutes}"></div>
                    <div class="field"><label for="ww_a">Acts at (points)</label><input id="ww_a" type="number" name="at" value="${s.watch_action_at}"></div>
                    <div class="field"><label for="ww_x">Action</label>${actionSelect('action', s.watch_action, { id: 'ww_x' })}</div>
                    <div class="field"><label for="ww_t">Timeout length (min)</label><input id="ww_t" type="number" name="timeout" value="${s.watch_timeout_minutes}" placeholder="leave as is"></div>
                </div>
                ${saveButton()}
            </form>
            <form data-api="numerics">
                <div class="field-row">${numInput('watch_ban_hours', s.watch_ban_hours)}</div>
                ${saveButton()}
            </form>
            <form data-api="watch-exempt-channels" class="field">
                <label for="wex">Channels the watch ignores</label>
                <select id="wex" name="channels" multiple size="8">
                    ${channels.map(c => html`<option value="${c.id}" ${s.watch_exempt_channel_ids.includes(c.id) ? raw('selected') : ''}>#${c.name}</option>`)}
                </select>
                <div class="bounds">Ctrl-click to pick several. A #self-promotion channel belongs here: posting your own invite is the point of it.</div>
                ${saveButton()}
            </form>`,
    });
}

function renderGuard(s, channels) {
    return card({
        title: 'Audit-log guard',
        hint: 'watch-only; it can notice, never intercept',
        body: html`
            ${toggle('guard_enabled', 'Audit-log guard', s.guard_enabled, 'alerts on mass deletion, mass creation, permission escalation, webhooks; needs View Audit Log')}
            ${toggle('guard_dm_owner', 'DM you on an alert', s.guard_dm_owner)}
            ${toggle('guard_watch_identity', 'Watch server identity', s.guard_watch_identity, 'name, icon, vanity URL changes')}
            ${toggle('guard_watch_bots', 'Alert when a bot is added', s.guard_watch_bots)}
            <form data-api="guard-limits">
                <label>Alert limits, per window</label>
                <div class="field-row">
                    <div class="field"><label for="gl_w">Window (seconds)</label><input id="gl_w" type="number" name="window" value="${s.guard_window_seconds}"></div>
                    <div class="field"><label for="gl_d">Deletions</label><input id="gl_d" type="number" name="del" value="${s.guard_delete_limit}"></div>
                    <div class="field"><label for="gl_c">Creations</label><input id="gl_c" type="number" name="cre" value="${s.guard_create_limit}"></div>
                    <div class="field"><label for="gl_p">Permission grants</label><input id="gl_p" type="number" name="perm" value="${s.guard_perm_limit}"></div>
                    <div class="field"><label for="gl_h">Webhooks</label><input id="gl_h" type="number" name="hook" value="${s.guard_webhook_limit}"></div>
                </div>
                ${saveButton()}
            </form>
            ${channelForm('guard_channel_id', 'Guard alert channel', s.guard_channel_id, channels)}
            <form data-api="exempt" class="field">
                <input type="hidden" name="target" value="guard">
                <label for="ex_guard">Exempt user IDs</label>
                <textarea id="ex_guard" name="list" rows="2"
                    placeholder="trusted admins whose bulk actions never alert">${s.guard_exempt_user_ids.join('\n')}</textarea>
                ${saveButton()}
            </form>`,
    });
}

function renderSnapshot(s) {
    return card({
        title: 'Weekly structure snapshot',
        body: html`
            ${toggle('snapshot_enabled', 'Weekly snapshot', s.snapshot_enabled, 'channels, roles, overwrites, member roles, emoji, stickers')}
            ${toggle('snapshot_dm_owner', 'DM you a copy', s.snapshot_dm_owner)}
            ${s.snapshot_enabled && !s.snapshot_dm_owner
        ? html`<p class="form-error">Without the DM copy, the only backup lives inside the server it backs up. The one event a snapshot exists for is the one that deletes it.</p>`
        : ''}`,
    });
}

function renderLogging(s, channels) {
    return card({
        title: 'Logging',
        body: html`
            ${toggle('log_kicks', 'Log kicks', s.log_kicks)}
            ${toggle('log_failures', 'Log failures', s.log_failures)}
            ${toggle('log_previews', 'Log previews', s.log_previews)}
            ${toggle('log_config', 'Log config changes', s.log_config)}
            ${toggle('invite_tracking_enabled', 'Invite attribution', s.invite_tracking_enabled, 'record which invite each joiner arrived through')}
            <div class="field-row">
                ${channelForm('log_channel_id', 'Default log channel', s.log_channel_id, channels)}
                ${channelForm('log_kick_channel_id', 'Kick log', s.log_kick_channel_id, channels)}
                ${channelForm('log_failure_channel_id', 'Failure log', s.log_failure_channel_id, channels)}
                ${channelForm('log_preview_channel_id', 'Preview log', s.log_preview_channel_id, channels)}
                ${channelForm('log_config_channel_id', 'Config log', s.log_config_channel_id, channels)}
            </div>`,
    });
}

/**
 * Real tabs, not scroll anchors. One section renders at a time, picked by
 * ?s=, so switching sections is a navigation instead of a scroll hunt down
 * a very long page.
 */
const SECTIONS = [
    { key: 'gate', label: 'The gate', section: (s) => renderMaster(s) },
    { key: 'rules', label: 'Rules', section: (s) => renderRules(s) },
    { key: 'alerts', label: 'Alerts', section: (s) => renderAlerts(s) },
    { key: 'messaging', label: 'Messaging', section: (s) => renderMessaging(s) },
    { key: 'suspicion', label: 'Suspicion', section: (s, ch) => renderSuspicion(s, ch) },
    { key: 'watch', label: 'Watch', section: (s, ch) => renderWatch(s, ch) },
    { key: 'guard', label: 'Guard', section: (s, ch) => renderGuard(s, ch) },
    { key: 'snapshot', label: 'Snapshot', section: (s) => renderSnapshot(s) },
    { key: 'logging', label: 'Logging', section: (s, ch) => renderLogging(s, ch) },
];

function render({ settings: s, channels, section }) {
    const active = SECTIONS.find(t => t.key === section) ?? SECTIONS[0];
    return html`
        <nav class="tab-bar">
            ${SECTIONS.map(t => html`<a href="/gate?s=${t.key}" class="${t.key === active.key ? 'tab-active' : ''}">${t.label}</a>`)}
            <span class="tab-state">${s.enabled ? pill('on', 'gate on') : pill('off', 'gate off')}${s.dry_run ? pill('warn', 'dry run') : ''}</span>
        </nav>
        ${active.section(s, channels)}`;
}

module.exports = { data, render, SECTIONS };
