// tests/behaviourReports.test.js
//
// Two questions the watch window answers separately, and used to confuse.
//
//   Is this worth saying out loud?  It used to be "did anything score above
//   zero", so a newcomer's first YouTube link (12 points) produced a mod panel
//   headed "Worth a look", which is what the same panel says about a 99.
//   Reports that fire on nothing teach staff that reports are nothing.
//
//   How loudly?  Everything under the action bar was tier 'watch', so a 42 and
//   a 99 arrived in the same colour under the same icon. Severity for the
//   reader is a different question from whether the bot acts, and only
//   watch_action_at decides the second one.

jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/utils/db', () => ({
    pool: { query: jest.fn(async () => ({ rows: [] })) },
    getSpeakConfigValue: jest.fn(async () => null),
    setSpeakConfigValue: jest.fn(async () => {}),
}));

const { reportFloor, behaviourTier, ownInviteCodes } = require('../src/utils/joinGate/enforcement');
const { DEFAULTS } = require('../src/utils/joinGate/config');

const settings = { ...DEFAULTS };

describe('what is worth a report', () => {
    test('the floor is the profile scorer\'s own "worth a look" number', () => {
        expect(reportFloor(settings)).toBe(settings.suspicion_watch_at);
        expect(reportFloor({ suspicion_watch_at: 55 })).toBe(55);
    });

    test('a broken or missing setting still leaves a floor, never zero', () => {
        expect(reportFloor({})).toBe(40);
        expect(reportFloor({ suspicion_watch_at: 0 })).toBe(40);
        expect(reportFloor({ suspicion_watch_at: 'soon' })).toBe(40);
    });

    // The scores this file exists for, taken from the live weights.
    test('the shapes that used to panel for nothing are under it', () => {
        const floor = reportFloor(settings);
        expect(12).toBeLessThan(floor);  // one link from a newcomer
        expect(25).toBeLessThan(floor);  // a link from someone who looked odd on arrival
    });

    test('the shapes worth reading are above it', () => {
        const floor = reportFloor(settings);
        expect(42).toBeGreaterThanOrEqual(floor);   // an invite to another server
        expect(82).toBeGreaterThanOrEqual(floor);   // the same link in two channels
        expect(102).toBeGreaterThanOrEqual(floor);  // the live incident
    });
});

describe('how loudly', () => {
    test('the bands are the guild\'s own configured thresholds', () => {
        expect(behaviourTier(42, settings)).toBe('watch');
        expect(behaviourTier(82, settings)).toBe('suspect');
        expect(behaviourTier(102, settings)).toBe('malicious');
    });

    test('a guild that moved its thresholds moves these too', () => {
        const tuned = { suspicion_suspect_at: 50, suspicion_malicious_at: 60 };
        expect(behaviourTier(45, tuned)).toBe('watch');
        expect(behaviourTier(55, tuned)).toBe('suspect');
        expect(behaviourTier(65, tuned)).toBe('malicious');
    });

    // Severity is for the reader. What the bot DOES is decided by
    // watch_action_at alone, and these must never be wired together.
    test('a loud tier is not an instruction to act', () => {
        const quiet = { suspicion_suspect_at: 10, suspicion_malicious_at: 20 };
        expect(behaviourTier(30, quiet)).toBe('malicious');
        // ...and the action threshold in the same settings is untouched at 100.
        expect(Number(settings.watch_action_at)).toBe(100);
    });
});

describe('which invites are ours', () => {
    const guild = (over = {}) => ({
        id: 'g1',
        vanityURLCode: null,
        invites: { fetch: async () => new Map([['abc', { code: 'abc' }], ['def', { code: 'DEF' }]]) },
        ...over,
    });

    test('every code that leads back here, lowercased', async () => {
        const codes = await ownInviteCodes(guild());
        expect([...codes].sort()).toEqual(['abc', 'def']);
    });

    test('the vanity url counts even when the fetch fails', async () => {
        const codes = await ownInviteCodes(guild({
            id: 'g2', vanityURLCode: 'FestivalHub', invites: { fetch: async () => { throw new Error('nope'); } },
        }));
        expect(codes.has('festivalhub')).toBe(true);
    });

    // A failed lookup must not quietly stop counting invites: null means the
    // caller keeps the old behaviour rather than trusting an empty set.
    test('nothing knowable returns null, not an empty set', async () => {
        const codes = await ownInviteCodes({
            id: 'g3', vanityURLCode: null, invites: { fetch: async () => { throw new Error('nope'); } },
        });
        expect(codes).toBeNull();
    });

    test('it is cached, so a spam wave costs one fetch', async () => {
        let calls = 0;
        const g = { id: 'g4', vanityURLCode: null, invites: { fetch: async () => { calls += 1; return new Map(); } } };
        await ownInviteCodes(g);
        await ownInviteCodes(g);
        expect(calls).toBe(1);
    });
});
