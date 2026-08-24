// tests/sleepySet.test.js
//
// The command that exists so nobody has to write SQL for this again.
//
// The leaderboard once showed five different people on exactly 16, which is
// what `UPDATE sleepy_counts SET count = 16` does when the WHERE clause is
// missing. Nothing in the bot could have caused it: /sleepy only ever moved
// one row by one. Somebody went to the database by hand because setting an
// exact number was the one thing the command could not do.
//
// So the shape of `set` is the point. It writes one row, addressed by primary
// key, bounded by the option spec, and it reports what it replaced.

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'commands', 'tools', 'sleepy.js'), 'utf8');
const command = require('../src/commands/tools/sleepy.js');
const json = command.data.toJSON();
const setSub = json.options.find(o => o.name === 'set');

describe('the subcommand exists and is shaped safely', () => {
    test('it takes a user and an integer count', () => {
        expect(setSub).toBeDefined();
        const names = setSub.options.map(o => o.name);
        expect(names).toEqual(['user', 'count']);
        expect(setSub.options.every(o => o.required)).toBe(true);
    });

    test('the count is bounded by Discord itself, before it reaches the database', () => {
        const count = setSub.options.find(o => o.name === 'count');
        expect(count.min_value).toBe(0);
        expect(count.max_value).toBeGreaterThan(0);
        // A ceiling that exists is the whole point; an absurd one is not a
        // ceiling. The real leaderboard lives in the tens.
        expect(count.max_value).toBeLessThanOrEqual(100_000);
    });

    test('add and remove stay open, and take no count at all', () => {
        for (const name of ['add', 'remove']) {
            const sub = json.options.find(o => o.name === name);
            expect(sub.options.map(o => o.name)).toEqual(['user']);
        }
    });
});

describe('every write is addressed to exactly one row', () => {
    // The failure being guarded against is an UPDATE that matched every row.
    test('no statement in the file can touch more than one member', () => {
        const statements = source.match(/(INSERT INTO|UPDATE|DELETE FROM) sleepy_counts[\s\S]*?`/g) ?? [];
        expect(statements.length).toBeGreaterThanOrEqual(3);
        for (const statement of statements) {
            const scoped = /WHERE guild_id = \$1 AND user_id = \$2/.test(statement)
                || /ON CONFLICT \(guild_id, user_id\)/.test(statement);
            expect(scoped).toBe(true);
        }
    });

    // The exact bug class, stated directly: an UPDATE or DELETE with no WHERE
    // at all. Postgres runs that happily against every row in the table and
    // reports success, which is why the leaderboard broke without an error.
    test('no UPDATE or DELETE on the table is missing its WHERE', () => {
        const mutations = source.match(/(?:UPDATE|DELETE FROM) sleepy_counts[\s\S]*?`/g) ?? [];
        expect(mutations.length).toBeGreaterThanOrEqual(1);
        for (const statement of mutations) {
            expect(statement).toMatch(/WHERE/);
        }
    });
});

describe('owner only, unlike the rest of the command', () => {
    test('set checks isOwner', () => {
        const branch = source.slice(source.indexOf("if (sub === 'set')"), source.indexOf("if (sub === 'leaderboard')"));
        expect(branch).toMatch(/isOwner\(interaction\.user\.id\)/);
    });

    test('add and remove do not, deliberately', () => {
        const branch = source.slice(source.indexOf("if (sub === 'add' || sub === 'remove')"), source.indexOf("if (sub === 'set')"));
        expect(branch).not.toMatch(/isOwner/);
    });
});

describe('a mistake is visible immediately', () => {
    test('the reply carries the old value as well as the new one', () => {
        const branch = source.slice(source.indexOf("if (sub === 'set')"), source.indexOf("if (sub === 'leaderboard')"));
        expect(branch).toMatch(/previous/);
        // Both numbers in one line, so a wrong set reads wrong on sight.
        expect(branch).toMatch(/\$\{previous\}[\s\S]{0,40}\$\{count\}/);
    });
});
