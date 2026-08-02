// src/utils/joinGate/invites.js
/**
 * Join Gate: invite attribution.
 *
 * Discord never tells you which invite a member used. The standard trick is to
 * cache every invite's use count and diff it when someone joins: whichever code
 * went up by one is the one they came through.
 *
 * That buys two things. Attribution ("who keeps inviting these accounts") and,
 * more usefully, flood detection: one leaked code minting thirty joins in a
 * few minutes is a far better raid signal than the joins themselves.
 *
 * Entirely best-effort. Without Manage Server the invite list cannot be read,
 * in which case this quietly contributes nothing rather than failing joins.
 */

const { PermissionFlagsBits } = require('discord.js');
const logger = require('../logger');

/** guildId -> Map<code, {uses, inviterId, inviterTag}> */
const cache = new Map();
/** guildId -> Map<code, number[]> of recent join timestamps per code. */
const recentUses = new Map();

const FLOOD_WINDOW_MS = 5 * 60_000;
const FLOOD_THRESHOLD = 10;

function canRead(guild) {
    const me = guild.members.me;
    return Boolean(me?.permissions.has(PermissionFlagsBits.ManageGuild));
}

/**
 * Refreshes the cached use counts for a guild.
 * @returns {Promise<boolean>} whether the cache is usable
 */
async function syncGuild(guild) {
    if (!canRead(guild)) {
        cache.delete(guild.id);
        return false;
    }
    try {
        const invites = await guild.invites.fetch();
        const snapshot = new Map();
        for (const invite of invites.values()) {
            snapshot.set(invite.code, {
                uses: invite.uses ?? 0,
                inviterId: invite.inviter?.id ?? null,
                inviterTag: invite.inviter?.username ?? null,
            });
        }
        cache.set(guild.id, snapshot);
        return true;
    } catch (error) {
        logger.warn('[JOIN-GATE] Invite sync failed', { guildId: guild.id, error: error.message });
        cache.delete(guild.id);
        return false;
    }
}

async function syncAll(client) {
    let synced = 0;
    for (const guild of client.guilds.cache.values()) {
        if (await syncGuild(guild)) synced++;
    }
    if (synced > 0) logger.info('[JOIN-GATE] Invite cache primed', { guilds: synced });
    return synced;
}

function noteUse(guildId, code, now = Date.now()) {
    let perGuild = recentUses.get(guildId);
    if (!perGuild) { perGuild = new Map(); recentUses.set(guildId, perGuild); }

    const cutoff = now - FLOOD_WINDOW_MS;
    const times = (perGuild.get(code) ?? []).filter(t => t >= cutoff);
    times.push(now);
    perGuild.set(code, times);
    return times.length;
}

/**
 * Works out which invite a joining member used, and whether that code is
 * currently flooding.
 *
 * Must be awaited before anything else re-reads the invite list, since it
 * re-syncs the cache as a side effect.
 *
 * @returns {Promise<{code: string|null, inviterId: string|null, inviterTag: string|null,
 *                    usesInWindow: number, flooding: boolean, known: boolean}>}
 */
async function resolveJoin(guild, now = Date.now()) {
    const unknown = { code: null, inviterId: null, inviterTag: null, usesInWindow: 0, flooding: false, known: false };
    if (!canRead(guild)) return unknown;

    const before = cache.get(guild.id);

    let invites;
    try {
        invites = await guild.invites.fetch();
    } catch (error) {
        logger.debug('[JOIN-GATE] Invite fetch on join failed', { guildId: guild.id, error: error.message });
        return unknown;
    }

    const after = new Map();
    let used = null;
    for (const invite of invites.values()) {
        const uses = invite.uses ?? 0;
        after.set(invite.code, {
            uses,
            inviterId: invite.inviter?.id ?? null,
            inviterTag: invite.inviter?.username ?? null,
        });
        const previous = before?.get(invite.code);
        if (previous && uses > previous.uses && !used) {
            used = { code: invite.code, inviterId: invite.inviter?.id ?? null, inviterTag: invite.inviter?.username ?? null };
        }
    }
    cache.set(guild.id, after);

    // No prior snapshot, a vanity URL, or a one-use invite that deleted itself
    // on use: all indistinguishable from here, so report honestly as unknown.
    if (!used) return unknown;

    const usesInWindow = noteUse(guild.id, used.code, now);
    return {
        ...used,
        usesInWindow,
        flooding: usesInWindow >= FLOOD_THRESHOLD,
        known: true,
    };
}

function reset(guildId) {
    if (guildId) { cache.delete(guildId); recentUses.delete(guildId); }
    else { cache.clear(); recentUses.clear(); }
}

module.exports = {
    FLOOD_WINDOW_MS,
    FLOOD_THRESHOLD,
    syncGuild,
    syncAll,
    resolveJoin,
    canRead,
    reset,
};
