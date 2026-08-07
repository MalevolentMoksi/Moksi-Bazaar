// tests/schemaOrder.test.js
//
// init() runs against a database that already exists, which makes it the one
// place in the codebase where writing correct-looking SQL is not enough.
//
// CREATE TABLE IF NOT EXISTS does NOTHING on a table that is already there.
// Not "adds the missing columns": nothing. So a column added to that block is
// invisible on every existing deployment, and anything in the same batch that
// touches it fails. init() has no catch, and ready.js exits the process when
// it rejects, so the failure is not a broken feature. It is the bot not
// booting, the health check timing out, and the deploy being rolled back.
//
// That happened on 2026-08-07 with mirrored_tweets.message_id. This is the
// check that would have caught it before the push.

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src/utils/db.js'), 'utf8');

/** Every `ALTER TABLE x ADD COLUMN [IF NOT EXISTS] col`, with where it sits. */
function addedColumns(sql) {
    const out = [];
    const re = /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi;
    for (const m of sql.matchAll(re)) {
        out.push({ table: m[1].toLowerCase(), column: m[2].toLowerCase(), at: m.index });
    }
    return out;
}

/** Every `CREATE INDEX ... ON x (a, b)`, with where it sits. */
function indexes(sql) {
    const out = [];
    const re = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s*\(([^)]*)\)/gi;
    for (const m of sql.matchAll(re)) {
        out.push({
            name: m[1],
            table: m[2].toLowerCase(),
            columns: m[3].split(',').map(c => c.trim().split(/\s+/)[0].toLowerCase()).filter(Boolean),
            at: m.index,
        });
    }
    return out;
}

describe('schema statements are ordered so an existing database survives them', () => {
    test('no index touches a migrated column before the migration adds it', () => {
        const added = addedColumns(source);
        const offences = [];

        for (const idx of indexes(source)) {
            for (const column of idx.columns) {
                const alter = added.find(a => a.table === idx.table && a.column === column);
                // A column that is ALSO added by ALTER is, by definition, one
                // that existing databases do not have from the CREATE. The
                // index is only safe on the far side of that ALTER.
                if (alter && idx.at < alter.at) {
                    offences.push(`${idx.name} indexes ${idx.table}.${column} before the ALTER that adds it`);
                }
            }
        }

        expect(offences).toEqual([]);
    });

    test('every column added to a CREATE TABLE also has an ALTER to back it', () => {
        // The same trap without an index: a column declared only in CREATE
        // TABLE IF NOT EXISTS simply never appears on a live database, and the
        // first query that selects it fails at runtime instead of at boot.
        // Verified against the one table young enough for this to bite.
        const create = source.match(/CREATE TABLE IF NOT EXISTS mirrored_tweets\s*\(([\s\S]*?)\)/i);
        expect(create).not.toBeNull();

        const declared = create[1]
            .split('\n')
            .map(l => l.trim().split(/\s+/)[0].toLowerCase())
            .filter(c => /^[a-z_]+$/.test(c));
        const altered = new Set(addedColumns(source).filter(a => a.table === 'mirrored_tweets').map(a => a.column));

        // tweet_id and posted_at_ms shipped with the table; message_id did not.
        expect(declared).toContain('message_id');
        expect(altered.has('message_id')).toBe(true);
    });

    test('init() has no catch of its own, which is why the above matters', () => {
        // Documenting the blast radius rather than the SQL: ready.js treats a
        // failed init as fatal and calls process.exit(1). If that ever gains a
        // catch, these checks stop being about uptime and this test should be
        // reconsidered rather than silently kept.
        const ready = fs.readFileSync(path.join(__dirname, '..', 'src/events/client/ready.js'), 'utf8');
        expect(ready).toMatch(/await init\(\)/);
        expect(ready).toMatch(/process\.exit\(1\)/);
    });
});
