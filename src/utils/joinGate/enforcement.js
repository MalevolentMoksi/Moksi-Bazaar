// src/utils/joinGate/enforcement.js
/**
 * Join Gate: decision logic and enforcement.
 *
 * Design rules this file exists to keep honest:
 *
 *  1. NEW MEMBERS ONLY. The only entry points are `guildMemberAdd` and an
 *     opt-in catch-up sweep that is hard-filtered on `joinedTimestamp`.
 *     Nothing here can ever walk the full member list and re-judge people who
 *     have been in the server for months.
 *  2. FAIL OPEN. Any error (database down, config unreadable) results in
 *     nobody being removed. The absence of a working config is never read as
 *     permission to act.
 *  3. ROLES ARE NOT CONSULTED. An autorole bot may hand out a role before this
 *     runs; that must not become an accidental bypass. Account age and the
 *     explicit user-ID allow-list are the only criteria.
 *  4. DM BEFORE REMOVAL. After a kick or ban the bot may share no guild with
 *     the user, and the DM would be rejected. Order is not negotiable.
 */

const { PermissionFlagsBits, SnowflakeUtil } = require('discord.js');
const { pool } = require('../db');
const logger = require('../logger');
const {
    DAY_MS, MINUTE_MS, getSettings, thresholdMs, formatDays, incrementStat,
} = require('./config');
const { logOutcome, logBurst, logSuspicion } = require('./logging');
const { insertPendingUnban, scheduleNext } = require('./unbanScheduler');
const suspicion = require('./suspicion');
const watch = require('./watch');
const invites = require('./invites');
const activity = require('./activity');
const { findCohorts } = require('./cohorts');

/**
 * Removals are serialised globally rather than per guild. The bottleneck is
 * DM creation, which Discord rate-limits per bot, not per server.
 */
const QUEUE_SPACING_MS = 1_200;
/** Refuse to grow without bound if something goes badly wrong. */
const QUEUE_MAX = 1_000;
/**
 * Past this backlog we stop DMing and just remove. In a real raid the accounts
 * are disposable, the DMs are worthless, and the rate limit they burn is the
 * one thing standing between the bot and a global 429.
 */
const DM_SKIP_BACKLOG = 25;

/** @type {Array<{member: import('discord.js').GuildMember, origin: string}>} */
const queue = [];
const queued = new Set();
let draining = false;

/** guildId -> recent gated-join timestamps, for burst detection. */
const burstWindows = new Map();
/** guildId -> last burst alert timestamp, so one raid is not 200 alerts. */
const burstAlerted = new Map();
const BURST_ALERT_COOLDOWN_MS = 5 * 60_000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function displayTag(user) {
    return user.discriminator && user.discriminator !== '0' ? user.tag : user.username;
}

// ── Decision (pure) ─────────────────────────────────────────────────────────

/**
 * Decides what should happen to one member. No side effects, no API calls.
 * The panel reuses this to preview a user ID against the live config.
 *
 * @param {{id: string, bot: boolean, createdTimestamp: number}} user
 * @param {object} settings
 * @param {{guildOwnerId?: string, now?: number}} [context]
 * @returns {{action: 'allow'|'gate', reason: string, ageMs: number, thresholdMs: number, eligibleAt: number}}
 */
function evaluate(user, settings, { guildOwnerId = null, now = Date.now() } = {}) {
    const threshold = thresholdMs(settings);
    const ageMs = now - Number(user.createdTimestamp);
    const eligibleAt = Number(user.createdTimestamp) + threshold;
    const base = { ageMs, thresholdMs: threshold, eligibleAt };

    if (!settings.enabled) return { action: 'allow', reason: 'gate disabled for this server', ...base };
    if (threshold <= 0) return { action: 'allow', reason: 'threshold is 0 days', ...base };
    if (user.bot && !settings.gate_bots) return { action: 'allow', reason: 'bot account (bots are exempt)', ...base };
    if (settings.exempt_user_ids.includes(user.id)) return { action: 'allow', reason: 'user is on the exempt list', ...base };
    // Guard, not a feature: the guild owner is above the bot in every hierarchy,
    // so acting on them can only ever produce a guaranteed-failing API call.
    if (guildOwnerId && user.id === guildOwnerId) return { action: 'allow', reason: 'server owner', ...base };

    if (ageMs >= threshold) {
        return { action: 'allow', reason: `account is ${(ageMs / DAY_MS).toFixed(1)}d old`, ...base };
    }

    return {
        action: 'gate',
        reason: `account is ${(ageMs / DAY_MS).toFixed(2)}d old, minimum is ${formatDays(settings.min_account_age_minutes)}d`,
        ...base,
    };
}

/** Evaluates a raw user ID using only its snowflake. Used by the panel tester. */
function evaluateUserId(userId, settings, context = {}) {
    const createdTimestamp = Number(SnowflakeUtil.timestampFrom(userId));
    return evaluate({ id: userId, bot: false, createdTimestamp }, settings, context);
}

// ── Attempt tracking ────────────────────────────────────────────────────────

async function recordAttempt(guildId, userId) {
    const now = String(Date.now());
    const { rows } = await pool.query(
        `INSERT INTO join_gate_attempts (guild_id, user_id, attempts, first_seen_ms, last_seen_ms)
         VALUES ($1, $2, 1, $3, $3)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET
            attempts     = join_gate_attempts.attempts + 1,
            last_seen_ms = EXCLUDED.last_seen_ms
         RETURNING attempts, last_dm_ms`,
        [guildId, userId, now]
    );
    return rows[0];
}

