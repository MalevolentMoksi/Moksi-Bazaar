// tests/removalCohorts.test.js
//
// The batches the roster backtest structurally cannot see.
//
// cohorts.js could always spot a batch. It only ever ran over the CURRENT
// member roster, and anything the gate catches is by definition no longer in
// it, so the batches that mattered most were invisible. On 2026-08-19 two
// obvious throwaways arrived minutes apart, were both correctly kicked, and
// left nothing behind that could later be recognised as a pair. The evidence
// deleted itself at the moment the gate worked.
//
// The real pair is the fixture. If this ever stops grouping them, the report
// has lost the one case it was written for.

jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/utils/health', () => ({ report: jest.fn() }));
jest.mock('../src/utils/joinGate/unbanScheduler', () => ({
    insertPendingUnban: jest.fn(async () => {}), scheduleNext: jest.fn(async () => {}),
}));
jest.mock('../src/utils/joinGate/logging', () => ({
    logOutcome: jest.fn(async () => {}), logBurst: jest.fn(async () => {}), logSuspicion: jest.fn(async () => {}),
}));
jest.mock('../src/utils/joinGate/invites', () => ({ resolveJoin: jest.fn(async () => null) }));
jest.mock('../src/utils/joinGate/activity', () => ({
    countsForGuild: jest.fn(async () => new Map()), trackingSince: jest.fn(async () => 0),
}));

let mockRows = [];
jest.mock('../src/utils/db', () => ({
    pool: { query: jest.fn(async () => ({ rows: mockRows })) },
    recordSuspicionReport: jest.fn(async () => 1),
}));

const { findRemovalCohorts } = require('../src/utils/joinGate/removalCohorts');

const AUG_18 = Date.parse('2026-08-18T00:00:00Z');
const AUG_17 = Date.parse('2026-08-17T01:42:00Z');
const KICKED_AT = Date.parse('2026-08-19T09:04:00Z');

/** The two accounts from the incident, as the removal log would hold them. */
const REAL_PAIR = [
    {
        user_id: '1539161770709487696', username: 'emmawilson0427', global_name: null,
        avatar: 'abc', created_ms: String(AUG_18), invite_code: null,
        attempts: 1, first_seen_ms: String(KICKED_AT), last_seen_ms: String(KICKED_AT),
    },
    {
        user_id: '1538822588510511194', username: 'emaaa.7777', global_name: null,
        avatar: 'def', created_ms: String(AUG_17), invite_code: null,
        attempts: 3, first_seen_ms: String(KICKED_AT), last_seen_ms: String(KICKED_AT),
    },
];

beforeEach(() => { mockRows = []; });

describe('the pair that started this', () => {
    test('is grouped, where the roster backtest could never have seen them', async () => {
        mockRows = REAL_PAIR;
        const { cohorts, scanned } = await findRemovalCohorts('g1', { now: KICKED_AT + 60_000 });
        expect(scanned).toBe(2);
        expect(cohorts).toHaveLength(1);
        expect(cohorts[0].size).toBe(2);
        expect(cohorts[0].shape).toBe('digits_4');
        expect(cohorts[0].members.map(m => m.username).sort())
            .toEqual(['emaaa.7777', 'emmawilson0427']);
    });

    test('the attempt count rides along, so a rejoiner is visible as one', async () => {
        mockRows = REAL_PAIR;
        const { cohorts } = await findRemovalCohorts('g1', { now: KICKED_AT + 60_000 });
        const persistent = cohorts[0].members.find(m => m.username === 'emaaa.7777');
        expect(persistent.attempts).toBe(3);
    });
});

describe('what it refuses to group', () => {
    test('one account alone is not a batch', async () => {
        mockRows = [REAL_PAIR[0]];
        const { cohorts } = await findRemovalCohorts('g1', { now: KICKED_AT + 60_000 });
        expect(cohorts).toEqual([]);
    });

    test('names with no structure are not grouped on having none', async () => {
        mockRows = [
            { ...REAL_PAIR[0], user_id: '1', username: 'jasper', created_ms: String(AUG_18) },
            { ...REAL_PAIR[1], user_id: '2', username: 'clementine', created_ms: String(AUG_17) },
        ];
        const { cohorts } = await findRemovalCohorts('g1', { now: KICKED_AT + 60_000 });
        expect(cohorts).toEqual([]);
    });

    test('rows from before fingerprints existed are skipped, not grouped on nulls', async () => {
        mockRows = [
            { ...REAL_PAIR[0], username: null, created_ms: null },
            { ...REAL_PAIR[1], username: null, created_ms: null },
        ];
        const { cohorts, scanned } = await findRemovalCohorts('g1', { now: KICKED_AT + 60_000 });
        expect(scanned).toBe(0);
        expect(cohorts).toEqual([]);
    });
});

describe('it is a report and nothing else', () => {
    test('the module calls no moderation endpoint and feeds no score', () => {
        const source = require('fs').readFileSync(
            require('path').join(__dirname, '..', 'src', 'utils', 'joinGate', 'removalCohorts.js'), 'utf8');
        for (const forbidden of ['.ban(', '.kick(', '.timeout(', '.send(', 'scoreAccount', 'incrementStat']) {
            expect(source).not.toContain(forbidden);
        }
    });
});
