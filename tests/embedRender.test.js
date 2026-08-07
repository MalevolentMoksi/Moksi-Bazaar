// tests/embedRender.test.js
//
// Components V2 has three rules that turn ordinary Discord code into a bug:
//
//   1. The IS_COMPONENTS_V2 flag can never be removed from a message, so an
//      edit must render in the mode its message was born in, not the mode the
//      toggle happens to be in when a button is pressed.
//   2. `components` is the WHOLE message body, so the familiar
//      `edit({ components: [] })` used to grey out buttons would erase the
//      panel instead.
//   3. `content` does not exist at all.
//
// Everything below exists because one of those three would otherwise be found
// in production, mid-game, with money on the table.

const mockStore = new Map();

jest.mock('../src/utils/db', () => ({
    getSpeakConfigValue: jest.fn(async (key, fallback) => (mockStore.has(key) ? mockStore.get(key) : fallback)),
    setSpeakConfigValue: jest.fn(async (key, value) => { mockStore.set(key, value); }),
}));

const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    MessageFlags, ComponentType,
} = require('discord.js');

const {
    ui, toContainer, retireControls, isV2Message, planFields, alignTable, tableCell,
    MAX_COMPONENTS,
} = require('../src/utils/ui/panel');
const mode = require('../src/utils/ui/mode');

const row = (...labels) => new ActionRowBuilder().addComponents(
    ...labels.map(label => new ButtonBuilder()
        .setCustomId(`btn_${label}`).setLabel(label).setStyle(ButtonStyle.Secondary)),
);

/** A message as discord.js hands it back, with real flag semantics. */
const message = (v2) => ({
    flags: { has: bit => v2 && bit === MessageFlags.IsComponentsV2 },
    components: [],
});

const texts = container => container.toJSON().components
    .filter(c => c.type === ComponentType.TextDisplay)
    .map(c => c.content);

beforeEach(() => {
    mockStore.clear();
    mode._setCacheForTests({});
});

describe('choosing a rendering', () => {
    test('every surface starts on classic embeds', () => {
        const payload = ui(new EmbedBuilder().setTitle('hi'), [], { scope: 'casino' });
        expect(payload.embeds).toHaveLength(1);
        expect(payload.flags).toBeUndefined();
    });

    test('a switched-on surface renders a container instead', () => {
        mode._setCacheForTests({ casino: true });
        const payload = ui(new EmbedBuilder().setTitle('hi'), [], { scope: 'casino' });
        expect(payload.embeds).toBeUndefined();
        expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
        expect(payload.components).toHaveLength(1);
    });

    test('surfaces switch independently', () => {
        mode._setCacheForTests({ casino: true });
        expect(ui(new EmbedBuilder().setTitle('a'), [], { scope: 'casino' }).embeds).toBeUndefined();
        expect(ui(new EmbedBuilder().setTitle('b'), [], { scope: 'mod' }).embeds).toHaveLength(1);
    });

    test('an unknown scope falls back to embeds rather than guessing', () => {
        expect(ui(new EmbedBuilder().setTitle('a'), [], { scope: 'nope' }).embeds).toHaveLength(1);
    });
});

describe('edits follow the message, not the toggle', () => {
    // The whole reason the toggle is safe to flip while people are playing.
    test('a v2 message keeps rendering as v2 after the surface is switched off', () => {
        mode._setCacheForTests({});
        const payload = ui(new EmbedBuilder().setTitle('hand'), [], {
            scope: 'casino', like: message(true),
        });
        expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
        expect(payload.embeds).toBeUndefined();
    });

    test('an embed message keeps rendering as an embed after the surface is switched on', () => {
        mode._setCacheForTests({ casino: true });
        const payload = ui(new EmbedBuilder().setTitle('hand'), [], {
            scope: 'casino', like: message(false),
        });
        expect(payload.embeds).toHaveLength(1);
        expect(payload.flags).toBeUndefined();
    });

    test('an explicit mode beats both', () => {
        expect(ui(new EmbedBuilder().setTitle('x'), [], { mode: 'v2' }).flags)
            .toBe(MessageFlags.IsComponentsV2);
        mode._setCacheForTests({ casino: true });
        expect(ui(new EmbedBuilder().setTitle('x'), [], { scope: 'casino', mode: 'v1' }).embeds)
            .toHaveLength(1);
    });
});

describe('ephemeral', () => {
    test('the two flags are combined, not overwritten', () => {
        mode._setCacheForTests({ casino: true });
        const payload = ui(new EmbedBuilder().setTitle('x'), [], { scope: 'casino', ephemeral: true });
        expect(payload.flags).toBe(MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral);
        expect(payload.flags & MessageFlags.Ephemeral).toBeTruthy();
        expect(payload.flags & MessageFlags.IsComponentsV2).toBeTruthy();
    });

    test('it is never set on an edit, where Discord rejects it', () => {
        mode._setCacheForTests({ casino: true });
        const payload = ui(new EmbedBuilder().setTitle('x'), [], {
            ephemeral: true, like: message(true),
        });
        expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    });
});