async function peekAttempt(guildId, userId) {
    const { rows } = await pool.query(
        'SELECT attempts, last_dm_ms FROM join_gate_attempts WHERE guild_id = $1 AND user_id = $2',
        [guildId, userId]
    );
    return rows[0] || { attempts: 0, last_dm_ms: null };
}

async function markDmSent(guildId, userId) {
    await pool.query(
        'UPDATE join_gate_attempts SET last_dm_ms = $3 WHERE guild_id = $1 AND user_id = $2',
        [guildId, userId, String(Date.now())]
    );
}

/** A member who got in cleanly has no history worth keeping. */
async function clearAttempts(guildId, userId) {
    await pool.query(
        'DELETE FROM join_gate_attempts WHERE guild_id = $1 AND user_id = $2',
        [guildId, userId]
    );
}

async function getAttemptLeaderboard(guildId, limit = 10) {
    const { rows } = await pool.query(
        `SELECT user_id, attempts, first_seen_ms, last_seen_ms
         FROM join_gate_attempts WHERE guild_id = $1
         ORDER BY attempts DESC, last_seen_ms DESC LIMIT $2`,
        [guildId, limit]
    );
    return rows;
}

// ── DM composition ──────────────────────────────────────────────────────────

const PLACEHOLDER_RE = /\{(days|server|user|eligible|age)\}/g;

/**
 * Substitutes placeholders. Uses a replacer function so that a guild name
 * containing `$&` or `$1` cannot corrupt the output.
 */
function renderTemplate(template, values) {
    return String(template ?? '').replace(PLACEHOLDER_RE, (_, key) => values[key] ?? '');
}

/**
 * Builds the exact DM text a user would receive.
 * Exported so the panel can preview and test-send it.
 *
 * `cause` picks the template: 'age' (the gate itself), 'suspicion' (profile
 * score) or 'behaviour' (watch window). The age templates claim the account
 * is too new, which is factually wrong for the other two causes; they get
 * their own text.
 *
 * @returns {string} message body, truncated to Discord's 2000-char limit
 */
function renderDm(settings, { guildName, user, eligibleAt, ageMs, kind = 'kick', cause = 'age' }) {
    const eligibleUnix = Math.floor(eligibleAt / 1000);
    const template = cause === 'suspicion' ? settings.dm_suspicion_message
        : cause === 'behaviour' ? settings.dm_watch_message
        : kind === 'ban' ? settings.dm_ban_message : settings.dm_message;

    const body = renderTemplate(template, {
        days: formatDays(settings.min_account_age_minutes),
        server: guildName,
        user: user?.username ?? 'there',
        eligible: `<t:${eligibleUnix}:F>`,
        age: (ageMs / DAY_MS).toFixed(1),
    });

    const parts = [body];

    if (settings.dm_append_eligible) {
        parts.push(`\nYou can rejoin from <t:${eligibleUnix}:F> (<t:${eligibleUnix}:R>).`);
    }
    if (settings.dm_append_invite && settings.dm_invite_url) {
        parts.push(`\nInvite: ${settings.dm_invite_url}`);
    }

    return parts.join('\n').slice(0, 2000);
}

/**
 * @returns {Promise<{sent: boolean, note: string}>} never throws
 */
async function trySendDm(member, settings, decision, kind, attempts, cause = 'age') {
    if (!settings.dm_enabled) return { sent: false, note: 'disabled' };

    if (queue.length > DM_SKIP_BACKLOG) {
        return { sent: false, note: 'skipped (burst backlog)' };
    }

    // Cooldown keeps a rejoin loop from turning into a DM flood, which is the
    // fastest way to lose the bot's DM rate-limit budget server-wide.
    //
    // Escalation is deliberately exempt. With the defaults (3 attempts, 60m
    // cooldown) a user rejoining quickly would have attempts 2 and 3 both
    // suppressed, meaning the one DM that actually matters, the one telling
    // them they are now temp-banned and exactly when it lifts, never arrives.
    const cooldownMs = kind === 'ban' ? 0 : Number(settings.dm_cooldown_minutes) * MINUTE_MS;
    if (cooldownMs > 0 && attempts.last_dm_ms) {
        const since = Date.now() - Number(attempts.last_dm_ms);
        if (since < cooldownMs) {
            return { sent: false, note: `suppressed (cooldown, ${Math.ceil((cooldownMs - since) / 60_000)}m left)` };
        }
    }

    try {
        const content = renderDm(settings, {
            guildName: member.guild.name,
            user: member.user,
            eligibleAt: decision.eligibleAt,
            ageMs: decision.ageMs,
            kind,
            cause,
        });
        await member.send({ content });
        await markDmSent(member.guild.id, member.id).catch(() => {});
        return { sent: true, note: 'delivered' };
    } catch (error) {
        // 50007 Cannot send messages to this user: DMs closed or bot blocked.
        const note = error?.code === 50007 ? 'not delivered (DMs closed)' : `not delivered (${error.message})`;
        return { sent: false, note };
    }
}

// ── Removal ─────────────────────────────────────────────────────────────────

