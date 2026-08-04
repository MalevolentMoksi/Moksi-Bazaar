// src/utils/backup.js
/**
 * Database backup.
 *
 * Everything this bot is lives in one Postgres instance: balances, the whole
 * relationship history, distilled profiles, warns, the join gate's ledger of
 * who was banned and when. None of it is derivable from anything else, and
 * until now none of it was ever exported anywhere.
 *
 * The dump is a gzipped JSON document rather than pg_dump output, because the
 * container has no postgres client binaries and pulling one in for this is not
 * worth it. scripts/restore-backup.js reads the format back.
 *
 * Nothing runs until a destination channel is set (`/backup here`), so this is
 * off by default like every other addition in this pass.
 */

const zlib = require('zlib');
const { promisify } = require('util');
const { AttachmentBuilder } = require('discord.js');
const { pool, getSpeakConfigValue, setSpeakConfigValue } = require('./db');
const logger = require('./logger');

const gzip = promisify(zlib.gzip);

const CHANNEL_KEY = 'backup_channel_id';
const LAST_RUN_KEY = 'backup_last_run_ms';

/**
 * Regenerable on demand and by far the largest table in the database; a backup
 * whose bulk is recomputable thumbnails is a backup that stops fitting.
 */
const SKIP_TABLES = new Set(['media_cache']);
/** A single table past this is a runaway, not data worth restoring verbatim. */
const MAX_ROWS_PER_TABLE = 50_000;
/** Discord's default upload cap is 10 MiB; leave room for the multipart envelope. */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * The check interval, not the backup interval. A plain weekly setInterval
 * would never once fire on a bot that redeploys every few days, so due-ness is
 * derived from a stored timestamp and merely polled.
 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let timer = null;

// ── Dump construction ───────────────────────────────────────────────────────

async function listTables() {
    const { rows } = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
         ORDER BY table_name`
    );
    return rows.map(r => r.table_name).filter(t => !SKIP_TABLES.has(t));
}

/**
 * Serializes every public table into one JSON document.
 *
 * Discovery is dynamic on purpose: a hardcoded table list silently stops
 * backing up whatever gets added next, and the failure mode of that is only
 * discovered on the day it matters.
 *
 * @returns {Promise<{buffer: Buffer, meta: object}>}
 */
async function buildBackup() {
    const tables = await listTables();
    const data = {};
    const counts = {};
    const truncated = [];

    for (const table of tables) {
        // Identifiers cannot be parameterized; these come from information_schema
        // rather than from user input, and are quoted regardless.
        const { rows } = await pool.query(
            `SELECT * FROM "${table.replace(/"/g, '""')}" LIMIT ${MAX_ROWS_PER_TABLE + 1}`
        );
        if (rows.length > MAX_ROWS_PER_TABLE) {
            rows.length = MAX_ROWS_PER_TABLE;
            truncated.push(table);
        }
        data[table] = rows;
        counts[table] = rows.length;
    }

    const doc = {
        format: 'moksis-bazaar-backup',
        version: 1,
        createdAt: new Date().toISOString(),
        skipped: [...SKIP_TABLES],
        truncated,
        counts,
        data,
    };

    const buffer = await gzip(Buffer.from(JSON.stringify(doc), 'utf8'));
    const totalRows = Object.values(counts).reduce((sum, n) => sum + n, 0);

    return {
        buffer,
        meta: { tables: tables.length, totalRows, counts, truncated, bytes: buffer.length },
    };
}

function backupFilename(date = new Date()) {
    return `bazaar-backup-${date.toISOString().slice(0, 10)}.json.gz`;
}

/**
 * Builds a dump and posts it to a channel.
 * @returns {Promise<{ok: boolean, meta?: object, error?: string}>}
 */