describe('field layout', () => {
    test('four or more short inline fields become one aligned block', () => {
        const blocks = planFields([
            { name: 'Minimum age', value: '30 days', inline: true },
            { name: 'Dry run', value: 'off', inline: true },
            { name: 'Bots', value: 'exempt', inline: true },
            { name: 'Lifetime', value: '312 gated', inline: true },
        ]);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].kind).toBe('table');

        // The point of the table is that values start at the same column.
        const rows = blocks[0].text.split('\n').filter(l => l && !l.startsWith('```'));
        const starts = rows.map(l => l.indexOf(l.trim().split(/\s{2,}/)[1]));
        expect(new Set(starts).size).toBe(1);
    });

    test('two or three inline fields share a line instead', () => {
        const blocks = planFields([
            { name: 'On the table', value: '500', inline: true },
            { name: 'Balance', value: '12,340', inline: true },
        ]);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].kind).toBe('pairs');
        expect(blocks[0].text).toBe('**On the table** 500 · **Balance** 12,340');
    });

    test('a full-width field keeps its label above its value', () => {
        const blocks = planFields([{ name: 'Kick message', value: 'Come back later.' }]);
        expect(blocks[0]).toEqual({ kind: 'prose', text: '**Kick message**\nCome back later.' });
    });

    test('field order survives a mix of the two', () => {
        const blocks = planFields([
            { name: 'Dealer', value: 'K 9' },
            { name: 'a', value: '1', inline: true },
            { name: 'b', value: '2', inline: true },
        ]);
        expect(blocks.map(b => b.kind)).toEqual(['prose', 'pairs']);
    });

    test('mentions and timestamps refuse the table, because a code block would show them raw', () => {
        expect(tableCell('<@1234>')).toBeNull();
        expect(tableCell('<t:1786000000:R>')).toBeNull();
        expect(tableCell('<#99>')).toBeNull();

        const blocks = planFields([
            { name: 'Reports go to', value: '<#99>', inline: true },
            { name: 'B', value: 'x', inline: true },
            { name: 'C', value: 'y', inline: true },
            { name: 'D', value: 'z', inline: true },
        ]);
        expect(blocks[0].kind).toBe('pairs');
    });

    test('emoji and markup are stripped from table cells, since they break alignment', () => {
        expect(tableCell('🟢 On')).toBe('On');
        expect(tableCell('**30** days')).toBe('30 days');
    });

    test('a long name is truncated rather than pushing the column out', () => {
        const table = alignTable([
            { name: 'a'.repeat(40), value: '1' },
            { name: 'b', value: '2' },
        ]);
        for (const line of table.split('\n').filter(l => !l.startsWith('```'))) {
            expect(line.length).toBeLessThan(60);
        }
    });
});

describe('the container itself', () => {
    test('controls sit inside the panel rather than under it', () => {
        const container = toContainer(new EmbedBuilder().setTitle('Blackjack'), [row('Hit', 'Stand')]);
        const kinds = container.toJSON().components.map(c => c.type);
        expect(kinds).toContain(ComponentType.ActionRow);
    });

    test('the footer becomes subtext and the accent colour is kept', () => {
        const container = toContainer(new EmbedBuilder()
            .setTitle('t').setColor(0xc0392b).setFooter({ text: 'This session: -1,250' }));
        expect(texts(container)).toContain('-# This session: -1,250');
        expect(container.toJSON().accent_color).toBe(0xc0392b);
    });

    test('a timestamp survives as a relative marker', () => {
        const when = new Date('2026-08-07T12:00:00Z');
        const container = toContainer(new EmbedBuilder().setTitle('t').setTimestamp(when));
        const footer = texts(container).find(t => t.startsWith('-#'));
        expect(footer).toContain(`<t:${Math.floor(when.getTime() / 1000)}:R>`);
    });

    test('a thumbnail becomes a section accessory beside the heading', () => {
        const container = toContainer(new EmbedBuilder()
            .setTitle('Opinion').setDescription('dry').setThumbnail('https://example.invalid/a.png'));
        const section = container.toJSON().components.find(c => c.type === ComponentType.Section);
        expect(section).toBeDefined();
        expect(section.accessory.media.url).toBe('https://example.invalid/a.png');
    });

    test('a linked title keeps its link', () => {
        const container = toContainer(new EmbedBuilder().setTitle('Docs').setURL('https://example.invalid'));
        expect(texts(container)[0]).toBe('**[Docs](https://example.invalid)**');
    });

    test('an empty embed falls back to an embed, since an empty container is illegal', () => {
        expect(toContainer(new EmbedBuilder())).toBeNull();
        const payload = ui(new EmbedBuilder(), [], { mode: 'v2' });
        expect(payload.embeds).toHaveLength(1);
    });

    test('a dense panel stays well under the component ceiling', () => {
        const embed = new EmbedBuilder().setTitle('Everything');
        for (let i = 0; i < 25; i += 1) {
            embed.addFields({ name: `Field ${i}`, value: `value ${i}`, inline: true });
        }
        const container = toContainer(embed);
        expect(container.toJSON().components.length).toBeLessThanOrEqual(MAX_COMPONENTS);
    });

    test('several embeds become several containers, controls on the last', () => {
        const payload = ui(
            [new EmbedBuilder().setTitle('one'), new EmbedBuilder().setTitle('two')],
            [row('Go')],
            { mode: 'v2' },
        );
        expect(payload.components).toHaveLength(2);
        const last = payload.components[1].toJSON().components.map(c => c.type);
        const first = payload.components[0].toJSON().components.map(c => c.type);
        expect(last).toContain(ComponentType.ActionRow);
        expect(first).not.toContain(ComponentType.ActionRow);
    });
});

