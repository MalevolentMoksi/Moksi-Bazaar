// tests/commandDispatch.test.js
//
// A slash command that Discord offers but the bot cannot answer is the worst
// kind of failure: it looks exactly like a hung bot and names nothing. These
// pin the two places that now speak up instead, the dispatcher and the
// overview page.

const interactionCreate = require('../src/events/client/interactionCreate');
const overview = require('../src/web/pages/overview');
const { DEFAULTS } = require('../src/utils/joinGate/config');

function fakeInteraction(overrides = {}) {
    return {
        isChatInputCommand: () => true,
        isContextMenuCommand: () => false,
        isButton: () => false,
        isAnySelectMenu: () => false,
        commandName: 'ghost',
        user: { id: '619637817294848012' },
        guildId: 'g1',
        replied: false,
        deferred: false,
        reply: jest.fn(async () => {}),
        followUp: jest.fn(async () => {}),
        ...overrides,
    };
}

describe('dispatching a command the bot does not have', () => {
    test('answers instead of leaving the command spinning forever', async () => {
        const interaction = fakeInteraction();
        await interactionCreate.execute(interaction, { commands: new Map() });

        expect(interaction.reply).toHaveBeenCalledTimes(1);
        const said = interaction.reply.mock.calls[0][0].content;
        expect(said).toContain('/ghost');
        expect(said).toContain('not loaded');
    });

    test('a loaded command still just runs', async () => {
        const execute = jest.fn(async () => {});
        const interaction = fakeInteraction({ commandName: 'real' });
        await interactionCreate.execute(interaction, {
            commands: new Map([['real', { execute }]]),
        });

        expect(execute).toHaveBeenCalledTimes(1);
        expect(interaction.reply).not.toHaveBeenCalled();
    });

    test('a command that throws gets an error reply, not silence', async () => {
        const interaction = fakeInteraction({ commandName: 'boom' });
        await interactionCreate.execute(interaction, {
            commands: new Map([['boom', { execute: async () => { throw new Error('nope'); } }]]),
        });

        expect(interaction.reply).toHaveBeenCalledTimes(1);
        expect(interaction.reply.mock.calls[0][0].content).toContain('error');
    });

    test('a dead interaction token does not take the process with it', async () => {
        const interaction = fakeInteraction({
            reply: jest.fn(async () => { throw new Error('Unknown interaction'); }),
        });
        await expect(
            interactionCreate.execute(interaction, { commands: new Map() })
        ).resolves.toBeUndefined();
    });
});

describe('the overview reports load failures', () => {
    const model = {
        guildName: 'Bazaar', memberCount: 1624, uptimeMs: 3_600_000,
        settings: { ...DEFAULTS },
        watching: 0, modSummary: null, recentActions: [], unbans: [],
        commandCount: 30, commandFailures: [], now: Date.now(),
    };

    test('a clean boot says nothing about commands at all', () => {
        expect(overview.render(model).__raw).not.toContain('failed to load');
    });

    test('a failed file is named, with its error, and escaped', () => {
        const out = overview.render({
            ...model,
            commandFailures: [{ file: 'media/caption.js', error: 'Cannot find module <b>sharp</b>' }],
        }).__raw;
        expect(out).toContain('Commands that failed to load');
        expect(out).toContain('media/caption.js');
        expect(out).not.toContain('<b>sharp</b>');
        expect(out).toContain('&lt;b&gt;sharp&lt;/b&gt;');
    });

    test('no inline style attributes: the CSP blocks them', () => {
        const out = overview.render({
            ...model, commandFailures: [{ file: 'x.js', error: 'y' }],
        }).__raw;
        expect(out).not.toContain('style="');
    });
});