async function sendBackup(client, channelId) {
    try {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased?.()) {
            return { ok: false, error: 'The backup channel is gone or is not a text channel.' };
        }

        const { buffer, meta } = await buildBackup();
        if (buffer.length > MAX_ATTACHMENT_BYTES) {
            return {
                ok: false,
                error: `Dump is ${(buffer.length / 1048576).toFixed(1)} MB, over the `
                    + `${(MAX_ATTACHMENT_BYTES / 1048576).toFixed(0)} MB upload limit. `
                    + 'Nothing was posted.',
                meta,
            };
        }

        const lines = Object.entries(meta.counts)
            .sort((a, b) => b[1] - a[1])
            .map(([t, n]) => `${t}: ${n.toLocaleString()}`)
            .join(', ');

        await channel.send({
            content: `**Database backup** ${new Date().toISOString().slice(0, 10)}\n`
                + `${meta.totalRows.toLocaleString()} rows across ${meta.tables} tables, `
                + `${(meta.bytes / 1024).toFixed(0)} KB gzipped.\n`
                + `-# ${lines}`
                + (meta.truncated.length ? `\n-# truncated: ${meta.truncated.join(', ')}` : ''),
            files: [new AttachmentBuilder(buffer, { name: backupFilename() })],
        });

        return { ok: true, meta };
    } catch (error) {
        logger.error('[BACKUP] Failed', { error: error.message, stack: error.stack });
        return { ok: false, error: error.message };
    }
}

// ── Scheduling ──────────────────────────────────────────────────────────────

async function getBackupChannelId() {
    return getSpeakConfigValue(CHANNEL_KEY, null);
}

async function setBackupChannelId(channelId) {
    await setSpeakConfigValue(CHANNEL_KEY, channelId);
}

async function checkAndRun(client) {
    const channelId = await getBackupChannelId();
    if (!channelId) return;

    const last = Number(await getSpeakConfigValue(LAST_RUN_KEY, 0)) || 0;
    if (Date.now() - last < WEEK_MS) return;

    // Stamped before the attempt, not after. A dump that fails for a structural
    // reason (too large, channel deleted) would otherwise retry every six hours
    // forever, and the owner would learn about it as a flood.
    await setSpeakConfigValue(LAST_RUN_KEY, Date.now());

    const result = await sendBackup(client, channelId);
    if (result.ok) {
        logger.info('[BACKUP] Weekly backup posted', result.meta);
    } else {
        logger.warn('[BACKUP] Weekly backup did not post', { error: result.error });
    }

    await sendStructureSnapshots(client, channelId);
}

/**
 * Rides the same weekly slot as the database dump.
 *
 * The dump holds everything this bot knows and nothing about the server it runs
 * in. A snapshot is the other half: if the channel tree were deleted tomorrow,
 * the dump would restore the balances of people who could no longer see a
 * channel to spend them in.
 *
 * Required lazily, and failure is swallowed per guild: a snapshot is insurance,
 * and insurance must never be the reason the actual backup run falls over.
 */
async function sendStructureSnapshots(client, channelId) {
    let snapshot;
    let getSettings;
    try {
        ({ sendSnapshot: snapshot } = require('./joinGate/snapshot'));
        ({ getSettings } = require('./joinGate/config'));
    } catch (error) {
        logger.warn('[SNAPSHOT] Module unavailable', { error: error.message });
        return;
    }

    for (const guild of client.guilds.cache.values()) {
        try {
            const settings = await getSettings(guild.id);
            if (!settings.snapshot_enabled) continue;

            const result = await snapshot(guild, settings.guard_channel_id || channelId);
            if (result.ok) logger.info('[SNAPSHOT] Posted', { guildId: guild.id, ...result.meta });
            else logger.warn('[SNAPSHOT] Did not post', { guildId: guild.id, error: result.error });
        } catch (error) {
            logger.warn('[SNAPSHOT] Guild failed', { guildId: guild.id, error: error.message });
        }
    }
}

function startBackupScheduler(client) {
    if (timer) return;
    const tick = () => {
        checkAndRun(client).catch(e => logger.error('[BACKUP] Scheduler threw', { error: e.message }));
    };
    timer = setInterval(tick, CHECK_INTERVAL_MS);
    timer.unref();
    // One check shortly after boot, so a bot that only ever runs for a few days
    // between deploys still produces a backup.
    const first = setTimeout(tick, 5 * 60 * 1000);
    first.unref();
}

function stopBackupScheduler() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
}

module.exports = {
    buildBackup,
    sendBackup,
    backupFilename,
    getBackupChannelId,
    setBackupChannelId,
    startBackupScheduler,
    stopBackupScheduler,
    CHANNEL_KEY,
    LAST_RUN_KEY,
    MAX_ATTACHMENT_BYTES,
};
