// src/utils/joinGate/guard.js
/**
 * Join Gate: the audit-log guard.
 *
 * Everything else this bot does points outward, at people arriving. This is the
 * one thing that looks at people already trusted. A compromised moderator, a
 * hijacked bot token or a staff account having a very bad day can delete every
 * channel in the server, and nothing else here would notice.
 *
 * WATCH-ONLY, AND STRUCTURALLY SO. The audit log is a record of what has
 * already happened; Discord writes the entry after carrying the action out.
 * This module cannot intercept a command, block a deletion or veto anything,
 * from the owner, from staff, or from another bot. It notices and it reports.
 * There is no moderation call anywhere in this file.
 *
 * BANS, KICKS AND TIMEOUTS ARE DELIBERATELY NOT WATCHED. That is the design
 * decision that keeps it out of the way. Wick has to own every ban because it
 * cannot otherwise tell a legitimate one from a nuke, which is why using it
 * means routing all moderation through it. A nuke's damage is structural:
 * deleted channels and roles are gone, whereas bans are reversible and routine.
 * Watching only structure means a mass-ban through Dyno at 3am trips nothing,
 * and nobody's workflow changes by a keystroke.
 */

const { AuditLogEvent, PermissionFlagsBits } = require('discord.js');
const logger = require('../logger');

/**
 * What each watched action counts toward.
 *
 * Grouped rather than counted per-action-type, because "deleted four channels
 * and three roles" is one attack, not two unrelated events that each stayed
 * under their own limit.
 */
const DESTRUCTIVE = 'destructive';
const CREATION = 'creation';
const PERMISSION = 'permission';
const WEBHOOK = 'webhook';
const IDENTITY = 'identity';
const BOT = 'bot';

const WATCHED = Object.freeze({
    [AuditLogEvent.ChannelDelete]: { bucket: DESTRUCTIVE, noun: 'channel deleted' },
    [AuditLogEvent.RoleDelete]: { bucket: DESTRUCTIVE, noun: 'role deleted' },
    [AuditLogEvent.ChannelCreate]: { bucket: CREATION, noun: 'channel created' },
    [AuditLogEvent.RoleCreate]: { bucket: CREATION, noun: 'role created' },
    [AuditLogEvent.WebhookCreate]: { bucket: WEBHOOK, noun: 'webhook created' },
    // Permission changes are only counted when they actually grant something
    // dangerous; see isDangerousPermissionChange.
    [AuditLogEvent.RoleUpdate]: { bucket: PERMISSION, noun: 'role permissions changed' },
    [AuditLogEvent.ChannelOverwriteCreate]: { bucket: PERMISSION, noun: 'channel permission added' },
    [AuditLogEvent.ChannelOverwriteUpdate]: { bucket: PERMISSION, noun: 'channel permission changed' },
    // Identity: rare enough that one is worth reporting on its own.
    [AuditLogEvent.GuildUpdate]: { bucket: IDENTITY, noun: 'server settings changed' },
    // A bot being added is the likeliest nuke vector for a server this size,
    // and the audit log names who added it. Also reported on its own: a second
    // bot appearing is not something that needs a threshold.
    [AuditLogEvent.BotAdd]: { bucket: BOT, noun: 'bot added' },
});

/** Which setting holds the limit for each bucket. */
const LIMIT_KEYS = Object.freeze({
    [DESTRUCTIVE]: 'guard_delete_limit',
    [CREATION]: 'guard_create_limit',
    [PERMISSION]: 'guard_perm_limit',
    [WEBHOOK]: 'guard_webhook_limit',
});

const BUCKET_LABEL = Object.freeze({
    [DESTRUCTIVE]: 'Structure deleted',
    [CREATION]: 'Mass creation',
    [PERMISSION]: 'Permission escalation',
    [WEBHOOK]: 'Webhooks created',
    [IDENTITY]: 'Server identity changed',
    [BOT]: 'Bot added to the server',
});

/**
 * Permissions worth escalating over. Handing someone Administrator or the
 * ability to rewrite roles and channels is the step that turns one compromised
 * account into a nuke; handing them Manage Messages is a Tuesday.
 */
const DANGEROUS_PERMISSIONS = [
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageWebhooks,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.MentionEveryone,
];

/** Identity fields whose change is reported on its own, with no threshold. */
const IDENTITY_KEYS = new Set(['vanity_url_code', 'name', 'icon_hash', 'owner_id']);

/** guildId -> actorId -> {bucket -> number[] of timestamps, alertedAt} */
const activity = new Map();

function actorBucket(guildId, actorId) {
    let perGuild = activity.get(guildId);
    if (!perGuild) { perGuild = new Map(); activity.set(guildId, perGuild); }
    let entry = perGuild.get(actorId);
    if (!entry) { entry = { buckets: new Map(), alertedAt: 0 }; perGuild.set(actorId, entry); }
    return entry;
}

/**
 * True when a permission change actually granted something dangerous.
 *
 * A role edit that renames a role or changes its colour is noise. Only the
 * bits that were newly ALLOWED count, so removing a permission never trips it.
 */
