// tests/presence.test.js
//
// The line under the bot's name, and the three faults it had.
//
//   It was blank for the first sixty seconds of every session, because the
//   interval was scheduled a minute out with nothing before it. Railway
//   redeploys on every push, so the gap landed exactly when someone was
//   watching the deploy go out.
//
//   The dot was the literal 'online' and never moved.
//
//   It rewrote the same string every minute forever, long after "3d 4h" had
//   stopped changing.

jest.mock('../src/utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../src/utils/health', () => ({
    refresh: jest.fn(async () => {}),
    snapshot: jest.fn(() => ({ state: 'ok', worst: null, problems: [] })),
}));

const health = require('../src/utils/health');
const { initPresence, presenceLine, formatDuration, MAX_ACTIVITY } = require('../src/utils/presence');

const HEALTHY = { state: 'ok', worst: null, problems: [] };

const problem = (over = {}) => ({
    key: 'database', label: 'Database', state: 'down',
    detail: 'no answer in 6s', sinceMs: 0, ...over,
});

const one = p => ({ state: p.state, worst: p, problems: [p] });

/** Lets the tick's awaits settle without depending on the timer mock. */
const flush = () => Promise.resolve().then(() => {}).then(() => {}).then(() => {});

const fakeClient = (uptime = 60_000) => ({ uptime, user: { setPresence: jest.fn() } });

let timer = null;
const start = (client) => { timer = initPresence(client); return client; };

beforeEach(() => {
    jest.clearAllMocks();
    health.snapshot.mockReturnValue(HEALTHY);
});

afterEach(() => {
    if (timer) clearInterval(timer);
    timer = null;
    jest.useRealTimers();
});

describe('what the line says', () => {
    test('healthy is the uptime, unchanged from before', () => {
        expect(presenceLine(3 * 86_400_000 + 4 * 3_600_000, HEALTHY))
            .toEqual({ text: 'Uptime: 3d 4h', status: 'online' });
    });

    test('a broken subsystem takes the line, and the dot', () => {
        const line = presenceLine(60_000, one(problem()), 240_000);
        expect(line.text).toBe('Database: no answer in 6s · 4m 0s');
        expect(line.status).toBe('dnd');
    });

    // Red is reserved for the bot being unable to work at all. A mirror that
    // has stopped is a missing feature, and if everything can turn the dot red
    // then red stops meaning anything.
    test('a stopped feature is yellow, not red', () => {
        const line = presenceLine(60_000, one(problem({
            key: 'tweets', label: 'X mirror', state: 'degraded', detail: 'API key rejected',
        })), 0);
        expect(line.status).toBe('idle');
        expect(line.text).toContain('X mirror: API key rejected');
    });

    test('only the worst one speaks; the rest are a count', () => {
        const worst = problem();
        const snap = { state: 'down', worst, problems: [worst, problem({ key: 'ai' }), problem({ key: 'tweets' })] };
        expect(presenceLine(60_000, snap, 0).text).toContain('(+2 more)');
    });

    test('a problem with no detail still reads as a sentence', () => {
        expect(presenceLine(60_000, one(problem({ detail: null })), 0).text)
            .toBe('Database: not working · 0s');
    });

    // Discord rejects an activity name over 128 characters outright, which
    // would mean the one line that matters is the one that fails to send.
    test('a long complaint is truncated rather than refused', () => {
        const text = presenceLine(60_000, one(problem({ detail: 'x'.repeat(400) })), 0).text;
        expect(text.length).toBeLessThanOrEqual(MAX_ACTIVITY);
        expect(text.endsWith('…')).toBe(true);
    });

    test('a missing snapshot falls back to the uptime, not to silence', () => {
        expect(presenceLine(1_000, null).status).toBe('online');
    });
});

describe('formatDuration', () => {
    test.each([
        [30_000, '30s'],
        [90_000, '1m 30s'],
        [3 * 3_600_000 + 4 * 60_000, '3h 4m'],
        [2 * 86_400_000 + 5 * 3_600_000, '2d 5h'],
    ])('%i ms reads as %s', (ms, expected) => {
        expect(formatDuration(ms)).toBe(expected);
    });
});

describe('the loop', () => {
    test('sets the presence immediately, not a minute from now', async () => {
        const client = start(fakeClient());
        await flush();
        expect(client.user.setPresence).toHaveBeenCalledTimes(1);
        expect(client.user.setPresence.mock.calls[0][0].activities[0].name).toBe('Uptime: 1m 0s');
        expect(health.refresh).toHaveBeenCalled();
    });

    test('does not rewrite an unchanged line', async () => {
        jest.useFakeTimers();
        const client = start(fakeClient(3 * 86_400_000));
        await flush();
        expect(client.user.setPresence).toHaveBeenCalledTimes(1);

        // A minute later the uptime still renders as "3d 0h".
        jest.advanceTimersByTime(60_000);
        await flush();
        expect(client.user.setPresence).toHaveBeenCalledTimes(1);
    });

    test('writes again the moment something breaks', async () => {
        jest.useFakeTimers();
        const client = start(fakeClient(3 * 86_400_000));
        await flush();

        health.snapshot.mockReturnValue(one(problem()));
        jest.advanceTimersByTime(60_000);
        await flush();

        expect(client.user.setPresence).toHaveBeenCalledTimes(2);
        expect(client.user.setPresence.mock.calls[1][0].status).toBe('dnd');
    });

    // Losing the timer to one failed update would freeze the line on whatever
    // it happened to say, which is worse than a stale minute.
    test('a failed update does not kill the loop', async () => {
        jest.useFakeTimers();
        const client = fakeClient();
        client.user.setPresence.mockImplementationOnce(() => { throw new Error('gateway closed'); });
        start(client);
        await flush();

        client.uptime = 120_000;
        jest.advanceTimersByTime(60_000);
        await flush();
        expect(client.user.setPresence).toHaveBeenCalledTimes(2);
    });

    // An alarm says the same thing every minute until someone fixes it, so a
    // write that failed must be retried rather than remembered as sent.
    test('a failed alarm is sent again on the next tick', async () => {
        jest.useFakeTimers();
        health.snapshot.mockReturnValue(one(problem()));
        const client = fakeClient(3 * 86_400_000);
        client.user.setPresence.mockImplementationOnce(() => { throw new Error('gateway closed'); });
        start(client);
        await flush();

        jest.advanceTimersByTime(60_000);
        await flush();
        expect(client.user.setPresence).toHaveBeenCalledTimes(2);
        expect(client.user.setPresence.mock.calls[1][0].status).toBe('dnd');
    });

    test('a client with no user yet is skipped, not crashed on', async () => {
        expect(() => start({ uptime: 1_000, user: null })).not.toThrow();
        await flush();
    });
});
