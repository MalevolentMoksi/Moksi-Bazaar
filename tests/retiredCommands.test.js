// tests/retiredCommands.test.js
//
// A command can outlive its reason. /sleepy was an in-joke in a server that is
// no longer alive, and deleting the file would take the tallies and the code
// with it for what is really a display decision.
//
// `retired: true` withholds it from registration AND from client.commands,
// which matters more than it sounds: client.commands is what tells the persona
// which commands the bot has, and the system prompt says outright that the
// list is exhaustive. A command left loaded but unregistered would produce a
// bot that offers something Discord will not let anyone run.
//
// Checked at the source, like the other wiring guarantees in this suite: the
// loader walks the real commands directory and starts real schedulers, so
// driving it in a test costs more than it proves.

const fs = require('fs');
const path = require('path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('a retired command is withheld, not deleted', () => {
    const loader = read('src/functions/handlers/handleCommands.js');

    test('/sleepy declares itself retired and still exports a working command', () => {
        const sleepy = require('../src/commands/tools/sleepy');
        expect(sleepy.retired).toBe(true);
        // Kept whole on purpose: bringing it back is deleting one line.
        expect(typeof sleepy.execute).toBe('function');
        expect(sleepy.data.name).toBe('sleepy');
    });

    test('the loader skips it before it can reach either list', () => {
        // The order is the whole point: the guard sits above the two writes,
        // so a retired command joins neither the registration payload nor
        // client.commands.
        const guard = loader.indexOf('if (cmd.retired)');
        const registers = loader.indexOf('client.commands.set(cmd.data.name, cmd)');
        const publishes = loader.indexOf('commands.push(cmd.data.toJSON())');
        expect(guard).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(registers);
        expect(guard).toBeLessThan(publishes);
    });

    test('it does not count as a file that failed to load', () => {
        // "exported no usable command" is the loader's cry for help about a
        // broken file. A deliberately withheld one is not that, and reporting
        // it as such would bury the real failures.
        expect(loader).toMatch(/if \(cmd\.retired\) \{[\s\S]{0,120}usable\+\+;/);
    });

    test('nothing else in the tree is retired by accident', () => {
        const dir = path.join(__dirname, '..', 'src', 'commands');
        const retired = [];
        for (const category of fs.readdirSync(dir)) {
            const categoryPath = path.join(dir, category);
            if (!fs.lstatSync(categoryPath).isDirectory()) continue;
            for (const file of fs.readdirSync(categoryPath).filter(f => f.endsWith('.js'))) {
                if (/^\s*retired:\s*true/m.test(fs.readFileSync(path.join(categoryPath, file), 'utf8'))) {
                    retired.push(`${category}/${file}`);
                }
            }
        }
        expect(retired).toEqual(['tools/sleepy.js']);
    });
});
