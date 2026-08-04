// tests/panelRows.test.js
//
// Discord accepts five action rows on a message and rejects the sixth. The
// join gate panel was slicing the overflow off silently, so the watch-window
// channel exemption shipped complete: builder written, handler wired, setting
// stored, and never once drawn on screen. Nothing threw and nothing logged.
//
// These count the rows every section actually produces, including the section
// picker the panel prepends, so the next control added to a full section fails
// here instead of vanishing in production.

const { fitRows, MAX_ACTION_ROWS } = require('../src/utils/panelHelpers');
const { DEFAULTS } = require('../src/utils/joinGate/config');
const { __renderers } = require('../src/commands/tools/joinGate');

/** A settings row shaped like the one getSettings hands the renderers. */
const settings = {
    ...DEFAULTS,
    guild_id: '1',
    exempt_user_ids: [],
    total_kicks: 0,
    total_bans: 0,
    total_failures: 0,
    total_flagged: 0,
};

/** Enough of a guild for the renderers that only read the name and channels. */
const guild = { name: 'Test', channels: { cache: new Map() } };

/** describeRouting's shape, hand-made so this needs no database. */
const routing = {
    kicks: { label: 'Kicks', overrideId: null, enabled: true, usable: true },
};

const SECTIONS = {
    overview: () => __renderers.renderOverview(guild, settings),
    rules: () => __renderers.renderRules(settings),
    messaging: () => __renderers.renderMessaging(settings),
    escalation: () => __renderers.renderEscalation(settings, []),
    suspicion: () => __renderers.renderSuspicion(settings),
    watch: () => __renderers.renderWatch(settings, guild),
    logging: () => __renderers.renderLogging(settings, routing, 'default'),
    advanced: () => __renderers.renderAdvanced(settings),
};

describe('every section fits on a Discord message', () => {
    for (const [name, render] of Object.entries(SECTIONS)) {
        test(`${name} leaves room for the section picker`, () => {
            const rows = [__renderers.sectionRow('overview'), ...render().rows];
            expect(rows.length).toBeLessThanOrEqual(MAX_ACTION_ROWS);
        });
    }

    test('no row holds more than five components', () => {
        for (const [name, render] of Object.entries(SECTIONS)) {
            for (const row of render().rows) {
                expect(`${name}:${row.components.length}`)
                    .toBe(`${name}:${Math.min(row.components.length, 5)}`);
            }
        }
    });
});

describe('the watch window controls exist where they are reachable', () => {
    const idsOf = built => built.rows.flatMap(r => r.components.map(c => c.data.custom_id));

    test('the exemption picker is on the watch page', () => {
        expect(idsOf(__renderers.renderWatch(settings, guild))).toContain('jg_watch_exempt');
    });

    test('the suspicion page offers a way to reach it', () => {
        expect(idsOf(__renderers.renderSuspicion(settings))).toContain('jg_susp_watchcfg');
    });

    test('a stored channel the guild no longer has is not pre-selected', () => {
        // Discord rejects the whole message over an unresolvable default value,
        // which would take the page down rather than one stale entry.
        const stale = { ...settings, watch_exempt_channel_ids: ['404'] };
        const picker = __renderers.renderWatch(stale, guild).rows[1].components[0];
        expect(picker.data.default_values ?? []).toEqual([]);
    });

    test('a channel the guild does have is pre-selected', () => {
        const live = { ...settings, watch_exempt_channel_ids: ['77'] };
        const withChannel = { ...guild, channels: { cache: new Map([['77', {}]]) } };
        const picker = __renderers.renderWatch(live, withChannel).rows[1].components[0];
        expect(picker.data.default_values.map(v => v.id)).toEqual(['77']);
    });
});

describe('every control is wired to something', () => {
    // A button whose custom id no handler matches is a dead button: it renders,
    // it clicks, and nothing happens until the collector times out. Cheap to
    // ship and invisible without a check like this one.
    const source = require('fs').readFileSync(
        require('path').join(__dirname, '..', 'src', 'commands', 'tools', 'joinGate.js'), 'utf8');

    const declared = new Set([...source.matchAll(/setCustomId\('(\w+)'\)/g)].map(m => m[1]));
    const handled = new Set([
        ...[...source.matchAll(/id === '(\w+)'/g)].map(m => m[1]),
        ...[...source.matchAll(/customId [!=]== '(\w+)'/g)].map(m => m[1]),
        ...[...source.matchAll(/^\s{20}(jg_\w+):/gm)].map(m => m[1]),
    ]);

    test('no component is left without a handler', () => {
        // jg_modal* ids are generated per interaction and answered by await,
        // not by the collector.
        const orphans = [...declared].filter(id => !handled.has(id) && !id.startsWith('jg_modal'));
        expect(orphans).toEqual([]);
    });

    test('no handler waits on a component that no longer exists', () => {
        expect([...handled].filter(id => !declared.has(id))).toEqual([]);
    });
});

describe('fitRows', () => {
    const row = id => ({ components: [{ data: { custom_id: id } }] });

    test('leaves a panel inside the limit alone', () => {
        const rows = [row('a'), row('b')];
        expect(fitRows(rows, 'test')).toBe(rows);
    });

    test('clips an over-long panel to the limit', () => {
        const rows = Array.from({ length: 7 }, (_, n) => row(`r${n}`));
        expect(fitRows(rows, 'test')).toHaveLength(MAX_ACTION_ROWS);
    });
});