function classifyRemovalError(error) {
    switch (error?.code) {
        case 10007:
            return { error: 'member already left', hint: null, benign: true };
        case 10013:
            return { error: 'unknown user', hint: null, benign: true };
        case 50013:
            return {
                error: 'missing permissions',
                hint: 'Grant the bot **Kick Members** (and **Ban Members** if escalation is on), '
                    + 'and move its role above the roles new members receive.',
                benign: false,
            };
        default:
            return { error: error?.message ?? 'unknown error', hint: null, benign: false };
    }
}

/**
 * Performs the actual removal. Assumes the DM has already been attempted.
 * @returns {Promise<{ok: boolean, action: 'kick'|'ban', error?: string, hint?: string, unbanAt?: number, benign?: boolean}>}
 */
async function removeMember(member, settings, decision, action) {
    const reason = `Join gate: ${decision.reason}`;

    if (action === 'ban') {
        if (!member.bannable) {
            return {
                ok: false,
                action: 'ban',
                error: 'not bannable (missing Ban Members, or the bot\'s role is too low)',
                hint: 'Move the bot\'s role above this member\'s highest role and grant **Ban Members**.',
            };
        }
        try {
            // deleteMessageSeconds: 0 because this is an access gate, not a purge.
            await member.ban({ reason, deleteMessageSeconds: 0 });
            await insertPendingUnban(member.guild.id, member.id, decision.eligibleAt, decision.unbanKind ?? 'age');
            await scheduleNext(member.client);
            return { ok: true, action: 'ban', unbanAt: decision.eligibleAt };
        } catch (error) {
            const c = classifyRemovalError(error);
            return { ok: false, action: 'ban', ...c };
        }
    }

    if (!member.kickable) {
        return {
            ok: false,
            action: 'kick',
            error: 'not kickable (missing Kick Members, or the bot\'s role is too low)',
            hint: 'Move the bot\'s role **above** the role your autorole bot assigns on join, '
                + 'and make sure it has **Kick Members**.',
        };
    }

    try {
        await member.kick(reason);
        return { ok: true, action: 'kick' };
    } catch (error) {
        const c = classifyRemovalError(error);
        return { ok: false, action: 'kick', ...c };
    }
}

/**
 * Deletes the messages that got a member flagged.
 *
 * A ban can ask Discord to sweep recent history in one call, but a kick and a
 * timeout cannot, and leaving a wall of scam links up after removing the person
 * who posted them is half a job. The watch window already knows exactly which
 * messages they were.
 *
 * Best-effort throughout: a message already deleted by a moderator, or in a
 * channel the bot cannot manage, is skipped rather than raised.
 *
 * @returns {Promise<number>} how many were actually deleted
 */
async function purgeEvidence(guild, evidence) {
    let deleted = 0;
    // Newest first: if the bot runs out of permission part-way through, the
    // most recent spam is the part that got removed.
    for (const item of [...evidence].reverse()) {
        if (!item.messageId || !item.channelId) continue;
        try {
            const channel = guild.channels.cache.get(item.channelId)
                ?? await guild.channels.fetch(item.channelId).catch(() => null);
            if (!channel?.messages?.delete) continue;
            await channel.messages.delete(item.messageId);
            deleted++;
        } catch (error) {
            // 10008 Unknown Message: already gone, which is the desired state.
            if (error?.code !== 10008) {
                logger.debug('[JOIN-GATE] Evidence delete failed', {
                    messageId: item.messageId, error: error.message,
                });
            }
        }
    }
    return deleted;
}

// ── Burst detection ─────────────────────────────────────────────────────────

/**
 * Read-only view of the burst window. Members who pass the age gate never
 * touch noteBurst, but "arrived while a burst was happening" is still a signal
 * worth feeding the scorer.
 */
function isInBurst(guildId, settings) {
    const windowMs = Number(settings.burst_window_seconds) * 1000;
    const now = Date.now();
    const hits = (burstWindows.get(guildId) ?? []).filter(t => now - t < windowMs);
    return hits.length >= Number(settings.burst_threshold);
}

function noteBurst(guild, settings) {
    if (!settings.burst_alert_enabled) return false;

    const windowMs = Number(settings.burst_window_seconds) * 1000;
    const now = Date.now();
    const hits = (burstWindows.get(guild.id) ?? []).filter(t => now - t < windowMs);
    hits.push(now);
    burstWindows.set(guild.id, hits);

    if (hits.length < Number(settings.burst_threshold)) return false;

    const lastAlert = burstAlerted.get(guild.id) ?? 0;
    if (now - lastAlert < BURST_ALERT_COOLDOWN_MS) return false;

    burstAlerted.set(guild.id, now);
    logBurst(guild, settings, {
        count: hits.length,
        windowSeconds: Number(settings.burst_window_seconds),
    }).catch(() => {});
    return true;
}

// ── Queue ───────────────────────────────────────────────────────────────────

function enqueue(member, origin) {
    if (queue.length >= QUEUE_MAX) {
        logger.error('[JOIN-GATE] Queue full, dropping member', {
            guildId: member.guild.id, userId: member.id,
        });
        return;
    }
    const key = `${member.guild.id}:${member.id}`;
    if (queued.has(key)) return; // already pending; a second join adds nothing
    queued.add(key);
    queue.push({ member, origin });
    if (!draining) drain();
}

