// tests/cohorts.test.js
//
// Fourteen accounts were banned by hand off one backtest page. Every one of
// them was flagged correctly and individually, and nothing in the code could
// see that they were the same batch: the correlation signals read a 10-minute
// in-memory window built for a raid arriving at once, and these had trickled in
// over months.
//
// These pin the grouping, and just as importantly pin that ordinary members do
// not get swept into a batch with them.

const { findCohorts, nameShape, describeShape } = require('../src/utils/joinGate/cohorts');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = 1_700_000_000_000;

const member = (username, { created = T0, joined = T0, avatar = false, messages = 0, id } = {}) => ({
    id: id ?? username,
    username,
    createdTimestamp: created,
    joinedTimestamp: joined,
    defaultAvatar: !avatar,
    messages,
});

describe('nameShape', () => {
    test.each([
        ['davi_13400', 'suggested_5'],
        ['jonnie_boi_60929', 'suggested_5'],
        ['chlo.p_22616', 'suggested_5'],
        ['midtgaard_00_62679', 'suggested_5'],
        ['whatthesigmawe_29391', 'suggested_5'],
        ['michaelsteven0363', 'digits_4'],
        ['moksi', null],
        ['someone.cool', null],
    ])('%s -> %s', (username, expected) => {
        expect(nameShape(username)).toBe(expected);
    });

    test('unstructured names never group, or half the server would be one batch', () => {
        const ordinary = ['alice', 'bob', 'charlie', 'dave', 'erin'].map(n => member(n));
        expect(findCohorts(ordinary)).toEqual([]);
    });
});

describe('the batch that was banned by hand', () => {
    // The real usernames, registered a few hours apart.
    const names = [
        'davi_13400', 'harry_59338', 'bigpoppa_21218', 'jonnie_boi_60929',
        'akaza_48363', 'mikey_98344', 'paulo_75015', 'chlo.p_22616',
        'midtgaard_00_62679', 'buraza_49983', 'phantommoon_44125',
        'dexter_87176', 'caio_13697',
    ];
    const batch = names.map((n, i) => member(n, { created: T0 + i * 3 * HOUR, joined: T0 + i * 9 * DAY }));

    test('is found as one cohort', () => {
        const found = findCohorts(batch);
        expect(found).toHaveLength(1);
        expect(found[0].size).toBe(13);
    });

    test('is grouped on registration, not on joining', () => {
        // They joined months apart on purpose, which is what defeated the
        // existing 10-minute correlation window.
        expect(findCohorts(batch)[0].basis).toBe('creation');
    });

    test('reports the span, so a run that stretched too far is visible', () => {
        expect(findCohorts(batch)[0].creationSpanMs).toBe(12 * 3 * HOUR);
    });

    test('counts default avatars and silence', () => {
        const found = findCohorts(batch)[0];
        expect(found.defaultAvatars).toBe(13);
        expect(found.silent).toBe(13);
    });

    test('an ordinary member registered in the same week is not swept in', () => {
        const withReal = [...batch, member('moksi', { created: T0 + 2 * HOUR, avatar: true, messages: 900 })];
        const found = findCohorts(withReal);
        expect(found[0].members.map(m => m.username)).not.toContain('moksi');
    });

    test('a real person who took the suggested name IS swept in, and that is the cost', () => {
        // Nothing distinguishes them structurally, which is exactly why this
        // reports batches instead of scoring them. A human reads the list.
        const withReal = [...batch, member('realguy_44444', { created: T0 + 2 * HOUR, avatar: true, messages: 900 })];
        const found = findCohorts(withReal)[0];
        expect(found.members.map(m => m.username)).toContain('realguy_44444');
        expect(found.defaultAvatars).toBe(13); // and the report says 13 of 14
        expect(found.silent).toBe(13);
    });
});

describe('a wave that joined together but aged separately', () => {
    const wave = Array.from({ length: 5 }, (_, i) =>
        member(`user${i}_1234${i}`, { created: T0 - i * 200 * DAY, joined: T0 + i * 20 * 60_000 }));

    test('is caught on the join axis', () => {
        const found = findCohorts(wave);
        expect(found).toHaveLength(1);
        expect(found[0].basis).toBe('join');
        expect(found[0].size).toBe(5);
    });
});

describe('chance collisions do not make a batch', () => {
    test('two members are never a cohort', () => {
        expect(findCohorts([member('a_11111'), member('b_22222')])).toEqual([]);
    });

    test('members spread thinly over years do not chain into one blob', () => {
        const spread = Array.from({ length: 40 }, (_, i) =>
            member(`name${i}_1000${i % 10}`, { created: T0 + i * 40 * DAY, joined: T0 + i * 40 * DAY }));
        expect(findCohorts(spread)).toEqual([]);
    });

    test('a different digit count is a different shape', () => {
        const mixed = [
            member('a_11111'), member('b_22222'),
            member('c_3333'), member('d_4444'),
        ];
        expect(findCohorts(mixed)).toEqual([]);
    });
});

describe('describeShape', () => {
    test('names the signup suggestion for what it is', () => {
        expect(describeShape('suggested_5')).toBe('name_##### (signup suggestion)');
    });

    test('describes a plain digit tail', () => {
        expect(describeShape('digits_4')).toBe('ends in 4 digits');
    });
});
