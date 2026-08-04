// src/web/api.js
/**
 * The dashboard's write surface. Thin on purpose.
 *
 * Every mutation follows one path: a validator from joinGate/validate.js
 * produces a verdict, the verdict's declared permissions are checked against
 * the live guild, updateSettings writes the patch, and the same config-change
 * log the Discord panel emits goes out. There is no rule here that the panel
 * does not also obey, because both writers call the same module.
 *
 * The one endpoint that skips validate.js is the boolean toggle, and it is
 * held to an allow-list of known switch columns with values coerced to real
 * booleans. Arming a tier still declares its permissions: switching suspicion
 * ON re-checks the STORED tier actions, so a kick armed while the bot could
 * kick cannot be silently re-armed after that permission was taken away.
 */

const express = require('express');
const { PermissionFlagsBits } = require('discord.js');
const validate = require('../utils/joinGate/validate');
const { getSettings, updateSettings, LIMITS, formatDays } = require('../utils/joinGate/config');
const { logConfigChange } = require('../utils/joinGate/logging');
const logger = require('../utils/logger');

/** Booleans the quick toggles may flip, with the words a human reads back. */
const TOGGLES = Object.freeze({
    enabled: 'Age gate',
    dry_run: 'Dry run',
    gate_bots: 'Gate bots too',
    dm_enabled: 'Removal DMs',
    dm_append_eligible: 'DM: append eligibility date',
    dm_append_invite: 'DM: append rejoin invite',
    escalate_enabled: 'Escalate repeat rejoins to temp-ban',
    log_kicks: 'Log kicks',
    log_failures: 'Log failures',
    log_previews: 'Log previews',
    log_config: 'Log config changes',
    burst_alert_enabled: 'Join burst alert',
    sweep_enabled: 'Catch-up sweep',
    suspicion_enabled: 'Suspicion scoring',
    suspicion_log_enabled: 'Suspicion logging',
    watch_enabled: 'Behaviour watch',
    watch_automod_enabled: 'AutoMod signals in the watch window',
    guard_enabled: 'Audit-log guard',
    guard_dm_owner: 'Guard: DM the owner',
    guard_watch_identity: 'Guard: watch server identity',
    guard_watch_bots: 'Guard: bot-addition alerts',
    snapshot_enabled: 'Weekly structure snapshot',
    snapshot_dm_owner: 'Snapshot: DM copy to owner',
    invite_tracking_enabled: 'Invite attribution',
});

/** Where a picked channel may land. */
const CHANNEL_COLUMNS = Object.freeze({
    log_channel_id: 'Default log channel',
    log_kick_channel_id: 'Kick log channel',
    log_failure_channel_id: 'Failure log channel',
    log_preview_channel_id: 'Preview log channel',
    log_config_channel_id: 'Config log channel',
    suspicion_log_channel_id: 'Suspicion log channel',
    guard_channel_id: 'Guard alert channel',
});

/** The DM templates, each editable, blank meaning "back to the default text". */
const MESSAGE_COLUMNS = Object.freeze({
    dm_message: 'Removal DM (account age)',
    dm_ban_message: 'Removal DM (escalated ban)',
    dm_suspicion_message: 'Removal DM (suspicion)',
    dm_watch_message: 'Removal DM (behaviour watch)',
});

/** Arming a switch must honour the actions ALREADY stored behind it. */
function requiresForToggle(column, value, settings) {
    if (value !== true) return [];
    if (column === 'suspicion_enabled') {
        return validate.permissionsFor([
            settings.suspicion_watch_action,
            settings.suspicion_suspect_action,
            settings.suspicion_malicious_action,
        ]);
    }
    if (column === 'watch_enabled') return validate.permissionsFor([settings.watch_action]);
    return validate.permissionsForPatch({ [column]: value });
}

