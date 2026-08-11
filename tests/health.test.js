// tests/health.test.js
//
// The dot under the bot's name was the literal 'online', so it stayed green
// through a dead database, a rejected API key and a join gate that could not
// kick anybody. These pin the two things that make the new one worth
// believing: that it says the worst thing first, and that 'down' stays rare
// enough to mean something.

jest.mock('../src/utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const health = require('../src/utils/health');

beforeEach(() => {
    health.reset();
    jest.clearAllMocks();
});

describe('what the registry says', () => {
    test('nothing reported is healthy, not unknown', () => {
        // A bot that has never had a problem must not look suspicious.
        expect(health.snapshot()).toEqual({ state: 'ok', worst: null, problems: [] });
    });

    test('a subsystem reporting ok is not a problem', () => {
        health.report('database', 'ok');
        health.report('tweets', 'ok');
        expect(health.snapshot().state).toBe('ok');
        expect(health.snapshot().problems).toEqual([]);
    });

    test('the worst state wins, whatever order it arrived in', () => {
        health.report('tweets', 'degraded', 'poll failed', 1_000);
        health.report('database', 'down', 'no answer', 2_000);
        const snap = health.snapshot();
        expect(snap.state).toBe('down');
        expect(snap.worst.key).toBe('database');
        expect(snap.problems).toHaveLength(2);
    });

    test('among equals, the longest-standing one is the headline', () => {
        health.report('tweets', 'degraded', 'poll failed', 5_000);
        health.report('ai', 'degraded', '3 calls failed in a row', 1_000);
        expect(health.snapshot().worst.key).toBe('ai');
    });

    test('recovering clears the problem rather than downgrading it', () => {
        health.report('ai', 'degraded', '3 calls failed in a row');
        health.report('ai', 'ok');
        expect(health.snapshot().state).toBe('ok');
    });

    test('an unknown key still reports, under its own name', () => {
        // New subsystems must be able to speak up without editing health.js.
        health.report('casino', 'degraded', 'shuffler stuck');
        expect(health.snapshot().worst.label).toBe('casino');
    });

    test('a nonsense state is ignored, not stored', () => {
        health.report('database', 'unwell', 'what');
        expect(health.snapshot().state).toBe('ok');
    });
});

describe('how long it has been wrong', () => {
    // The mirror complains on every poll, ten minutes apart. If each identical
    // complaint reset the clock, an outage that started at breakfast would
    // still read as if it had just happened.
    test('repeating the same complaint keeps the original timestamp', () => {
        health.report('tweets', 'degraded', 'poll failed', 1_000);
        health.report('tweets', 'degraded', 'poll failed', 600_000);
        expect(health.snapshot().worst.sinceMs).toBe(1_000);
    });

    test('a different complaint is a new problem, with a new clock', () => {
        health.report('tweets', 'degraded', 'poll failed', 1_000);
        health.report('tweets', 'degraded', 'API key rejected', 600_000);
        expect(health.snapshot().worst.sinceMs).toBe(600_000);
    });

    test('getting worse restarts the clock', () => {
        health.report('database', 'degraded', 'slow', 1_000);
        health.report('database', 'down', 'no answer', 900_000);
        expect(health.snapshot().worst.sinceMs).toBe(900_000);
    });
});

describe('the database probe', () => {
    const withPool = (query) => {
        jest.resetModules();
        jest.doMock('../src/utils/logger', () => ({
            info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
        }));
        jest.doMock('../src/utils/db', () => ({ pool: { query } }));
        return require('../src/utils/health');
    };

    afterEach(() => {
        jest.resetModules();
        jest.dontMock('../src/utils/db');
    });

    test('an answering database is ok', async () => {
        const fresh = withPool(jest.fn(async () => ({ rows: [{ '?column?': 1 }] })));
        await fresh.probeDatabase();
        expect(fresh.snapshot().state).toBe('ok');
    });

    test('a rejecting database is down, and says why', async () => {
        const fresh = withPool(jest.fn(async () => { throw new Error('ECONNREFUSED'); }));
        await fresh.probeDatabase();
        const snap = fresh.snapshot();
        expect(snap.state).toBe('down');
        expect(snap.worst.detail).toBe('ECONNREFUSED');
    });

    // A pool that accepts the query and never answers is the failure mode that
    // matters: without the race, the presence tick would await it forever and
    // the line would freeze on whatever it last said.
    test('a database that never answers is down, not pending', async () => {
        jest.useFakeTimers();
        const fresh = withPool(jest.fn(() => new Promise(() => {})));
        const done = fresh.probeDatabase();
        jest.advanceTimersByTime(fresh.PROBE_TIMEOUT_MS + 1);
        await done;
        expect(fresh.snapshot().state).toBe('down');
        jest.useRealTimers();
    });

    test('refresh never throws, whatever the probe does', async () => {
        const fresh = withPool(jest.fn(() => { throw new Error('synchronous disaster'); }));
        await expect(fresh.refresh()).resolves.toBeUndefined();
    });
});
