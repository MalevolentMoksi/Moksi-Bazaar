// src/utils/joinGate/snapshot.js
/**
 * A photograph of the server's shape.
 *
 * The existing backup dumps the database: balances, warns, settings, everything
 * this bot knows. It does not contain one byte about the server itself. If
 * somebody deleted the channel tree tomorrow, nothing here would help rebuild
 * it, and Discord offers no undo.
 *
 * CAPTURE ONLY. There is deliberately no restore path in the bot. Recreating a
 * server from a file is destructive, hard to get right, and exactly the sort of
 * thing that should not live one mis-click away inside a panel. The snapshot is
 * a JSON file posted to a channel; putting it back is a human decision made
 * with the file in hand.
 *
 * Reads nothing private: channel names and structure, role names and
 * permissions, who holds which role, and the server's own settings. No message
 * content, ever.
 */

const { AttachmentBuilder } = require('discord.js');
const zlib = require('zlib');
const { promisify } = require('util');
const logger = require('../logger');

const gzip = promisify(zlib.gzip);

/** Discord's upload ceiling for a bot without boosts, with headroom. */
const MAX_ATTACHMENT_BYTES = 7.5 * 1024 * 1024;

function overwritesOf(channel) {
    return [...(channel.permissionOverwrites?.cache?.values() ?? [])].map(o => ({
        id: o.id,
        type: o.type,
        allow: String(o.allow?.bitfield ?? 0),
        deny: String(o.deny?.bitfield ?? 0),
    }));
}

/**
 * Builds the snapshot.
 *
 * @returns {Promise<{buffer: Buffer, meta: object}>}
 */
async function buildSnapshot(guild) {
    // Members are needed for role assignments. This is the one expensive call,
    // and it is why the snapshot runs weekly rather than hourly.
    const members = await guild.members.fetch();

    const channels = [...guild.channels.cache.values()]
        .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
        .map(c => ({
            id: c.id,
            name: c.name,
            type: c.type,
            parentId: c.parentId ?? null,
            position: c.rawPosition ?? null,
            topic: c.topic ?? null,
            nsfw: c.nsfw ?? false,
            rateLimitPerUser: c.rateLimitPerUser ?? null,
            overwrites: overwritesOf(c),
        }));

    const roles = [...guild.roles.cache.values()]
        .sort((a, b) => b.position - a.position)
        .map(r => ({
            id: r.id,
            name: r.name,
            color: r.color,
            hoist: r.hoist,
            position: r.position,
            permissions: String(r.permissions?.bitfield ?? 0),
            mentionable: r.mentionable,
            managed: r.managed,
        }));

    // Only non-default roles are worth storing: @everyone is on all 1,600 and
    // storing it would double the file for no information.
    const everyoneId = guild.id;
    const memberRoles = [];
    for (const member of members.values()) {
        const held = [...member.roles.cache.keys()].filter(id => id !== everyoneId);
        if (held.length === 0) continue;
        memberRoles.push({ id: member.id, tag: member.user?.username ?? null, roles: held });
    }

    const emojis = [...guild.emojis.cache.values()].map(e => ({
        id: e.id, name: e.name, animated: e.animated, url: e.imageURL?.() ?? null,
    }));
    const stickers = [...guild.stickers.cache.values()].map(s => ({
        id: s.id, name: s.name, description: s.description, url: s.url ?? null,
    }));

    const snapshot = {
        takenAt: new Date().toISOString(),
        guild: {
            id: guild.id,
            name: guild.name,
            iconURL: guild.iconURL?.() ?? null,
            bannerURL: guild.bannerURL?.() ?? null,
            vanityURLCode: guild.vanityURLCode ?? null,
            ownerId: guild.ownerId,
            verificationLevel: guild.verificationLevel,
            explicitContentFilter: guild.explicitContentFilter,
            defaultMessageNotifications: guild.defaultMessageNotifications,
            mfaLevel: guild.mfaLevel,
            afkChannelId: guild.afkChannelId ?? null,
            afkTimeout: guild.afkTimeout ?? null,
            systemChannelId: guild.systemChannelId ?? null,
            rulesChannelId: guild.rulesChannelId ?? null,
            publicUpdatesChannelId: guild.publicUpdatesChannelId ?? null,
            premiumTier: guild.premiumTier,
            features: guild.features ?? [],
            memberCount: guild.memberCount,
        },
        channels,
        roles,
        memberRoles,
        emojis,
        stickers,
    };

    const buffer = await gzip(Buffer.from(JSON.stringify(snapshot), 'utf8'));

    return {
        buffer,
        meta: {
            channels: channels.length,
            roles: roles.length,
            membersWithRoles: memberRoles.length,
            emojis: emojis.length,
            stickers: stickers.length,
            overwrites: channels.reduce((n, c) => n + c.overwrites.length, 0),
            bytes: buffer.length,
        },
    };
}

