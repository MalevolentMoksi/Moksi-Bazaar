// src/utils/joinGate/restore.js
/**
 * Join Gate: handing the moderation stack back its short-term memory.
 *
 * Three of the things that decide whether a newcomer is a problem live only in
 * this process, and this process is replaced on every push:
 *
 *   watch.js      who is inside their behaviour window, and what they have
 *                 said in it
 *   suspicion.js  who else arrived in the last ten minutes, which is what
 *                 turns four separate joins into one raid
 *   guard.js      how many channels each actor has just deleted
 *
 * The worst of the three is the first, and not because it resets. watchMember
 * is called from exactly one place: the guildMemberAdd handler. Nothing re-arms
 * it. So a member who joined two minutes before a deploy is never watched
 * again, because the only event that could start watching them has already
 * happened. They are invisible to the behaviour scorer for good, and a spammer
 * who joins and waits (waiting is the entire reason that window exists) scores
 * zero for everything they then post.
 *
 * Everything below is derived from what Discord still knows at boot, filtered
 * on joinedTimestamp exactly the way the catch-up sweep is, so nobody outside
 * the configured window can be touched by it.
 *
 * IT NEVER ACTS. It watches, it seeds and it scores; it does not kick, ban,
 * time out, delete or report. A restart is not evidence of anything, and a bot
 * that hands out punishments every time it redeploys would be worse than the
 * gap this closes. The next thing the member actually does is what decides.
 */

const logger = require('../logger');
const suspicion = require('./suspicion');
const guard = require('./guard');
const watch = require('./watch');
const enforcement = require('./enforcement');

/** How far back a member can have joined and still matter to anything here. */
function horizonMs(settings) {
    const watchMs = Math.max(0, Number(settings?.watch_window_minutes) || 0) * 60_000;
    return Math.max(watchMs, suspicion.JOIN_WINDOW_MS);
}

/**
 * Rebuilds one guild's short-term memory.
 *
 * @returns {Promise<{watched: number, joins: number, guard: number, skipped?: string}>}
 */
async function restoreGuild(guild, settings, { now = Date.now() } = {}) {
    const empty = { watched: 0, joins: 0, guard: 0 };
    if (!guild || !settings?.enabled) return { ...empty, skipped: 'gate disabled' };

    const result = { ...empty };

    // ── The two member-derived memories ─────────────────────────────────
    let members = null;
    try {
        // One fetch per guild per boot. There is no "members who joined
        // recently" endpoint, so the whole list is the only way to ask, and
        // the catch-up sweep already pays the same price when it is enabled.
        members = await guild.members.fetch();
    } catch (error) {
        logger.warn('[JOIN-GATE] Restore could not read the member list', {
            guildId: guild.id, error: error.message,
        });
    }

    if (members) {
        const cutoff = now - horizonMs(settings);
        const recent = [...members.values()]
            .filter(m => !m.user?.bot && Number(m.joinedTimestamp) >= cutoff)
            .sort((a, b) => Number(a.joinedTimestamp) - Number(b.joinedTimestamp));

        // Joins first: the carry-over scoring below reads this list for
        // correlation, so seeding it afterwards would score everyone as though
        // they had arrived alone.
        result.joins = suspicion.seedJoins(guild.id, recent.map(m => ({
            id: m.id,
            username: m.user?.username,
            avatar: m.user?.avatar,
            createdTimestamp: m.user?.createdTimestamp,
            at: Number(m.joinedTimestamp),
        })), now);

        if (settings.watch_enabled) {
            const watchMs = Math.max(0, Number(settings.watch_window_minutes) || 0) * 60_000;
            for (const member of recent) {
                const joinedAt = Number(member.joinedTimestamp);
                if (now - joinedAt > watchMs) continue;

                // The real join time, not now: the window has to expire when it
                // would have expired, or a deploy would silently extend it.
                watch.watchMember(guild.id, member.id, joinedAt);
                result.watched += 1;

                // The carry-over. Signals from before the restart are gone, but
                // "this profile looked wrong on arrival" is recomputable from
                // the profile, which has not changed.
                try {
                    const scored = enforcement.scoreProfile(member, settings, {
                        correlation: suspicion.correlateJoin(guild.id, member.user, now),
                        now,
                    });
                    watch.setJoinScore(guild.id, member.id, scored.score, scored.tier);
                } catch (error) {
                    // A member the scorer chokes on is still worth watching.
                    logger.debug('[JOIN-GATE] Restore could not rescore a member', {
                        guildId: guild.id, userId: member.id, error: error.message,
                    });
                }
            }
        }
    }

    // ── The guard's counters ────────────────────────────────────────────
    if (settings.guard_enabled) {
        try {
            const logs = await guild.fetchAuditLogs({ limit: 50 });
            result.guard = guard.seed(guild.id, [...logs.entries.values()], settings, now);
        } catch (error) {
            // Missing View Audit Log, most likely. The guard's own diagnostics
            // already say so; this is not the place to complain twice.
            logger.debug('[JOIN-GATE] Restore could not read the audit log', {
                guildId: guild.id, error: error.message,
            });
        }
    }

    return result;
}

/**
 * Runs the restore for every guild the gate is enabled in.
 *
 * Never throws, and never lets one guild's failure stop the next: this is a
 * boot step, and the bot has to come up either way.
 */
async function restoreAll(client, guildSettings) {
    const totals = { watched: 0, joins: 0, guard: 0, guilds: 0 };

    for (const [guildId, settings] of guildSettings) {
        const guild = client.guilds.cache.get(guildId)
            ?? await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) continue;

        try {
            const result = await restoreGuild(guild, settings);
            if (result.skipped) continue;
            totals.guilds += 1;
            totals.watched += result.watched;
            totals.joins += result.joins;
            totals.guard += result.guard;
        } catch (error) {
            logger.error('[JOIN-GATE] Restore failed', { guildId, error: error.message });
        }
    }

    if (totals.watched || totals.joins || totals.guard) {
        logger.info('[JOIN-GATE] Short-term memory restored', totals);
    }
    return totals;
}

module.exports = {
    restoreGuild,
    restoreAll,
    horizonMs,
};
