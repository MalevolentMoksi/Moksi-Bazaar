#!/usr/bin/env node
// scripts/restore-backup.js
/**
 * Reads a dump produced by src/utils/backup.js back into a database.
 *
 * A backup nobody has ever restored is a rumour, so this is deliberately
 * boring and deliberately hard to fire by accident: it is a dry run unless you
 * pass --yes, and it will not delete anything unless you also pass --truncate.
 *
 *   node scripts/restore-backup.js dump.json.gz
 *   node scripts/restore-backup.js dump.json.gz --tables balances,warns --yes
 *   node scripts/restore-backup.js dump.json.gz --truncate --yes
 *
 * Without --truncate, existing rows win: every insert is ON CONFLICT DO
 * NOTHING, so this tops a database up rather than rewriting it. With
 * --truncate, each restored table is emptied first. Everything happens inside
 * one transaction; a failure anywhere leaves the database exactly as it was.
 */

require('dotenv').config();

const fs = require('fs');
const zlib = require('zlib');
const { Pool } = require('pg');

function parseArgs(argv) {
    const args = { file: null, tables: null, truncate: false, yes: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--truncate') args.truncate = true;
        else if (arg === '--yes') args.yes = true;
        else if (arg === '--tables') args.tables = new Set((argv[++i] || '').split(',').filter(Boolean));
        else if (!arg.startsWith('--') && !args.file) args.file = arg;
    }
    return args;
}

function readDump(file) {
    const raw = fs.readFileSync(file);
    const json = file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw;
    const doc = JSON.parse(json.toString('utf8'));
    if (doc.format !== 'moksis-bazaar-backup') {
        throw new Error(`Not a bazaar backup (format: ${doc.format ?? 'missing'})`);
    }
    return doc;
}

async function existingTables(pool) {
    const { rows } = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    return new Set(rows.map(r => r.table_name));
}

const quote = id => `"${id.replace(/"/g, '""')}"`;

async function insertRows(client, table, rows, truncate) {
    if (truncate) await client.query(`DELETE FROM ${quote(table)}`);
    if (rows.length === 0) return 0;

    const columns = Object.keys(rows[0]);
    const colSql = columns.map(quote).join(', ');
    let inserted = 0;

    // Chunked so a large table does not build one enormous statement, and so
    // the parameter count stays under Postgres' 65535 limit.
    const perStatement = Math.max(1, Math.floor(60000 / columns.length));
    for (let i = 0; i < rows.length; i += perStatement) {
        const chunk = rows.slice(i, i + perStatement);
        const values = [];
        const tuples = chunk.map(row => {
            const placeholders = columns.map(col => {
                values.push(row[col] === undefined ? null : row[col]);
                return `$${values.length}`;
            });
            return `(${placeholders.join(', ')})`;
        });
        const { rowCount } = await client.query(
            `INSERT INTO ${quote(table)} (${colSql}) VALUES ${tuples.join(', ')}
             ON CONFLICT DO NOTHING`,
            values
        );
        inserted += rowCount ?? 0;
    }
    return inserted;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.file) {
        console.error('Usage: node scripts/restore-backup.js <dump.json.gz> [--tables a,b] [--truncate] [--yes]');
        process.exit(1);
    }
    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL is not set. Refusing to guess where to restore.');
        process.exit(1);
    }

    const doc = readDump(args.file);
    console.log(`Dump taken ${doc.createdAt}, format v${doc.version}`);
    if (doc.truncated?.length) {
        console.log(`WARNING: these tables were already truncated when dumped: ${doc.truncated.join(', ')}`);
    }

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    });

    try {
        const present = await existingTables(pool);
        const wanted = Object.keys(doc.data)
            .filter(t => !args.tables || args.tables.has(t));

        const plan = [];
        for (const table of wanted) {
            const rows = doc.data[table] ?? [];
            if (!present.has(table)) {
                console.log(`  SKIP ${table} (${rows.length} rows): no such table in the target database`);
                continue;
            }
            plan.push({ table, rows });
            console.log(`  ${args.truncate ? 'REPLACE' : 'MERGE '} ${table}: ${rows.length} rows`);
        }

        if (!args.yes) {
            console.log('\nDry run. Nothing was written. Re-run with --yes to apply.');
            return;
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            let total = 0;
            for (const { table, rows } of plan) {
                const n = await insertRows(client, table, rows, args.truncate);
                total += n;
                console.log(`  wrote ${n}/${rows.length} into ${table}`);
            }
            await client.query('COMMIT');
            console.log(`\nDone. ${total} rows written.`);
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    } finally {
        await pool.end();
    }
}

main().catch(error => {
    console.error('Restore failed:', error.message);
    process.exit(1);
});