async function drain() {
    if (draining) return;
    draining = true;
    try {
        while (queue.length > 0) {
            const entry = queue.shift();
            queued.delete(`${entry.member.guild.id}:${entry.member.id}`);
            try {
                await processGated(entry.member, entry.origin);
            } catch (error) {
                logger.error('[JOIN-GATE] Processing failed', {
                    guildId: entry.member.guild.id, userId: entry.member.id, error: error.message,
                });
            }
            if (queue.length > 0) await sleep(QUEUE_SPACING_MS);
        }
    } finally {
        draining = false;
    }
}

/**
 * Runs one member all the way through DM → removal → logging → stats.
 * Settings are re-read here rather than captured at enqueue time, so turning
 * the gate off mid-raid takes effect on everyone still in the queue.
 */
async function processGated(member, origin) {
    const guild = member.guild;
    const settings = await getSettings(guild.id);

    const decision = evaluate(member.user, settings, { guildOwnerId: guild.ownerId });
    if (decision.action !== 'gate') {
        logger.debug('[JOIN-GATE] Member no longer gated at processing time', {
            guildId: guild.id, userId: member.id, reason: decision.reason,
        });
        return;
    }

    const dryRun = Boolean(settings.dry_run);

    // Dry run must not persist attempt counts. Otherwise arming the gate later
    // would instantly ban people who "used up" their attempts during a preview.
    const attempts = dryRun
        ? await peekAttempt(guild.id, member.id)
        : await recordAttempt(guild.id, member.id);
    const attemptNumber = dryRun ? Number(attempts.attempts) + 1 : Number(attempts.attempts);

    const wantsBan = Boolean(settings.escalate_enabled)
        && attemptNumber >= Number(settings.escalate_after_attempts);
    const action = wantsBan ? 'ban' : 'kick';

    if (dryRun) {
        await logOutcome(guild, settings, {
            user: member.user,
            decision,
            result: { ok: true, action, dm: settings.dm_enabled ? 'would send' : 'disabled', unbanAt: wantsBan ? decision.eligibleAt : null },
            origin,
            attempt: attemptNumber,
            dryRun: true,
        });
        logger.info('[JOIN-GATE] Dry run', {
            guildId: guild.id, userId: member.id, action, reason: decision.reason,
        });
        return;
    }

    const dm = await trySendDm(member, settings, decision, action, attempts);
    const result = await removeMember(member, settings, decision, action);
    result.dm = dm.note;

    await logOutcome(guild, settings, {
        user: member.user,
        decision,
        result,
        origin,
        attempt: attemptNumber,
        dryRun: false,
    });

    if (result.ok) {
        await incrementStat(guild.id, action === 'ban' ? 'total_bans' : 'total_kicks');
        logger.info('[JOIN-GATE] Member removed', {
            guildId: guild.id, userId: member.id, action, attempt: attemptNumber, dm: dm.note,
        });
    } else if (!result.benign) {
        await incrementStat(guild.id, 'total_failures');
        logger.warn('[JOIN-GATE] Removal failed', {
            guildId: guild.id, userId: member.id, action, error: result.error,
        });
    }
}

// ── Suspicion scoring ───────────────────────────────────────────────────────

/**
 * Names worth guarding against impersonation: the server itself, and anyone
 * holding staff-level permissions. Cached per guild for a short while because
 * this walks the role cache.
 */
const protectedNamesCache = new Map();
const PROTECTED_TTL_MS = 5 * 60_000;

function collectProtectedNames(guild) {
    const hit = protectedNamesCache.get(guild.id);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const names = new Set([guild.name]);
    try {
        for (const member of guild.members.cache.values()) {
            if (member.user.bot) continue;
            const perms = member.permissions;
            if (perms?.has(PermissionFlagsBits.Administrator) || perms?.has(PermissionFlagsBits.ManageGuild)) {
                names.add(member.displayName);
                names.add(member.user.username);
            }
        }
    } catch {
        // Cache may be cold; the guild name alone is still worth guarding.
    }

    const value = [...names].filter(Boolean);
    protectedNamesCache.set(guild.id, { value, expiresAt: Date.now() + PROTECTED_TTL_MS });
    return value;
}

/**
 * Scores a joiner and applies the tier's configured action.
 *
 * Runs only for members the age gate ALLOWED. Someone already being removed
 * for their account age must not also be judged here: that would double-punish
 * and make the logs contradict each other.
 */
