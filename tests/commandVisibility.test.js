// tests/commandVisibility.test.js
//
// The command picker is the bot's main interface, and it was showing 1,600
// people the staff room. Eleven commands were owner-gated in code and none
// were hidden: /joingate, /warns, /lookup, /backup and the rest were all one
// keystroke away for anyone, and every one of them answered with a joke.
//
// Five described themselves as "secret", which in a searchable list of 42
// entries is not a wink, it is the most clickable string on the page.
//
// Read from source rather than by loading the modules: requiring every command
// file opens database handles and timers, and the claim being pinned is about
// what the file declares, not what it does at runtime.

const fs = require('fs');
const path = require('path');

const DIRS = ['src/commands/tools', 'src/commands/media'];

/** Everything each command file declares about itself, without loading it. */
function readCommands() {
    const out = [];
    for (const dir of DIRS) {
        for (const file of fs.readdirSync(path.join(__dirname, '..', dir))) {
            if (!file.endsWith('.js')) continue;
            const src = fs.readFileSync(path.join(__dirname, '..', dir, file), 'utf8');
            const start = src.indexOf('new SlashCommandBuilder()');
            if (start < 0) continue;
            const head = src.slice(start, start + 600);
            out.push({
                file: `${dir}/${file}`,
                name: (head.match(/\.setName\('([^']+)'\)/) || [])[1],
                description: (head.match(/\.setDescription\('([^']*)'\)/) || [])[1],
                // Anchored to the line start so the word appearing in a comment
                // does not read as the call being made.
                hidden: /^\s*\.setDefaultMemberPermissions/m.test(src),
                ownerGated: /if\s*\(\s*!\s*isOwner\s*\(/.test(src),
                retired: /retired:\s*true/.test(src),
            });
        }
    }
    return out;
}

const commands = readCommands();

/**
 * The one exception, deliberately. /casino is a public command with a single
 * owner-only subcommand, and default_member_permissions is per command: hiding
 * it would take the tables away from everybody.
 */
const PARTIALLY_GATED = ['casino'];

describe('what the picker offers', () => {
    test('there are commands to check', () => {
        expect(commands.length).toBeGreaterThan(30);
    });

    test('every owner-only command is hidden from everyone else', () => {
        const exposed = commands
            .filter(c => c.ownerGated && !c.hidden && !c.retired)
            .filter(c => !PARTIALLY_GATED.includes(c.name))
            .map(c => `/${c.name}`);

        expect(exposed).toEqual([]);
    });

    test('nothing describes itself as "secret"', () => {
        // Including subcommands, which cannot be hidden and so have to rely on
        // their description to say who they are for.
        const coy = [];
        for (const dir of DIRS) {
            for (const file of fs.readdirSync(path.join(__dirname, '..', dir))) {
                if (!file.endsWith('.js')) continue;
                const src = fs.readFileSync(path.join(__dirname, '..', dir, file), 'utf8');
                if (/\.setDescription\('secret'\)/.test(src)) coy.push(file);
            }
        }
        expect(coy).toEqual([]);
    });

    test('every command still has a description Discord will accept', () => {
        for (const c of commands) {
            expect(typeof c.description).toBe('string');
            expect(c.description.length).toBeGreaterThan(0);
            // Discord rejects the whole registration payload over this.
            expect(c.description.length).toBeLessThanOrEqual(100);
        }
    });
});

describe('hiding is not access control', () => {
    // The flag only decides who SEES the command. A server admin can re-grant
    // it per guild under Integrations, so if the isOwner check ever went away
    // the hiding would be the only thing left, and it is not enough.
    test('every hidden owner command still checks isOwner itself', () => {
        const hiddenOwnerCommands = commands.filter(c => c.hidden && c.ownerGated);
        expect(hiddenOwnerCommands.length).toBeGreaterThanOrEqual(10);

        for (const c of hiddenOwnerCommands) {
            const src = fs.readFileSync(path.join(__dirname, '..', c.file), 'utf8');
            expect(src).toMatch(/if\s*\(\s*!\s*isOwner\s*\(/);
        }
    });

    // Administrator was the original objection to doing this at all: it would
    // hide the panel from the owner in any server where they are not an admin,
    // locking the one person allowed to use it out of it.
    test('the flag is Manage Server, never Administrator', () => {
        for (const c of commands.filter(x => x.hidden)) {
            const src = fs.readFileSync(path.join(__dirname, '..', c.file), 'utf8');
            const flags = [...src.matchAll(/setDefaultMemberPermissions\(PermissionFlagsBits\.(\w+)\)/g)]
                .map(m => m[1]);
            expect(flags).not.toContain('Administrator');
        }
    });

    test('every file using the flag actually imports it', () => {
        for (const c of commands.filter(x => x.hidden)) {
            const src = fs.readFileSync(path.join(__dirname, '..', c.file), 'utf8');
            expect(src).toMatch(/PermissionFlagsBits[^=]*\} = require\('discord\.js'\)|PermissionFlagsBits,/);
        }
    });
});
