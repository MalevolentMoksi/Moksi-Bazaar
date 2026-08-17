// tests/commandScope.test.js
//
// /sleepy is an in-joke leaderboard for one server. It spent a while retired,
// which took it away from the server that still wanted it; it is back with the
// scope it should have had, and this pins the three places that scope has to
// hold: the payload each guild is registered, the payload a brand new guild is
// registered, and the command list the persona is handed.
//
// The last one is the one worth a test on its own. botCapabilities() tells the
// bot the list is exhaustive, so an unscoped list would have it offering a
// leaderboard nobody in that server can click.

const fs = require('fs');
const path = require('path');

const { guildAllowlist, scopeTo, commandNamesFor } = require('../src/utils/commandScope');
const { SLEEPY_GUILDS } = require('../src/utils/constants');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const SLEEPY_GUILD = '1347922267853553806';
/** A payload shaped like the registration JSON, minus everything unread. */
const PAYLOAD = [{ name: 'bj' }, { name: 'sleepy' }, { name: 'caption' }];
const SCOPES = new Map([['sleepy', [SLEEPY_GUILD]]]);

describe('a command that belongs to one server', () => {
    test('/sleepy is offered again, and only there', () => {
        const sleepy = require('../src/commands/tools/sleepy');
        expect(sleepy.retired).toBeUndefined();
        expect(typeof sleepy.execute).toBe('function');
        expect(sleepy.guilds).toEqual([SLEEPY_GUILD]);
        // One list, two jobs: the registration scope and the runtime check.
        expect(SLEEPY_GUILDS).toEqual([SLEEPY_GUILD]);
    });

    test('every other guild is registered a payload without it', () => {
        expect(scopeTo(PAYLOAD, SCOPES, SLEEPY_GUILD).map(c => c.name))
            .toEqual(['bj', 'sleepy', 'caption']);
        expect(scopeTo(PAYLOAD, SCOPES, '1217066705537204325').map(c => c.name))
            .toEqual(['bj', 'caption']);
    });

    test('a DM sees the unscoped commands and nothing else', () => {
        // guildId is undefined off a guild, and "no guild" must never read as
        // "every guild".
        expect(scopeTo(PAYLOAD, SCOPES, undefined).map(c => c.name)).toEqual(['bj', 'caption']);
        expect(scopeTo(PAYLOAD, SCOPES, null).map(c => c.name)).toEqual(['bj', 'caption']);
    });

    test('ids compare as strings, so a numeric literal still matches', () => {
        // Snowflakes overflow a JS number, but nothing stops someone writing
        // one bare in a `guilds` array and losing precision quietly.
        expect(guildAllowlist({ guilds: [12345] })).toEqual(['12345']);
        expect(scopeTo(PAYLOAD, new Map([['sleepy', ['7']]]), 7).map(c => c.name))
            .toEqual(['bj', 'sleepy', 'caption']);
    });

    test('no scopes at all means the payload passes through untouched', () => {
        expect(scopeTo(PAYLOAD, new Map(), SLEEPY_GUILD)).toHaveLength(3);
        expect(scopeTo(PAYLOAD, null, SLEEPY_GUILD)).toHaveLength(3);
        expect(scopeTo(PAYLOAD, undefined, undefined)).toHaveLength(3);
    });

    test('a malformed allowlist means everywhere, not nowhere', () => {
        // Failing open leaves a mistake visible where someone will notice it;
        // failing closed makes a command silently cease to exist.
        expect(guildAllowlist({})).toBeNull();
        expect(guildAllowlist({ guilds: [] })).toBeNull();
        expect(guildAllowlist({ guilds: ['', '  '] })).toBeNull();
        expect(guildAllowlist({ guilds: 'one-id' })).toBeNull();
        expect(guildAllowlist(null)).toBeNull();
    });
});

describe('the payload each guild is registered', () => {
    const loader = read('src/functions/handlers/handleCommands.js');

    test('the loader reads the allowlist off the command it just loaded', () => {
        expect(loader).toMatch(/const only = guildAllowlist\(cmd\);/);
        expect(loader).toMatch(/if \(only\) scopes\.set\(cmd\.data\.name, only\);/);
    });

    test('the skip-if-unchanged hash follows the guild body, not the whole list', () => {
        // Hashing the unscoped payload once would mean the guild that gains or
        // loses a scoped command sees no change and never gets the write, so
        // the scoping would take effect only on the next unrelated deploy.
        expect(loader).toMatch(/const body = scopeTo\(publishable, scopes, guild\.id\);/);
        expect(loader).toMatch(/const hash = hashCommands\(body\);/);
        expect(loader).not.toMatch(/payloadHash/);
        expect(loader).toMatch(/setSpeakConfigValue\(`\$\{HASH_KEY_PREFIX\}\$\{guild\.id\}`, hash\)/);
    });

    test('a guild joined later is scoped the same way', () => {
        const onCreate = read('src/events/client/guildCreate.js');
        expect(onCreate).toMatch(/scopeTo\(commandArray, client\.commandScopes, guild\.id\)/);
        expect(onCreate).toMatch(/\{ body \}/);
        // The emptiness guard stays on the unscoped list: nothing loaded is a
        // broken deploy, nothing scoped here is Tuesday.
        expect(onCreate).toMatch(/!commandArray \|\| commandArray\.length === 0/);
    });

    test('the scopes map is published on the client for the other two readers', () => {
        expect(loader).toMatch(/client\.commandScopes = scopes;/);
    });
});

describe('the persona is told only what it can run here', () => {
    test('speak.js asks for this guild\'s names', () => {
        expect(read('src/commands/tools/speak.js'))
            .toContain('botCapabilities(commandNamesFor(interaction.client, interaction.guildId))');
    });

    test('commandNamesFor drops a command scoped to somewhere else', () => {
        const client = {
            commands: new Map([['bj', {}], ['sleepy', {}], ['caption', {}]]),
            commandScopes: SCOPES,
        };
        expect(commandNamesFor(client, SLEEPY_GUILD)).toEqual(['bj', 'sleepy', 'caption']);
        expect(commandNamesFor(client, '1217066705537204325')).toEqual(['bj', 'caption']);
    });

    test('it survives a client that has not finished loading', () => {
        expect(commandNamesFor(undefined, SLEEPY_GUILD)).toEqual([]);
        expect(commandNamesFor({}, SLEEPY_GUILD)).toEqual([]);
        // Scopes arrive with the loader; before that, everything loaded counts.
        expect(commandNamesFor({ commands: new Map([['bj', {}]]) }, undefined)).toEqual(['bj']);
    });
});

describe('scoping is visibility, not access control', () => {
    test('/sleepy still checks the guild when it runs', () => {
        // A registration outlives the deploy that made it: Discord keeps
        // offering whatever it was last given, so the command cannot assume
        // the picker did the filtering.
        const src = read('src/commands/tools/sleepy.js');
        expect(src).toMatch(/SLEEPY_GUILDS\.includes\(guildId\)/);
        expect(src).toMatch(/only works in the sleepytime server/);
    });
});