async function runSuspicion(member, settings, { inBurst, inviteInfo = null }) {
    const guild = member.guild;

    const correlation = suspicion.correlateJoin(guild.id, member.user);
    const result = suspicion.scoreAccount(member.user, {
        weights: settings.suspicion_weights,
        keywords: settings.suspicion_keywords ?? suspicion.DEFAULT_SCAM_KEYWORDS,
        protectedNames: collectProtectedNames(guild),
        correlation,
        inBurst,
        inviteFlood: Boolean(inviteInfo?.flooding),
        member,
        tenureGraceDays: Number(settings.suspicion_tenure_grace_days),
        thresholds: {
            watch: Number(settings.suspicion_watch_at),
            suspect: Number(settings.suspicion_suspect_at),
            malicious: Number(settings.suspicion_malicious_at),
        },
    });

    if (inviteInfo?.known) result.inviteInfo = inviteInfo;

    // Hand the verdict to the behaviour window whatever it was. A member who
    // looked wrong on arrival needs less evidence of misbehaviour afterwards,
    // and a clear one carries nothing, which is what stops this from being a
    // blanket increase in sensitivity.
    watch.setJoinScore(guild.id, member.id, result.score, result.tier);

    if (result.tier === 'clear') return;

    const action = {
        watch: settings.suspicion_watch_action,
        suspect: settings.suspicion_suspect_action,
        malicious: settings.suspicion_malicious_action,
    }[result.tier] ?? 'log';

    const dryRun = Boolean(settings.dry_run);
    let actionOutcome = null;

    if (!dryRun && (action === 'kick' || action === 'ban')) {
        const now = Date.now();
        // A suspicion ban is a fixed cooldown measured from NOW. Anyone scored
        // here already passed the age gate, so "creation + threshold" would
        // date the unban in the past and the scheduler would lift it seconds
        // later, turning the ban into a kick with a misleading DM.
        const unbanAt = now + Number(settings.suspicion_ban_hours) * 3_600_000;
        const decision = {
            action: 'gate',
            reason: `suspicion score ${result.score} (${result.tier})`,
            ageMs: now - Number(member.user.createdTimestamp),
            thresholdMs: thresholdMs(settings),
            eligibleAt: action === 'ban' ? unbanAt : now,
            // Fixed cooldown: age-threshold edits must never recompute it.
            unbanKind: 'timed',
        };
        const attempts = await peekAttempt(guild.id, member.id).catch(() => ({ attempts: 0, last_dm_ms: null }));
        const dm = await trySendDm(member, settings, decision, action === 'ban' ? 'ban' : 'kick', attempts, 'suspicion');
        actionOutcome = await removeMember(member, settings, decision, action);
        actionOutcome.dm = dm.note;

        if (actionOutcome.ok) {
            await incrementStat(guild.id, action === 'ban' ? 'total_bans' : 'total_kicks');
        } else if (!actionOutcome.benign) {
            await incrementStat(guild.id, 'total_failures');
        }
    }

    await logSuspicion(guild, settings, { user: member.user, result, action, actionOutcome, dryRun });
    if (!dryRun) await incrementStat(guild.id, 'total_flagged');

    logger.info('[JOIN-GATE] Suspicion scored', {
        guildId: guild.id, userId: member.id, score: result.score, tier: result.tier, action, dryRun,
    });
}

// ── Entry points ────────────────────────────────────────────────────────────

/**
 * Called from the `guildMemberAdd` event. Never throws.
 */
async function handleMemberJoin(member) {
    try {
        if (!member?.guild) return;
        if (member.id === member.client.user.id) return;

        let settings;
        try {
            settings = await getSettings(member.guild.id);
        } catch (error) {
            // Fail open: an unreadable config is not permission to kick anyone.
            logger.error('[JOIN-GATE] Config read failed, taking no action', {
                guildId: member.guild.id, error: error.message,
            });
            return;
        }

        if (!settings.enabled) return;

        // Record every joiner, including ones that pass everything: a raid is
        // only visible as a group, so the correlation window needs the clean
        // arrivals too.
        if (settings.suspicion_enabled) {
            suspicion.recordJoin(member.guild.id, member.user);
        }

        // Start the behaviour window before any removal decision, so a member
        // who slips past the gate is still observed for their first minutes.
        if (settings.watch_enabled && !member.user.bot) {
            watch.watchMember(member.guild.id, member.id);
        }

        let inviteInfo = null;
        if (settings.invite_tracking_enabled) {
            inviteInfo = await invites.resolveJoin(member.guild).catch(() => null);
        }

        const decision = evaluate(member.user, settings, { guildOwnerId: member.guild.ownerId });

        if (decision.action === 'allow') {
            // Someone who got in cleanly has no rejoin history worth keeping.
            clearAttempts(member.guild.id, member.id).catch(() => {});

            if (settings.suspicion_enabled && !member.user.bot) {
                const inBurst = isInBurst(member.guild.id, settings);
                await runSuspicion(member, settings, { inBurst, inviteInfo }).catch(error =>
                    logger.error('[JOIN-GATE] Suspicion scoring failed', {
                        guildId: member.guild.id, userId: member.id, error: error.message,
                    })
                );
            }
            return;
        }

        noteBurst(member.guild, settings);
        enqueue(member, 'join');
    } catch (error) {
        logger.error('[JOIN-GATE] handleMemberJoin crashed', { error: error.message, stack: error.stack });
    }
}

/**
 * Inspects a message from a recently joined member.
 *
 * Called for every guild message, so the cheap "is this person even being
 * watched" check has to come first and has to be synchronous. Only members
 * inside the watch window cost anything at all; everyone else returns
 * immediately without a database read.
 *
 * Never throws.
 */
