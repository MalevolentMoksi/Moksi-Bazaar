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
    ui, toContainer, retireControls, isV2Message, planFields, alignTable,
    tableCell, tableName, tableValue, MAX_COMPONENTS,
} = require('../src/utils/ui/panel');
const mode = require('../src/utils/ui/mode');

/** Discord's own hard limit on components per message, nested ones included. */
const DISCORD_COMPONENT_CEILING = 40;

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
    test('five or more short inline fields become one aligned block', () => {
        const blocks = planFields([
            { name: 'Minimum age', value: '30 days', inline: true },
            { name: 'Dry run', value: 'off', inline: true },
            { name: 'Bots', value: 'exempt', inline: true },
            { name: 'Exempt users', value: '4', inline: true },
            { name: 'Lifetime', value: '312 gated', inline: true },
        ]);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].kind).toBe('table');

        // The point of the table is that values start at the same column.
        const rows = blocks[0].text.split('\n').filter(l => l && !l.startsWith('```'));
        const starts = rows.map(l => l.indexOf(l.trim().split(/\s{2,}/)[1]));
        expect(new Set(starts).size).toBe(1);
    });

    // A code block reads as reference furniture. /craps is four short readings
    // you glance at once, and boxing them made a dice roll look like a config
    // dump, so the threshold sits above it.
    test('a handful of readings stays light instead of becoming a code block', () => {
        const craps = [
            { name: 'Roll', value: '⚄ ⚀', inline: true },
            { name: 'Total', value: '6', inline: true },
            { name: 'Payout', value: '$500', inline: true },
            { name: 'Balance', value: '$14,940', inline: true },
        ];
        expect(planFields(craps)[0].kind).toBe('pairs');
        expect(planFields([...craps, { name: 'Point', value: '6', inline: true }])[0].kind).toBe('table');
    });

    // An embed bolds names and leaves values plain; that contrast is what makes
    // it scannable. "**Now editing** **Default channel**" threw it away.
    test('a value that opens with its own bold does not fight the label', () => {
        expect(planFields([
            { name: 'Minimum account age', value: '**14** days', inline: true },
            { name: 'Bot accounts', value: '✅ Exempt', inline: true },
        ])[0].text).toBe('**Minimum account age** 14 days · **Bot accounts** ✅ Exempt');

        // Emphasis inside a sentence is doing real work and survives.
        expect(planFields([
            { name: 'Result', value: '💰 You won **$1,500**.', inline: true },
            { name: 'Bet', value: '$250', inline: true },
        ])[0].text).toContain('**$1,500**');
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

    // An embed had no say in this; a container does, so a short value sits
    // beside its label instead of wasting a line on it.
    test('a short full-width value sits beside its label', () => {
        const blocks = planFields([{ name: 'Dealer', value: 'K♠ 9♦' }]);
        expect(blocks[0]).toEqual({ kind: 'prose', text: '**Dealer** K♠ 9♦' });
    });

    test('a long or multi-line full-width value still gets its own line', () => {
        const long = 'Your account is too new for this server, so you were removed automatically.';
        expect(planFields([{ name: 'Kick message', value: long }])[0].text)
            .toBe(`**Kick message**\n${long}`);
        expect(planFields([{ name: 'Hands', value: 'one\ntwo' }])[0].text)
            .toBe('**Hands**\none\ntwo');
    });

    // /slots uses a zero-width space as a field name to get an unlabelled row.
    // Rendered naively that became a visible, empty pair of asterisks.
    test('a deliberately blank label prints nothing rather than empty bold', () => {
        expect(planFields([{ name: '​', value: '🍒 🍋 🍒' }])[0].text).toBe('🍒 🍋 🍒');
        expect(planFields([
            { name: '​', value: 'a', inline: true },
            { name: 'Bet', value: '$250', inline: true },
        ])[0].text).toBe('a · **Bet** $250');
    });

    // /relationoverview is a tier label over its list of people. Pulling the
    // list up beside the label read as one run-on sentence.
    test('a decorated or mention-carrying value keeps its own line', () => {
        expect(planFields([{ name: '💚 Close Friends', value: '💚 **<@1>** - 340 msgs' }])[0].text)
            .toBe('**💚 Close Friends**\n💚 **<@1>** - 340 msgs');
        expect(planFields([{ name: 'Exempt users', value: '<@1>, <@2>' }])[0].text)
            .toBe('**Exempt users**\n<@1>, <@2>');
        // A plain short reading still sits beside its label.
        expect(planFields([{ name: 'Dealer', value: 'K♠ 9♦' }])[0].text).toBe('**Dealer** K♠ 9♦');
    });

    test('an explicit layout is honoured rather than quietly ignored', () => {
        const two = [
            { name: 'Bet', value: '500', inline: true },
            { name: 'Balance', value: '12,340', inline: true },
        ];
        // 'auto' would not make a table out of two rows; 'table' means it.
        expect(planFields(two)[0].kind).toBe('pairs');
        expect(planFields(two, { layout: 'table' })[0].kind).toBe('table');
        expect(planFields(two, { layout: 'prose' }).map(b => b.kind)).toEqual(['prose', 'prose']);

        const five = ['a', 'b', 'c', 'd', 'e'].map(n => ({ name: n, value: '1', inline: true }));
        expect(planFields(five)[0].kind).toBe('table');
        expect(planFields(five, { layout: 'pairs' })[0].kind).toBe('pairs');
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

    // The first pass stripped emoji from both columns and turned "10 ⛁" into
    // "10" and "🟢 On" into "On", throwing away the meaning to protect an
    // alignment that was never at risk: nothing is padded after the value.
    test('only the padded name column loses its emoji; values keep theirs', () => {
        expect(tableName('🟢 Heckling')).toBe('Heckling');
        expect(tableValue('🟢 On')).toBe('🟢 On');
        expect(tableValue('10 ⛁')).toBe('10 ⛁');
        expect(tableValue('50 ⛁/day')).toBe('50 ⛁/day');
    });

    test('markup still goes, because a code block would print it literally', () => {
        expect(tableValue('**30** days')).toBe('30 days');
        expect(tableName('**Bots**')).toBe('Bots');
    });

    // /casino profile put "-18,200 ⛁" over "612 rounds" because an embed field
    // had no other way to hold two numbers. A table row does.
    test('a two-line value folds onto one row instead of refusing the table', () => {
        expect(tableValue('-18,200 ⛁\n612 rounds')).toBe('-18,200 ⛁ · 612 rounds');

        const games = ['Blackjack', 'Slots', 'Craps', 'Roulette', 'Highlow'].map((name, i) => ({
            name, value: `-${i + 1},200 ⛁\n${100 + i} rounds`, inline: true,
        }));
        const blocks = planFields(games);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].kind).toBe('table');
        expect(blocks[0].text).toContain('-1,200 ⛁ · 100 rounds');
    });

    // The join gate overview is eight tidy settings and one long tally.
    test('a single long value does not sink the whole block', () => {
        const fields = [
            { name: 'Server', value: 'Festival Hub', inline: true },
            { name: 'Minimum age', value: '**14** days', inline: true },
            { name: 'Dry run', value: '⚪ Off', inline: true },
            { name: 'Bots', value: 'Exempt', inline: true },
            { name: 'Exempt users', value: '4', inline: true },
            { name: 'Lifetime', value: '312 kicked · 18 banned · 4 failed', inline: true },
        ];
        const blocks = planFields(fields);
        expect(blocks.map(b => b.kind)).toEqual(['table', 'pairs']);
        expect(blocks[0].text).toContain('Dry run');
        expect(blocks[0].text).not.toContain('Lifetime');
        expect(blocks[1].text).toContain('**Lifetime** 312 kicked');
    });

    test('field order is never rearranged to make a table', () => {
        // The long value comes first, so no leading run qualifies and the whole
        // thing stays pairs rather than being reordered around it.
        const blocks = planFields([
            { name: 'Lifetime', value: 'a'.repeat(40), inline: true },
            { name: 'a', value: '1', inline: true },
            { name: 'b', value: '2', inline: true },
            { name: 'c', value: '3', inline: true },
            { name: 'd', value: '4', inline: true },
        ]);
        expect(blocks.map(b => b.kind)).toEqual(['pairs']);
        expect(blocks[0].text.indexOf('Lifetime')).toBeLessThan(blocks[0].text.indexOf('**a**'));
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

    // An embed title renders larger than its body; plain bold does not, so a
    // heading is the closer match.
    test('the title is a heading, and a linked title keeps its link', () => {
        expect(texts(toContainer(new EmbedBuilder().setTitle('Blackjack')))[0])
            .toBe('### Blackjack');
        expect(texts(toContainer(new EmbedBuilder().setTitle('Docs').setURL('https://example.invalid')))[0])
            .toBe('### [Docs](https://example.invalid)');
    });

    test('a lone row builder is accepted rather than silently dropped', () => {
        const payload = ui(new EmbedBuilder().setTitle('t'), row('Go'), { mode: 'v2' });
        const kinds = payload.components[0].toJSON().components.map(c => c.type);
        expect(kinds).toContain(ComponentType.ActionRow);

        const classic = ui(new EmbedBuilder().setTitle('t'), row('Go'), { mode: 'v1' });
        expect(classic.components).toHaveLength(1);
    });

    test('an empty embed falls back to an embed, since an empty container is illegal', () => {
        expect(toContainer(new EmbedBuilder())).toBeNull();
        const payload = ui(new EmbedBuilder(), [], { mode: 'v2' });
        expect(payload.embeds).toHaveLength(1);
    });

    // Discord counts EVERY component, nested included. Five full button rows
    // are 30 of the 40 on their own, so counting only top-level children put
    // the worst real panel at exactly 40: one more field and it stops sending.
    test('the worst panel Discord can even describe stays under the ceiling', () => {
        const embed = new EmbedBuilder()
            .setTitle('Everything').setDescription('desc').setFooter({ text: 'footer' });
        // 25 fields is an embed's own hard maximum, so this is the true ceiling.
        for (let i = 0; i < 25; i += 1) {
            embed.addFields({ name: `Long field name ${i}`, value: 'x'.repeat(70) });
        }
        const fullRows = Array.from({ length: 5 }, (_, r) => row(...['a', 'b', 'c', 'd', 'e'].map(b => `${r}${b}`)));

        const json = toContainer(embed, fullRows).toJSON();
        const total = node => 1 + (node.components || []).reduce((n, c) => n + total(c), 0);

        expect(total(json)).toBeLessThanOrEqual(DISCORD_COMPONENT_CEILING);
        expect(total(json)).toBeLessThanOrEqual(MAX_COMPONENTS);
    });

    test('overflowing content is merged, never dropped, and controls always survive', () => {
        const embed = new EmbedBuilder().setTitle('T').setFooter({ text: 'THE FOOTER' });
        for (let i = 0; i < 25; i += 1) embed.addFields({ name: `Field ${i}`, value: `value ${i}` });
        const fullRows = Array.from({ length: 5 }, (_, r) => row(...['a', 'b', 'c', 'd', 'e'].map(b => `${r}${b}`)));

        const json = toContainer(embed, fullRows).toJSON();
        const rendered = JSON.stringify(json);

        expect(rendered).toContain('Field 0');
        expect(rendered).toContain('Field 24');
        expect(rendered).toContain('THE FOOTER');
        expect(json.components.filter(c => c.type === ComponentType.ActionRow)).toHaveLength(5);
    });

    test('the footer sits below the controls, where an embed footer sat', () => {
        const json = toContainer(
            new EmbedBuilder().setTitle('T').setFooter({ text: 'session' }),
            [row('Hit')],
        ).toJSON();
        const rowAt = json.components.findIndex(c => c.type === ComponentType.ActionRow);
        const footerAt = json.components.findIndex(
            c => c.type === ComponentType.TextDisplay && c.content.includes('session'),
        );
        expect(footerAt).toBeGreaterThan(rowAt);
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