function snapshotFilename(guild, date = new Date()) {
    const safe = String(guild.name ?? 'server').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24);
    return `${safe}-structure-${date.toISOString().slice(0, 10)}.json.gz`;
}

/**
 * Where a snapshot should go, resolved in one place.
 *
 * There were two of these once, one for the weekly run and one for the button,
 * and they disagreed about the fallback. That is the worst kind of bug in a
 * backup: you press the button, watch the file arrive, and the scheduled copy
 * has been going somewhere else the whole time.
 */
function resolveChannel(settings, fallbackChannelId = null) {
    return settings?.guard_channel_id || settings?.log_channel_id || fallbackChannelId || null;
}

/**
 * Builds a snapshot and delivers it.
 *
 * Delivered to a DM as well as a channel, and the DM is the copy that matters.
 * A snapshot stored in the server it is a snapshot OF does not survive the one
 * event it exists for: whoever deletes your channels deletes the backups with
 * them. A direct message is outside the server entirely.
 *
 * Built once and sent twice, because the expensive part is fetching 1,600
 * members and doing it again for the second destination would be silly.
 *
 * @returns {Promise<{ok: boolean, meta?: object, error?: string, sentTo?: string[]}>}
 */
async function sendSnapshot(guild, channelId, { dmUserId = null } = {}) {
    try {
        if (!channelId && !dmUserId) {
            return { ok: false, error: 'Nowhere to send it: no channel set and no owner to DM.' };
        }

        const { buffer, meta } = await buildSnapshot(guild);
        if (buffer.length > MAX_ATTACHMENT_BYTES) {
            return {
                ok: false,
                error: `Snapshot is ${(buffer.length / 1048576).toFixed(1)} MB, over the upload limit.`,
                meta,
            };
        }

        const payload = {
            content: `**Server structure snapshot** ${new Date().toISOString().slice(0, 10)} `
                + `(${guild.name})\n`
                + `${meta.channels} channels, ${meta.roles} roles, ${meta.overwrites} permission overwrites, `
                + `${meta.membersWithRoles} members with roles, ${(meta.bytes / 1024).toFixed(0)} KB gzipped.\n`
                + '-# Capture only. There is no restore button anywhere; putting this back is a '
                + 'decision made by hand, with the file open.',
            files: [new AttachmentBuilder(buffer, { name: snapshotFilename(guild) })],
        };

        const sentTo = [];
        const failures = [];

        if (channelId) {
            const channel = guild.channels.cache.get(channelId)
                ?? await guild.channels.fetch(channelId).catch(() => null);
            if (channel?.isTextBased?.()) {
                try {
                    await channel.send(payload);
                    sentTo.push('channel');
                } catch (error) {
                    failures.push(`channel: ${error.message}`);
                }
            } else {
                failures.push('channel: gone, or not a text channel');
            }
        }

        if (dmUserId) {
            try {
                const owner = await guild.client.users.fetch(dmUserId);
                await owner.send(payload);
                sentTo.push('DM');
            } catch (error) {
                failures.push(`DM: ${error.message}`);
            }
        }

        if (sentTo.length === 0) {
            return { ok: false, error: failures.join('; ') || 'nothing was sent', meta };
        }
        return { ok: true, meta, sentTo, warning: failures.length ? failures.join('; ') : null };
    } catch (error) {
        logger.error('[SNAPSHOT] Failed', { error: error.message, stack: error.stack });
        return { ok: false, error: error.message };
    }
}

module.exports = {
    buildSnapshot, sendSnapshot, snapshotFilename, resolveChannel, MAX_ATTACHMENT_BYTES,
};