async function handleWatchedMessage(message) {
    try {
        // `system` filters Discord's own announcements, which are authored AS
        // the member: the join notification is literally a message "from" the
        // person being watched, sent the moment they join, saying nothing.
        if (!message?.guild || message.author?.bot || message.system) return;

        // Cheapest possible gate: an in-memory lookup, no config read.
        if (watch.watchedCount(message.guild.id) === 0) return;

        let settings;
        try {
            settings = await getSettings(message.guild.id);
        } catch {
            return; // fail open, same as the join path
        }
        if (!settings.enabled || !settings.watch_enabled) return;

        // Channels where the behaviour signals mean something else. In a
        // #self-promotion channel an invite link is the reason the channel
        // exists, so scoring it as advertising would punish people for using
        // the server correctly.
        //
        // The parent is checked too, so exempting a channel exempts its
        // threads. A thread carries its own id, so without this a #self-promo
        // thread would be scored while the channel it lives in was not, and a
        // forum channel could never be exempted at all: every message in one is
        // in a thread.
        const exemptChannels = settings.watch_exempt_channel_ids;
        if (exemptChannels?.length
            && (exemptChannels.includes(message.channelId)
                || (message.channel?.parentId && exemptChannels.includes(message.channel.parentId)))) return;

        const windowMs = Number(settings.watch_window_minutes) * 60_000;
        if (!watch.isWatched(message.guild.id, message.author.id, windowMs)) return;

        const threshold = Number(settings.watch_action_at);
        const { score, signals, report } = watch.inspectMessage(message.guild.id, message, {
            windowMs, threshold,
        });
        // `report` is false for a member already reported at the same level:
        // the score keeps accumulating quietly and only speaks up again when it
        // crosses the action bar or gets materially worse.
        if (score <= 0 || !report) return;

        const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
        if (!member) return;

        await enforceBehaviour(message.guild, member, settings, {
            score, signals, channelId: message.channelId,
        });
    } catch (error) {
        logger.error('[JOIN-GATE] handleWatchedMessage crashed', { error: error.message, stack: error.stack });
    }
}

/**
 * Acts on a behaviour score, whatever produced it.
 *
 * Extracted so the AutoMod path and the message path cannot drift. Two copies
 * of enforcement logic is how a timeout ends up logged as a kick in one of
 * them and not the other, which has already happened once here.
 */
async function enforceBehaviour(guild, member, settings, { score, signals, channelId }) {
    const threshold = Number(settings.watch_action_at);
    const action = score >= threshold ? settings.watch_action : 'log';
    const dryRun = Boolean(settings.dry_run);

    const result = {
        score,
        tier: score >= threshold ? 'malicious' : 'watch',
        signals,
        source: 'behaviour',
    };

    let actionOutcome = null;
    // Captured before anything acts: a ban removes the member, and with
    // them the ability to look up what they posted.
    const evidence = watch.evidenceFor(guild.id, member.id);

    // A timeout is not a removal, so it goes through member.timeout rather
    // than the kick/ban path: no DM template, no pending unban row, nothing
    // to walk back with an invite. It expires on its own and a moderator
    // can lift it in one click.
    if (!dryRun && action === 'timeout') {
        const minutes = Math.max(1, Number(settings.watch_timeout_minutes) || 60);
        try {
            await member.timeout(
                minutes * 60_000,
                `Join gate: behaviour score ${score} within the watch window`
            );
            actionOutcome = { ok: true, action: 'timeout', minutes };
            logger.info('[JOIN-GATE] Watch timeout applied', {
                guildId: guild.id, userId: member.id, minutes, score,
            });
        } catch (error) {
            // Missing Moderate Members, or the member outranks the bot.
            actionOutcome = { ok: false, action: 'timeout', error: error.message };
            logger.error('[JOIN-GATE] Watch timeout failed', {
                guildId: guild.id, userId: member.id, error: error.message,
            });
            await incrementStat(guild.id, 'total_failures');
        }
    }

    if (!dryRun && (action === 'kick' || action === 'ban')) {
        const nowMs = Date.now();
        // Same honesty rule as the suspicion path: a behaviour ban is a
        // cooldown from now, never "creation + threshold", which is
        // already in the past for anyone who got past the age gate.
        const unbanAt = nowMs + Number(settings.watch_ban_hours) * 3_600_000;
        const decision = {
            action: 'gate',
            reason: `behaviour score ${score} within the watch window`,
            ageMs: nowMs - Number(member.user.createdTimestamp),
            thresholdMs: thresholdMs(settings),
            eligibleAt: action === 'ban' ? unbanAt : nowMs,
            // Fixed cooldown: age-threshold edits must never recompute it.
            unbanKind: 'timed',
        };
        const attempts = await peekAttempt(guild.id, member.id).catch(() => ({ attempts: 0, last_dm_ms: null }));
        const dm = await trySendDm(member, settings, decision, action === 'ban' ? 'ban' : 'kick', attempts, 'behaviour');
        actionOutcome = await removeMember(member, settings, decision, action);
        actionOutcome.dm = dm.note;

        if (actionOutcome.ok) {
            await incrementStat(guild.id, action === 'ban' ? 'total_bans' : 'total_kicks');
        } else if (!actionOutcome.benign) {
            await incrementStat(guild.id, 'total_failures');
        }
    }

    // Clean up after any real action. Removing the person who posted a wall
    // of scam links and leaving the links up is half a job, and a kick and
    // a timeout have no equivalent of the ban endpoint's message sweep.
    if (!dryRun && actionOutcome?.ok && evidence.length) {
        actionOutcome.deleted = await purgeEvidence(guild, evidence);
    }

    // Keep watching. Dropping the member here was what stopped a sweep
    // across channels from ever being seen as a sweep: the first flagged
    // message ended the watch, so every later copy scored nothing and the
    // cross-channel and duplicate weights could not fire. Only a member who
    // is actually gone stops being watched.
    watch.markReported(guild.id, member.id, score);
    if (actionOutcome?.ok && (action === 'kick' || action === 'ban')) {
        watch.forget(guild.id, member.id);
    }

    await logSuspicion(guild, settings, {
        user: member.user, result, action, actionOutcome, dryRun,
        channelId,
        evidence,
    });
    if (!dryRun) await incrementStat(guild.id, 'total_flagged');

    logger.info('[JOIN-GATE] Watch-window flag', {
        guildId: guild.id, userId: member.id, score, action, dryRun,
        signals: signals.map(s => s.id),
    });
}