function createApi(client) {
    const router = express.Router();

    const guildOf = req => client.guilds.cache.get(req.params.g) ?? null;

    async function missingPermissions(guild, required = []) {
        if (!required?.length) return [];
        const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
        return required.filter(name => !me?.permissions.has(PermissionFlagsBits[name]));
    }

    /**
     * The single write path. Mirrors the panel's applyValidated: a verdict
     * either refuses with its own words, or is permission-checked and stored.
     */
    async function apply(req, res, verdict) {
        const guild = guildOf(req);
        if (!guild) return res.status(404).json({ error: 'The bot is not in that server.' });
        if (!verdict.ok) return res.status(400).json({ error: verdict.error });

        const missing = await missingPermissions(guild, verdict.requires);
        if (missing.length) {
            return res.status(400).json({
                error: `That needs ${missing.join(', ')}, which the bot does not have here. `
                    + 'Grant it first: otherwise the dashboard would report an action as armed that cannot happen.',
            });
        }

        const updated = await updateSettings(guild.id, verdict.patch);
        logger.info('[DASHBOARD] Config changed', {
            guildId: guild.id, by: req.owner.uid, summary: verdict.summary,
        });
        logConfigChange(guild, updated, {
            actor: { id: req.owner.uid },
            summary: verdict.summary,
            details: 'Changed from the web dashboard.',
        }).catch(() => {});

        return res.json({ ok: true, summary: verdict.summary });
    }

    const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
    const fieldsOf = req => (req.body?.fields && typeof req.body.fields === 'object') ? req.body.fields : {};

    // ── Quick toggles ───────────────────────────────────────────────────
    router.post('/guild/:g/settings', wrap(async (req, res) => {
        const patch = req.body?.patch;
        const keys = patch && typeof patch === 'object' ? Object.keys(patch) : [];
        if (keys.length !== 1 || !Object.hasOwn(TOGGLES, keys[0])) {
            return res.status(400).json({ error: 'Only one known switch at a time.' });
        }
        const column = keys[0];
        const value = patch[column] === true;

        const settings = await getSettings(req.params.g);
        const requires = requiresForToggle(column, value, settings);
        return apply(req, res, {
            ok: true,
            patch: { [column]: value },
            summary: `${TOGGLES[column]} switched ${value ? 'on' : 'off'}`,
            requires,
        });
    }));

    // ── Grouped numeric fields, refused whole if any one is junk ────────
    router.post('/guild/:g/numerics', wrap(async (req, res) => {
        const fields = fieldsOf(req);
        const keys = Object.keys(fields).filter(k => k in validate.NUMERIC_FIELDS);
        if (!keys.length) return res.status(400).json({ error: 'Nothing to save.' });

        const patch = {};
        const parts = [];
        for (const key of keys) {
            const verdict = validate.numericField(key, fields[key]);
            if (!verdict.ok) return res.status(400).json({ error: verdict.error });
            Object.assign(patch, verdict.patch);
            parts.push(key === 'min_account_age_minutes'
                ? `Minimum account age set to ${formatDays(patch[key])} day(s)`
                : verdict.summary);
        }
        return apply(req, res, { ok: true, patch, summary: parts.join('; '), requires: [] });
    }));

    // ── Named validators, one endpoint each ─────────────────────────────
    router.post('/guild/:g/thresholds', wrap(async (req, res) => {
        const f = fieldsOf(req);
        return apply(req, res, validate.thresholds({ watch: f.watch, suspect: f.suspect, malicious: f.malicious }));
    }));

    router.post('/guild/:g/tier-actions', wrap(async (req, res) => {
        const f = fieldsOf(req);
        return apply(req, res, validate.tierActions({ watch: f.watch, suspect: f.suspect, malicious: f.malicious }));
    }));

    router.post('/guild/:g/watch-window', wrap(async (req, res) => {
        const f = fieldsOf(req);
        return apply(req, res, validate.watchWindow({
            minutes: f.minutes, at: f.at, action: f.action, timeout: f.timeout,
        }));
    }));

    router.post('/guild/:g/guard-limits', wrap(async (req, res) => {
        const f = fieldsOf(req);
        return apply(req, res, validate.guardLimits({
            window: f.window, del: f.del, cre: f.cre, perm: f.perm, hook: f.hook,
        }));
    }));

    router.post('/guild/:g/weights', wrap(async (req, res) => {
        return apply(req, res, validate.weights(fieldsOf(req).text));
    }));

    router.post('/guild/:g/invite', wrap(async (req, res) => {
        return apply(req, res, validate.inviteUrl(fieldsOf(req).url));
    }));

    // ── Exempt user lists: same parser, two destinations ────────────────
    router.post('/guild/:g/exempt', wrap(async (req, res) => {
        const f = fieldsOf(req);
        const column = f.target === 'guard' ? 'guard_exempt_user_ids' : 'exempt_user_ids';
        const verdict = validate.userIds(f.list);
        if (!verdict.ok) return res.status(400).json({ error: verdict.error });
        return apply(req, res, {
            ok: true,
            patch: { [column]: verdict.ids },
            summary: `${f.target === 'guard' ? 'Guard exemptions' : 'Gate exemptions'}: ${verdict.summary}`,
            requires: [],
        });
    }));

    // ── DM templates ────────────────────────────────────────────────────
    router.post('/guild/:g/message', wrap(async (req, res) => {
        const f = fieldsOf(req);
        if (!(f.key in MESSAGE_COLUMNS)) return res.status(400).json({ error: 'Unknown message template.' });
        const text = String(f.text ?? '').trim();
        if (text.length > LIMITS.DM_MESSAGE_LENGTH) {
            return res.status(400).json({
                error: `That is ${text.length} characters; DMs are capped at ${LIMITS.DM_MESSAGE_LENGTH}.`,
            });
        }
        return apply(req, res, {
            ok: true,
            patch: { [f.key]: text || null },
            summary: text
                ? `${MESSAGE_COLUMNS[f.key]} updated`
                : `${MESSAGE_COLUMNS[f.key]} reset to the default text`,
            requires: [],
        });
    }));

    // ── Channel destinations ────────────────────────────────────────────
    router.post('/guild/:g/channel', wrap(async (req, res) => {
        const guild = guildOf(req);
        if (!guild) return res.status(404).json({ error: 'The bot is not in that server.' });
        const f = fieldsOf(req);
        if (!(f.key in CHANNEL_COLUMNS)) return res.status(400).json({ error: 'Unknown channel setting.' });

        const channelId = String(f.channel ?? '').trim();
        if (channelId === '') {
            return apply(req, res, {
                ok: true, patch: { [f.key]: null },
                summary: `${CHANNEL_COLUMNS[f.key]} cleared`, requires: [],
            });
        }
        const channel = guild.channels.cache.get(channelId);
        if (!channel?.isTextBased?.() || channel.isThread?.()) {
            return res.status(400).json({ error: 'That is not a text channel in this server.' });
        }
        return apply(req, res, {
            ok: true, patch: { [f.key]: channelId },
            summary: `${CHANNEL_COLUMNS[f.key]} set to #${channel.name}`, requires: [],
        });
    }));

    // ── Snapshot now ────────────────────────────────────────────────────
    // The one button that DOES something, and what it does is read: it
    // builds the structure file and sends it to the configured copies. The
    // exact logic of the panel's own button, including the refusal when
    // there is nowhere to send one.
    router.post('/guild/:g/snapshot', wrap(async (req, res) => {
        const guild = guildOf(req);
        if (!guild) return res.status(404).json({ error: 'The bot is not in that server.' });

        const { resolveChannel, sendSnapshot } = require('../utils/joinGate/snapshot');
        const settings = await getSettings(guild.id);
        const target = resolveChannel(settings);
        const dmUserId = settings.snapshot_dm_owner ? (process.env.OWNER_ID || null) : null;
        if (!target && !dmUserId) {
            return res.status(400).json({
                error: 'Nowhere to send it. Set a guard alert channel, or turn on the DM copy.',
            });
        }

        const result = await sendSnapshot(guild, target, { dmUserId });
        if (!result.ok) return res.status(502).json({ error: `Snapshot failed: ${result.error}` });

        logger.info('[DASHBOARD] Snapshot sent', { guildId: guild.id, by: req.owner.uid });
        return res.json({
            ok: true,
            summary: `Snapshot sent (${result.sentTo.join(' and ')}): ${result.meta.channels} channels, `
                + `${result.meta.roles} roles, ${(result.meta.bytes / 1024).toFixed(0)} KB`
                + (result.warning ? `. But: ${result.warning}` : ''),
        });
    }));

    // ── Where backups are filed ─────────────────────────────────────────
    // Not a guild setting: one archive channel serves every server, which is
    // the point. Picking it in a different server than the one being backed
    // up is the whole idea, and the dashboard's server picker is how.
    router.post('/guild/:g/backup-channel', wrap(async (req, res) => {
        const { setBackupChannelId } = require('../utils/backup');
        const guild = guildOf(req);
        if (!guild) return res.status(404).json({ error: 'The bot is not in that server.' });

        const channelId = String(fieldsOf(req).channel ?? '').trim();
        if (channelId === '') {
            await setBackupChannelId(null);
            logger.info('[DASHBOARD] Backup archive channel cleared', { by: req.owner.uid });
            return res.json({ ok: true, summary: 'Archive channel cleared. Weekly dumps will be DMed to you instead.' });
        }

        const channel = guild.channels.cache.get(channelId);
        if (!channel?.isTextBased?.() || channel.isThread?.()) {
            return res.status(400).json({ error: 'That is not a text channel in this server.' });
        }
        await setBackupChannelId(channelId);
        logger.info('[DASHBOARD] Backup archive channel set', { channelId, by: req.owner.uid });
        return res.json({ ok: true, summary: `Backups and snapshots will be filed in #${channel.name}` });
    }));

    // ── Back up now ─────────────────────────────────────────────────────
    // The whole database, not one guild's slice; the :g in the route only
    // keeps the client-side plumbing uniform. Sends wherever the weekly run
    // would: the owner's DMs always, plus the /backup channel if one is set.
    router.post('/guild/:g/backup', wrap(async (req, res) => {
        const { sendBackup, getBackupChannelId, LAST_RUN_KEY } = require('../utils/backup');
        const { setSpeakConfigValue } = require('../utils/db');
        const { OWNER_ID } = require('../utils/constants');

        const channelId = await getBackupChannelId();
        const result = await sendBackup(client, { channelId, fallbackDmUserId: OWNER_ID });
        if (!result.ok) return res.status(502).json({ error: result.errors.join(' ') });

        // Stamped so the weekly slot does not double up right after a manual run.
        await setSpeakConfigValue(LAST_RUN_KEY, Date.now());
        logger.info('[DASHBOARD] Backup sent', { sentTo: result.sentTo, by: req.owner.uid });
        return res.json({
            ok: true,
            summary: `Backup sent (${result.sentTo.join(' and ')}): `
                + `${result.meta.totalRows.toLocaleString()} rows, ${(result.meta.bytes / 1024).toFixed(0)} KB`
                + (result.errors.length ? `. But: ${result.errors.join(' ')}` : ''),
        });
    }));

    // ── Watch-window channel exemptions ─────────────────────────────────
    router.post('/guild/:g/watch-exempt-channels', wrap(async (req, res) => {
        const guild = guildOf(req);
        if (!guild) return res.status(404).json({ error: 'The bot is not in that server.' });
        const f = fieldsOf(req);
        const asked = f.channels == null ? [] : (Array.isArray(f.channels) ? f.channels : [f.channels]);
        const ids = [...new Set(asked.map(String))];
        const unknown = ids.filter(id => !guild.channels.cache.has(id));
        if (unknown.length) {
            return res.status(400).json({ error: 'One of those channels no longer exists. Refresh the page.' });
        }
        return apply(req, res, {
            ok: true,
            patch: { watch_exempt_channel_ids: ids },
            summary: ids.length
                ? `Behaviour watch now ignores ${ids.length} channel(s)`
                : 'Behaviour watch ignores no channels',
            requires: [],
        });
    }));

    return router;
}

module.exports = { createApi, TOGGLES, CHANNEL_COLUMNS, MESSAGE_COLUMNS, requiresForToggle };
