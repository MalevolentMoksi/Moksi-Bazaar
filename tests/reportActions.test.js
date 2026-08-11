// tests/reportActions.test.js
//
// The buttons on a suspicion report are the first components in this bot that
// have to survive their own collector: the panel sits in a log channel and is
// clicked days later, after deploys, by whoever is on duty. Everything they
// need is in the custom id or on file, and these pin the three things that
// makes fragile.
//
//   1. Who may press. Unconfigured means "anyone who can time members out",
//      because a button nobody can press is worse than no button; naming roles
//      narrows that and never widens it.
//   2. That it toggles. A moderator mis-clicks, and an account that looked
//      innocent at midnight sometimes does not at one.
//   3. That rebuilding the row keeps the other buttons. Under Components V2
//      the row lives inside the container, and the link button's URL is not
//      recoverable from anywhere else once dropped.

jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/utils/db', () => ({
    pool: { query: jest.fn(async () => ({ rows: [] })) },
    getSpeakConfigValue: jest.fn(async () => null),
    setSpeakConfigValue: jest.fn(async () => {}),
    getSuspicionReport: jest.fn(),
    markSuspicionReport: jest.fn(),
}));
jest.mock('../src/utils/joinGate/config', () => ({
    ...jest.requireActual('../src/utils/joinGate/config'),
    getSettings: jest.fn(async () => ({ false_positive_role_ids: [] })),
}));