/**
 * Discord AutoMod trigger types, and what a hit from each is worth as evidence
 * that an account is automated.
 *
 * The distinction that matters is who wrote the rule. SPAM and MENTION_SPAM are
 * Discord's own classifiers: they fire on machine-shaped behaviour, and a hit
 * on a member six minutes into the server is strong evidence. MEMBER_PROFILE
 * catches a name a server has banned, which bulk accounts do trip.
 *
 * KEYWORD and KEYWORD_PRESET are a server's own list of words it does not want
 * said. That is a person misbehaving, not a bot, and scoring it here would
 * quietly turn a swearing filter into grounds for removal. Weighted 0 by
 * default; the weight exists so an owner can raise it deliberately, not so it
 * happens by accident.
 */
const AUTOMOD_TRIGGERS = Object.freeze({
    1: { id: 'automod_keyword', label: 'Tripped a keyword rule', weight: 'automod_keyword' },
    3: { id: 'automod_spam', label: 'Discord flagged this as spam', weight: 'automod_spam' },
    4: { id: 'automod_keyword', label: 'Tripped a preset word filter', weight: 'automod_keyword' },
    5: { id: 'automod_mention_spam', label: 'Discord blocked mention spam', weight: 'automod_mention_spam' },
    6: { id: 'automod_profile', label: 'Blocked profile name', weight: 'automod_profile' },
});

/**
 * Scores a verdict from Discord's own AutoMod against a member still inside
 * their join watch window.
 *
 * AutoMod blocks the message before any bot sees it, so the strongest thing a
 * new account can do (trip Discord's spam classifier) was invisible here
 * precisely because the platform handled it well. This does not create, read or
 * modify any AutoMod rule: it only listens to what the owner's own rules did.
 */
async function handleAutoModAction(execution) {
    try {
        const guild = execution?.guild;
        const userId = execution?.userId;
        if (!guild || !userId) return;

        // Cheapest possible gate, same as the message path: an in-memory
        // lookup, no config read when nobody is being watched.
        if (watch.watchedCount(guild.id) === 0) return;

        let settings;
        try {
            settings = await getSettings(guild.id);
        } catch {
            return; // fail open
        }
        if (!settings.enabled || !settings.watch_enabled || !settings.watch_automod_enabled) return;

        const exemptChannels = settings.watch_exempt_channel_ids;
        if (execution.channelId && exemptChannels?.length && exemptChannels.includes(execution.channelId)) return;

        const trigger = AUTOMOD_TRIGGERS[execution.ruleTriggerType];
        if (!trigger) return;
        const points = Number(watch.BEHAVIOUR_WEIGHTS[trigger.weight] ?? 0);
        if (points <= 0) return; // keyword rules, unless deliberately weighted up

        const windowMs = Number(settings.watch_window_minutes) * 60_000;
        if (!watch.isWatched(guild.id, userId, windowMs)) return;

        const matched = String(execution.matchedKeyword ?? execution.matchedContent ?? '').slice(0, 60);
        const threshold = Number(settings.watch_action_at);
        const { score, signals, report } = watch.noteExternalSignal(guild.id, userId, {
            id: trigger.id,
            label: trigger.label,
            points,
            detail: matched ? `AutoMod matched "${matched}"` : 'blocked by your AutoMod rules',
        }, { windowMs, threshold });

        if (score <= 0 || !report) return;

        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) return;

        await enforceBehaviour(guild, member, settings, {
            score, signals, channelId: execution.channelId,
        });
    } catch (error) {
        logger.error('[JOIN-GATE] handleAutoModAction crashed', { error: error.message, stack: error.stack });
    }
}

/**
 * Opt-in catch-up for joins that happened while the bot was offline.
 *
 * Hard-filtered on `joinedTimestamp`: only members who joined inside the
 * configured window are even considered, so long-standing members can never be
 * caught by it no matter how new their account is.
 *
 * @returns {Promise<{scanned: number, gated: number, skipped?: string}>}
 */
async function sweepGuild(client, guildId) {
    const settings = await getSettings(guildId, { fresh: true });
    if (!settings.enabled || !settings.sweep_enabled) {
        return { scanned: 0, gated: 0, skipped: 'sweep not enabled' };
    }

    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return { scanned: 0, gated: 0, skipped: 'guild unreachable' };

    const me = await guild.members.fetchMe().catch(() => null);
    if (!me?.permissions.has(PermissionFlagsBits.KickMembers)) {
        logger.warn('[JOIN-GATE] Sweep aborted: missing Kick Members', { guildId });
        return { scanned: 0, gated: 0, skipped: 'missing Kick Members' };
    }

    let members;
    try {
        members = await guild.members.fetch();
    } catch (error) {
        logger.error('[JOIN-GATE] Sweep member fetch failed', { guildId, error: error.message });
        return { scanned: 0, gated: 0, skipped: 'member fetch failed (is the GuildMembers intent on?)' };
    }

    const cutoff = Date.now() - Number(settings.sweep_window_hours) * 3_600_000;
    let gated = 0;

    for (const member of members.values()) {
        // The whole safety property of the sweep lives on this line.
        if (!member.joinedTimestamp || member.joinedTimestamp < cutoff) continue;

        const decision = evaluate(member.user, settings, { guildOwnerId: guild.ownerId });
        if (decision.action !== 'gate') continue;

        gated++;
        enqueue(member, 'sweep');
    }

    logger.info('[JOIN-GATE] Sweep complete', {
        guildId, scanned: members.size, gated, windowHours: settings.sweep_window_hours,
    });
    return { scanned: members.size, gated };
}