function isDangerousPermissionChange(changes) {
    for (const change of changes ?? []) {
        if (change.key !== 'permissions' && change.key !== 'allow') continue;
        let before = 0n;
        let after = 0n;
        try {
            before = BigInt(change.old ?? 0);
            after = BigInt(change.new ?? 0);
        } catch {
            continue;
        }
        const gained = after & ~before;
        if (DANGEROUS_PERMISSIONS.some(flag => (gained & flag) === flag && flag !== 0n)) return true;
    }
    return false;
}

/** The identity fields an entry changed, for the alert text. */
function identityChanges(changes) {
    return (changes ?? [])
        .filter(c => IDENTITY_KEYS.has(c.key))
        .map(c => (c.key === 'vanity_url_code' ? 'vanity URL' : c.key.replace(/_/g, ' ')));
}

/**
 * Records one audit-log entry and decides whether it has crossed a limit.
 *
 * Pure apart from the in-memory counters: no Discord calls, no database, so the
 * whole decision is testable without a gateway.
 *
 * @returns {null|{bucket, label, actorId, count, limit, windowSeconds, actions, identity}}
 */
function record(guildId, entry, settings, now = Date.now()) {
    const watched = WATCHED[entry.action];
    if (!watched) return null;

    const actorId = entry.executorId ?? entry.executor?.id;
    if (!actorId) return null;
    if (settings.guard_exempt_user_ids?.includes(actorId)) return null;

    // Identity changes are reported on their own: nobody renames the server or
    // frees its vanity URL by accident, and a freed vanity can be claimed by
    // the attacker's own server within seconds.
    if (watched.bucket === IDENTITY) {
        if (!settings.guard_watch_identity) return null;
        const fields = identityChanges(entry.changes);
        if (fields.length === 0) return null;
        return {
            bucket: IDENTITY,
            label: BUCKET_LABEL[IDENTITY],
            actorId,
            count: fields.length,
            limit: 1,
            windowSeconds: 0,
            actions: fields.map(f => `changed ${f}`),
            identity: fields,
        };
    }

    if (watched.bucket === BOT) {
        if (!settings.guard_watch_bots) return null;
        return {
            bucket: BOT,
            label: BUCKET_LABEL[BOT],
            actorId,
            targetId: entry.targetId ?? entry.target?.id ?? null,
            count: 1,
            limit: 1,
            windowSeconds: 0,
            actions: ['added a bot'],
            identity: null,
        };
    }

    if (watched.bucket === PERMISSION && !isDangerousPermissionChange(entry.changes)) return null;

    const windowSeconds = Math.max(5, Number(settings.guard_window_seconds) || 60);
    const windowMs = windowSeconds * 1000;
    const limit = Math.max(1, Number(settings[LIMIT_KEYS[watched.bucket]]) || 4);

    const state = actorBucket(guildId, actorId);
    const times = (state.buckets.get(watched.bucket) ?? []).filter(t => t >= now - windowMs);
    times.push(now);
    state.buckets.set(watched.bucket, times);

    if (times.length < limit) return null;

    // One alert per actor per window. A nuke produces hundreds of entries and
    // the owner needs one message, not three hundred pings.
    if (now - state.alertedAt < windowMs) return null;
    state.alertedAt = now;

    return {
        bucket: watched.bucket,
        label: BUCKET_LABEL[watched.bucket],
        actorId,
        count: times.length,
        limit,
        windowSeconds,
        actions: [watched.noun],
        identity: null,
    };
}

/** Forgets an actor's counters, e.g. after the owner has dealt with them. */
function clear(guildId, actorId) {
    if (!guildId) { activity.clear(); return; }
    if (!actorId) { activity.delete(guildId); return; }
    activity.get(guildId)?.delete(actorId);
}

/** Drops counters older than the window so a long-lived process does not grow. */
function prune(maxAgeMs = 10 * 60_000, now = Date.now()) {
    let dropped = 0;
    for (const [guildId, perGuild] of activity) {
        for (const [actorId, state] of perGuild) {
            let live = false;
            for (const [bucket, times] of state.buckets) {
                const kept = times.filter(t => t >= now - maxAgeMs);
                if (kept.length === 0) state.buckets.delete(bucket);
                else { state.buckets.set(bucket, kept); live = true; }
            }
            if (!live && now - state.alertedAt > maxAgeMs) { perGuild.delete(actorId); dropped++; }
        }
        if (perGuild.size === 0) activity.delete(guildId);
    }
    if (dropped > 0) logger.debug('[GUARD] Pruned idle actors', { dropped });
    return dropped;
}

module.exports = {
    record,
    clear,
    prune,
    isDangerousPermissionChange,
    identityChanges,
    WATCHED,
    DANGEROUS_PERMISSIONS,
    BUCKETS: { DESTRUCTIVE, CREATION, PERMISSION, WEBHOOK, IDENTITY, BOT },
};
