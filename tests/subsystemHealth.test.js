// tests/subsystemHealth.test.js
//
// Two subsystems that fail quietly, and the line that now says so.
//
// The mirror stops on a rejected key and disables itself; the only trace is a
// log line and a panel nobody has open. The gate keeps scoring and filing
// reports while every removal 403s, which looks exactly like a calm week.
// Both now report to health.js, which is what turns the dot yellow.

const mockStore = new Map();

jest.mock('../src/utils/db', () => ({
    pool: { query: jest.fn(async () => ({ rows: [] })) },
    getSpeakConfigValue: jest.fn(async (key, fallback = null) => (mockStore.has(key) ? mockStore.get(key) : fallback)),
    setSpeakConfigValue: jest.fn(async (key, value) => { mockStore.set(key, value); }),
    claimTweet: jest.fn(async () => true),
    recordMirrorMessage: jest.fn(async () => {}),
    releaseTweet: jest.fn(async () => {}),
    pruneMirroredTweets: jest.fn(async () => 0),
}));
jest.mock('../src/utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../src/utils/joinGate/logging', () => ({
    logOutcome: jest.fn(async () => {}), logBurst: jest.fn(async () => {}), logSuspicion: jest.fn(async () => {}),
}));
jest.mock('../src/utils/joinGate/unbanScheduler', () => ({
    insertPendingUnban: jest.fn(async () => {}), scheduleNext: jest.fn(async () => {}),
}));

const health = require('../src/utils/health');
const { runOnce, CHANNEL_KEY, ENABLED_KEY } = require('../src/utils/tweetMirror');
const { removeMember } = require('../src/utils/joinGate/enforcement');

describe('the X mirror', () => {
    let client;

    beforeEach(() => {
        jest.clearAllMocks();
        mockStore.clear();
        health.reset();
        process.env.TWITTERAPI_KEY = 'test-key';
        mockStore.set(CHANNEL_KEY, 'chan-1');
        client = {
            channels: {
                fetch: jest.fn(async () => ({
                    isTextBased: () => true,
                    send: jest.fn(async () => ({ id: 'm1', edit: jest.fn(async () => {}) })),
                    messages: { fetch: jest.fn(async () => ({ embeds: [{}] })) },
                })),
            },
        };
        global.fetch = jest.fn();
    });

    afterEach(() => {
        delete process.env.TWITTERAPI_KEY;
        delete global.fetch;
    });

    const respond = ({ status = 200, body = null, tweets = [] } = {}) => {
        global.fetch.mockResolvedValueOnce({
            ok: status >= 200 && status < 300,
            status,
            text: async () => body ?? JSON.stringify({ tweets, has_next_page: false, next_cursor: '' }),
        });
    };

    test('a failed poll shows up on the dot', async () => {
        respond({ status: 502, body: 'bad gateway' });
        await runOnce(client);

        const snap = health.snapshot();
        expect(snap.state).toBe('degraded');
        expect(snap.worst.label).toBe('X mirror');
        expect(snap.worst.detail).toBe('Poll failed');
    });

    test('a good poll takes it back', async () => {
        respond({ status: 502, body: 'bad gateway' });
        await runOnce(client);
        expect(health.snapshot().state).toBe('degraded');

        respond({ tweets: [] });
        await runOnce(client);
        expect(health.snapshot().state).toBe('ok');
    });

    // A key that gets rejected disables the mirror for good, which is as bad as
    // this subsystem gets. It still must not turn the dot red: the bot is
    // working, one feature is not, and red is reserved for the bot itself.
    test('even a rejected key stays yellow', async () => {
        respond({ status: 401, body: 'no' });
        await runOnce(client);

        expect(health.snapshot().state).toBe('degraded');
        expect(health.snapshot().worst.detail).toContain('API key rejected');
        expect(mockStore.get(ENABLED_KEY)).toBe(false);
    });
});

describe('the join gate', () => {
    const decision = { reason: 'account too new', eligibleAt: Date.now() + 86_400_000 };
    const member = (over = {}) => ({
        guild: { id: 'g1' },
        id: 'u1',
        kickable: true,
        bannable: true,
        kick: jest.fn(async () => {}),
        ban: jest.fn(async () => {}),
        client: {},
        ...over,
    });

    beforeEach(() => {
        jest.clearAllMocks();
        health.reset();
    });

    test('a gate that can act says nothing', async () => {
        const result = await removeMember(member(), {}, decision, 'kick');
        expect(result.ok).toBe(true);
        expect(health.snapshot().state).toBe('ok');
    });

    test('a gate that cannot kick says so, in words a person can act on', async () => {
        const result = await removeMember(member({ kickable: false }), {}, decision, 'kick');

        expect(result.ok).toBe(false);
        const snap = health.snapshot();
        expect(snap.state).toBe('degraded');
        expect(snap.worst.label).toBe('Join gate');
        expect(snap.worst.detail).toContain('cannot kick');
    });

    test('a 403 from Discord counts the same as a missing permission', async () => {
        const denied = Object.assign(new Error('Missing Permissions'), { code: 50013 });
        await removeMember(member({ kick: jest.fn(async () => { throw denied; }) }), {}, decision, 'kick');

        expect(health.snapshot().worst.detail).toContain('missing permissions');
    });

    // Someone leaving before the kick lands is not a broken gate, and a dot
    // that goes yellow every time a spammer beats us to the door is a dot
    // nobody trusts.
    test('a member who already left is not a fault', async () => {
        const gone = Object.assign(new Error('Unknown Member'), { code: 10007 });
        await removeMember(member({ kick: jest.fn(async () => { throw gone; }) }), {}, decision, 'kick');

        expect(health.snapshot().state).toBe('ok');
    });

    test('one working kick clears an earlier failure', async () => {
        await removeMember(member({ kickable: false }), {}, decision, 'kick');
        expect(health.snapshot().state).toBe('degraded');

        await removeMember(member(), {}, decision, 'kick');
        expect(health.snapshot().state).toBe('ok');
    });
});