/**
 * Scores every current member WITHOUT acting on anyone, so thresholds can be
 * tuned against the real community before the scorer is ever armed.
 *
 * Correlation signals are deliberately absent: they describe how a joiner
 * arrived relative to others, which is not reconstructable after the fact.
 * Backtest numbers are therefore a floor, not a prediction.
 *
 * @returns {Promise<{scanned: number, distribution: object, flagged: Array, skipped?: string}>}
 */
async function backtestGuild(guild, settings, { limit = 25, applyTenure = false } = {}) {
    let members;
    try {
        members = await guild.members.fetch();
    } catch (error) {
        return { scanned: 0, distribution: {}, flagged: [], skipped: `member fetch failed: ${error.message}` };
    }

    const thresholds = {
        watch: Number(settings.suspicion_watch_at),
        suspect: Number(settings.suspicion_suspect_at),
        malicious: Number(settings.suspicion_malicious_at),
    };
    const protectedNames = collectProtectedNames(guild);
    const distribution = { clear: 0, watch: 0, suspect: 0, malicious: 0 };
    const flagged = [];

    // Participation, so tenure forgiveness reflects taking part rather than
    // merely persisting. One query for the whole guild, not one per member.
    const now = Date.now();
    const [messageCounts, activitySince] = await Promise.all([
        activity.countsForGuild(guild.id).catch(() => new Map()),
        activity.trackingSince().catch(() => 0),
    ]);
    const participationFor = (member) => {
        if (!activitySince) return null; // counting has not started; judge nobody
        const watchedFrom = Math.max(activitySince, Number(member.joinedTimestamp) || 0);
        return {
            messages: messageCounts.get(member.id) ?? 0,
            observedDays: (now - watchedFrom) / suspicion.DAY_MS,
        };
    };

    // Everything the cohort scan needs, collected in the same pass.
    const roster = [];
    // Tenure would clear almost everyone here, which is correct in production
    // but useless for tuning. Score both ways and report both.
    let stillFlaggedWithTenure = 0;

    for (const member of members.values()) {
        if (member.user.bot) continue;

        roster.push({
            id: member.id,
            username: String(member.user.username ?? ''),
            tag: displayTag(member.user),
            createdTimestamp: Number(member.user.createdTimestamp
                ?? SnowflakeUtil.timestampFrom(member.id)),
            joinedTimestamp: Number(member.joinedTimestamp) || 0,
            defaultAvatar: !member.user.avatar,
            messages: messageCounts.get(member.id) ?? 0,
        });

        const common = {
            weights: settings.suspicion_weights,
            keywords: settings.suspicion_keywords ?? suspicion.DEFAULT_SCAM_KEYWORDS,
            protectedNames,
            correlation: null,
            inBurst: false,
            tenureGraceDays: Number(settings.suspicion_tenure_grace_days),
            participation: participationFor(member),
            thresholds,
        };

        const result = suspicion.scoreAccount(member.user, { ...common, member, applyTenure });
        distribution[result.tier] = (distribution[result.tier] ?? 0) + 1;

        if (result.tier !== 'clear') {
            const withTenure = applyTenure
                ? result
                : suspicion.scoreAccount(member.user, { ...common, member, applyTenure: true });
            if (withTenure.tier !== 'clear') stillFlaggedWithTenure++;

            flagged.push({
                id: member.id,
                tag: displayTag(member.user),
                score: result.score,
                tier: result.tier,
                tenureScore: withTenure.score,
                reason: suspicion.summarise(result),
                forcedByDiscord: Boolean(result.forcedByDiscord),
                result,
            });
        }
    }

    // Severity first, then score. Sorting on score alone puts a 79 "suspect"
    // above a 65 "malicious" and makes the list look self-contradictory.
    flagged.sort((a, b) =>
        (suspicion.TIER_RANK[b.tier] - suspicion.TIER_RANK[a.tier]) || (b.score - a.score));
    return {
        scanned: members.size,
        distribution,
        flagged: flagged.slice(0, limit),
        totalFlagged: flagged.length,
        stillFlaggedWithTenure,
        appliedTenure: applyTenure,
        // Reported alongside the scores, never folded into them. The backtest
        // has to stay an honest simulation of what live scoring would do, and
        // live scoring does not know about cohorts.
        cohorts: findCohorts(roster),
        activityTracked: Boolean(activitySince),
        activitySince,
    };
}

module.exports = {
    evaluate,
    evaluateUserId,
    renderDm,
    handleMemberJoin,
    handleWatchedMessage,
    handleAutoModAction,
    sweepGuild,
    backtestGuild,
    collectProtectedNames,
    // Exported for /lookup, which reads the counter without touching it.
    peekAttempt,
    getAttemptLeaderboard,
    clearAttempts,
    displayTag,
    queueDepth: () => queue.length,
};