describe('retiring the controls on a posted message', () => {
    const posted = (rows) => ({
        flags: { has: bit => bit === MessageFlags.IsComponentsV2 },
        components: [toContainer(
            new EmbedBuilder().setTitle('Blackjack').setFooter({ text: 'session' }),
            rows,
        )],
    });

    test('on a classic embed it is still just the buttons', () => {
        const payload = retireControls(message(false), [row('Hit')]);
        expect(payload.flags).toBeUndefined();
        expect(payload.components).toHaveLength(1);
    });

    test('on a container it swaps the buttons and keeps the panel', () => {
        const payload = retireControls(posted([row('Hit', 'Stand')]), [row('Hit')]);
        const kids = payload.components[0].components;
        expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
        expect(kids.some(c => c.type === ComponentType.TextDisplay
            && c.content.includes('Blackjack'))).toBe(true);
        const actionRows = kids.filter(c => c.type === ComponentType.ActionRow);
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0].components).toHaveLength(1);
    });

    // This is the one that would have silently deleted a finished game.
    test('removing every control does not blank the panel', () => {
        const payload = retireControls(posted([row('Hit', 'Stand')]));
        const kids = payload.components[0].components;
        expect(kids.filter(c => c.type === ComponentType.ActionRow)).toHaveLength(0);
        expect(kids.some(c => c.type === ComponentType.TextDisplay
            && c.content.includes('Blackjack'))).toBe(true);
        expect(kids.some(c => c.type === ComponentType.TextDisplay
            && c.content.includes('session'))).toBe(true);
    });

    test('the separator that only introduced the buttons goes with them', () => {
        const withRows = posted([row('Hit')]).components[0].toJSON().components;
        const separatorsBefore = withRows.filter(c => c.type === ComponentType.Separator).length;
        const after = retireControls(posted([row('Hit')])).components[0].components;
        const separatorsAfter = after.filter(c => c.type === ComponentType.Separator).length;
        expect(separatorsAfter).toBe(separatorsBefore - 1);
    });
});

describe('reading the flag off a message', () => {
    test('handles a flags bitfield, a raw number, and nothing at all', () => {
        expect(isV2Message(message(true))).toBe(true);
        expect(isV2Message(message(false))).toBe(false);
        expect(isV2Message({ flags: MessageFlags.IsComponentsV2 })).toBe(true);
        expect(isV2Message({ flags: MessageFlags.Ephemeral })).toBe(false);
        expect(isV2Message(undefined)).toBe(false);
        expect(isV2Message({})).toBe(false);
    });
});

describe('the toggle store', () => {
    test('it loads nothing as everything off', async () => {
        expect(await mode.loadModes()).toEqual(
            Object.fromEntries(mode.SCOPE_NAMES.map(n => [n, false])),
        );
    });

    test('a stored surface that no longer exists is dropped', async () => {
        mockStore.set(mode.CONFIG_KEY, { casino: true, atlantis: true });
        const loaded = await mode.loadModes();
        expect(loaded.casino).toBe(true);
        expect(loaded.atlantis).toBeUndefined();
    });

    test('setting one surface writes through and leaves the rest alone', async () => {
        await mode.loadModes();
        const next = await mode.setMode('casino', true);
        expect(next.casino).toBe(true);
        expect(next.mod).toBe(false);
        expect(mockStore.get(mode.CONFIG_KEY).casino).toBe(true);
        expect(mode.isV2Scope('casino')).toBe(true);
    });

    test('an unknown surface is refused rather than silently stored', async () => {
        await expect(mode.setMode('atlantis', true)).rejects.toThrow(/atlantis/);
    });

    test('a failed read leaves everything on embeds', async () => {
        const db = require('../src/utils/db');
        db.getSpeakConfigValue.mockRejectedValueOnce(new Error('no database'));
        const loaded = await mode.loadModes();
        expect(Object.values(loaded).every(v => v === false)).toBe(true);
    });
});