const { ComponentType, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const db = require('../src/utils/db');
const { getSettings } = require('../src/utils/joinGate/config');
const { handles, handle, reportRows } = require('../src/utils/joinGate/reportActions');

/** A posted V2 panel: the action row lives inside the container. */
function postedPanel() {
    return {
        components: [{
            type: ComponentType.Container,
            components: [
                { type: ComponentType.TextDisplay, content: '### 🚨 Behaviour flag · score 102' },
                {
                    type: ComponentType.ActionRow,
                    components: [
                        { type: ComponentType.Button, style: ButtonStyle.Link, label: 'Jump to message', url: 'https://discord.com/channels/g1/c1/m1' },
                        { type: ComponentType.Button, style: ButtonStyle.Secondary, label: 'Copy user ID', custom_id: 'jg_uid:9' },
                        { type: ComponentType.Button, style: ButtonStyle.Secondary, label: 'Not a spammer', custom_id: 'jg_fp:77' },
                    ],
                },
            ],
        }],
        flags: { has: () => true },
    };
}

function fakeInteraction(customId, { roles = [], permissions = true, userId = 'mod-1' } = {}) {
    return {
        customId,
        guildId: 'g1',
        user: { id: userId },
        member: { roles: { cache: new Map(roles.map(id => [id, { id }])) } },
        memberPermissions: { has: bit => permissions && bit === PermissionFlagsBits.ModerateMembers },
        message: postedPanel(),
        reply: jest.fn(async () => {}),
        update: jest.fn(async () => {}),
        followUp: jest.fn(async () => {}),
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    getSettings.mockResolvedValue({ false_positive_role_ids: [] });
    db.getSuspicionReport.mockResolvedValue({ id: 77, user_id: 'spammer', score: 102, false_positive: false });
    db.markSuspicionReport.mockImplementation(async (id, { falsePositive }) => ({ id, userId: 'spammer', falsePositive }));
});

describe('which interactions are ours', () => {
    test('only the report ids, and never a game button', () => {
        expect(handles('jg_fp:77')).toBe(true);
        expect(handles('jg_uid:123')).toBe(true);
        expect(handles('jg_log_test')).toBe(false);
        expect(handles('bj_hit')).toBe(false);
        expect(handles(undefined)).toBe(false);
    });

    test('a foreign id is left for whatever owns it', async () => {
        const interaction = fakeInteraction('bj_hit');
        expect(await handle(interaction)).toBe(false);
        expect(interaction.reply).not.toHaveBeenCalled();
    });
});

describe('copy user id', () => {
    test('answers with the raw id and nothing else, so a paste is clean', async () => {
        const interaction = fakeInteraction('jg_uid:1525958566979047586');
        expect(await handle(interaction)).toBe(true);
        expect(interaction.reply.mock.calls[0][0].content).toBe('1525958566979047586');
    });

    test('needs no permission: it reveals what the panel already prints', async () => {
        const interaction = fakeInteraction('jg_uid:9', { permissions: false });
        await handle(interaction);
        expect(interaction.reply.mock.calls[0][0].content).toBe('9');
    });
});

describe('marking a report wrong', () => {
    test('a moderator marks it, and the button says so afterwards', async () => {
        const interaction = fakeInteraction('jg_fp:77');
        expect(await handle(interaction)).toBe(true);

        expect(db.markSuspicionReport).toHaveBeenCalledWith(77, { falsePositive: true, byId: 'mod-1' });
        const row = interaction.update.mock.calls[0][0].components[0].components
            .find(c => c.type === ComponentType.ActionRow);
        const mark = row.components.find(b => b.custom_id === 'jg_fp:77');
        expect(mark.label).toBe('Marked not a spammer');
        expect(mark.style).toBe(ButtonStyle.Success);
    });

    test('the link and the id button survive the swap', async () => {
        const interaction = fakeInteraction('jg_fp:77');
        await handle(interaction);
        const row = interaction.update.mock.calls[0][0].components[0].components
            .find(c => c.type === ComponentType.ActionRow);
        expect(row.components.map(b => b.url ?? b.custom_id))
            .toEqual(['https://discord.com/channels/g1/c1/m1', 'jg_uid:9', 'jg_fp:77']);
    });

    test('pressing it again takes the mark back', async () => {
        db.getSuspicionReport.mockResolvedValue({ id: 77, user_id: 'spammer', score: 102, false_positive: true });
        const interaction = fakeInteraction('jg_fp:77');
        await handle(interaction);

        expect(db.markSuspicionReport).toHaveBeenCalledWith(77, { falsePositive: false, byId: 'mod-1' });
        const row = interaction.update.mock.calls[0][0].components[0].components
            .find(c => c.type === ComponentType.ActionRow);
        expect(row.components.find(b => b.custom_id === 'jg_fp:77').label).toBe('Not a spammer');
    });

    test('it says out loud that it is a note, not an undo', async () => {
        const interaction = fakeInteraction('jg_fp:77');
        await handle(interaction);
        expect(interaction.followUp.mock.calls[0][0].content).toMatch(/not an undo/);
        // And it writes about somebody without pinging them.
        expect(interaction.followUp.mock.calls[0][0].allowedMentions).toEqual({ parse: [] });
    });

    test('a report that is no longer on file refuses instead of writing', async () => {
        db.getSuspicionReport.mockResolvedValue(null);
        const interaction = fakeInteraction('jg_fp:77');
        await handle(interaction);
        expect(db.markSuspicionReport).not.toHaveBeenCalled();
        expect(interaction.reply.mock.calls[0][0].content).toMatch(/no longer on file/);
    });

    test('an unreachable record refuses rather than leaving the click hanging', async () => {
        db.markSuspicionReport.mockRejectedValue(new Error('no database'));
        const interaction = fakeInteraction('jg_fp:77');
        expect(await handle(interaction)).toBe(true);
        expect(interaction.reply.mock.calls[0][0].content).toMatch(/unreachable/);
    });
});

describe('who is allowed to press it', () => {
    test('unconfigured, anyone who can time members out', async () => {
        const interaction = fakeInteraction('jg_fp:77', { permissions: true });
        await handle(interaction);
        expect(db.markSuspicionReport).toHaveBeenCalled();
    });

    test('unconfigured, an ordinary member cannot', async () => {
        const interaction = fakeInteraction('jg_fp:77', { permissions: false });
        await handle(interaction);
        expect(db.markSuspicionReport).not.toHaveBeenCalled();
        expect(interaction.reply.mock.calls[0][0].content).toMatch(/time members out/);
    });

    // Naming roles narrows the set. A server admin who is not in the named
    // roles is out, which is the point of naming them.
    test('configured roles replace the permission, they do not add to it', async () => {
        getSettings.mockResolvedValue({ false_positive_role_ids: ['role-a'] });

        const outsider = fakeInteraction('jg_fp:77', { permissions: true, roles: ['role-b'] });
        await handle(outsider);
        expect(db.markSuspicionReport).not.toHaveBeenCalled();
        expect(outsider.reply.mock.calls[0][0].content).toContain('<@&role-a>');

        const holder = fakeInteraction('jg_fp:77', { permissions: false, roles: ['role-a'] });
        await handle(holder);
        expect(db.markSuspicionReport).toHaveBeenCalledTimes(1);
    });

    test('the owner is never locked out of their own bot', async () => {
        getSettings.mockResolvedValue({ false_positive_role_ids: ['role-a'] });
        const owner = fakeInteraction('jg_fp:77', {
            permissions: false, roles: [], userId: require('../src/utils/constants').OWNER_ID ?? 'owner',
        });
        await handle(owner);
        // Only meaningful when an owner id is configured in this environment.
        if (require('../src/utils/constants').OWNER_ID) {
            expect(db.markSuspicionReport).toHaveBeenCalled();
        }
    });
});

describe('the row a fresh report is built with', () => {
    test('all three when everything is available', () => {
        const [row] = reportRows({ reportId: 5, userId: '9', jumpUrl: 'https://example.invalid/x' });
        expect(row.toJSON().components.map(b => b.custom_id ?? 'link'))
            .toEqual(['link', 'jg_uid:9', 'jg_fp:5']);
    });

    test('no row at all rather than an empty one, which Discord rejects', () => {
        expect(reportRows({})).toEqual([]);
        expect(reportRows()).toEqual([]);
    });
});
