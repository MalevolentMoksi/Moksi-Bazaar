#!/usr/bin/env node
// scripts/inspect-backup.js
/**
 * Reads a dump produced by src/utils/backup.js and prints what is inside it,
 * without touching a database.
 *
 * restore-backup.js is the right tool when you can reach the database from
 * wherever you are running it. On Railway the Postgres service resolves only
 * on the private network unless a TCP proxy is switched on, so from a laptop
 * `postgres.railway.internal` does not resolve and the restore cannot connect.
 * This exists for that case: it reads the dump locally and can emit the exact
 * SQL to paste into Railway's own query console.
 *
 *   node scripts/inspect-backup.js dump.json.gz
 *   node scripts/inspect-backup.js dump.json.gz --table sleepy_counts
 *   node scripts/inspect-backup.js dump.json.gz --table sleepy_counts --sql
 *
 * Read-only by construction. It opens a file and prints; it holds no
 * connection string and cannot write anywhere.
 */

const fs = require('fs');
const zlib = require('zlib');

function parseArgs(argv) {
    const args = { file: null, table: null, sql: false, where: null };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--sql') args.sql = true;
        else if (arg === '--table') args.table = argv[++i] || null;
        else if (arg === '--where') args.where = argv[++i] || null;
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

const quoteIdent = id => `"${String(id).replace(/"/g, '""')}"`;

/** Postgres literal. Numbers bare, null as NULL, everything else quoted. */
function quoteValue(value) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'object') return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
    return `'${String(value).replace(/'/g, "''")}'`;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.file) {
        console.error('Usage: node scripts/inspect-backup.js <dump.json.gz> [--table name] [--where col=value] [--sql]');
        process.exit(1);
    }

    const doc = readDump(args.file);
    console.log(`Dump taken ${doc.createdAt}, format v${doc.version}`);

    // No table named: just say what is in here and how big each part is.
    if (!args.table) {
        const names = Object.keys(doc.data).sort();
        console.log(`\n${names.length} tables:\n`);
        for (const name of names) {
            console.log(`  ${name.padEnd(32)} ${String(doc.data[name]?.length ?? 0).padStart(7)} rows`);
        }
        console.log('\nRe-run with --table <name> to see one, and --sql to emit restore statements.');
        return;
    }

    let rows = doc.data[args.table];
    if (!rows) {
        console.error(`No table "${args.table}" in this dump.`);
        process.exit(1);
    }

    if (args.where) {
        const [col, ...rest] = args.where.split('=');
        const want = rest.join('=');
        rows = rows.filter(r => String(r[col]) === want);
        console.log(`Filtered to ${col} = ${want}`);
    }

    console.log(`\n${args.table}: ${rows.length} rows\n`);
    if (rows.length === 0) return;

    if (!args.sql) {
        console.table(rows.slice(0, 100));
        if (rows.length > 100) console.log(`... and ${rows.length - 100} more`);
        console.log('\nRe-run with --sql to emit statements that put these values back.');
        return;
    }

    // Emitted as a single transaction, and as an upsert on the primary key so
    // pasting it twice is harmless. It restores the rows in the dump; it does
    // not delete rows created since, which is deliberate: this is for undoing
    // a bad write, not for rewinding a table wholesale.
    const columns = Object.keys(rows[0]);
    console.log('BEGIN;');
    for (const row of rows) {
        const cols = columns.map(quoteIdent).join(', ');
        const vals = columns.map(c => quoteValue(row[c])).join(', ');
        console.log(`INSERT INTO ${quoteIdent(args.table)} (${cols}) VALUES (${vals})`);
        console.log('  ON CONFLICT DO NOTHING;');
    }
    console.log('COMMIT;');
    console.log('');
    console.log('-- ON CONFLICT DO NOTHING means existing rows WIN. To overwrite a');
    console.log('-- corrupted value you must clear the row first, e.g.:');
    console.log(`--   DELETE FROM ${quoteIdent(args.table)} WHERE ...;`);
    console.log('-- Check the SELECT before you run the DELETE.');
}

try {
    main();
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
