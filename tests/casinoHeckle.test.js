// tests/casinoHeckle.test.js
//
// Heckling fails silently by nature: every failure path ends with nothing
// being said, which is also what success looks like when the dice are quiet.
// These pin the parts that made silence permanent rather than momentary, and
// the parts that explain themselves afterwards.

const mockStore = new Map();
const mockSettings = new Map();

jest.mock('../src/utils/db', () => ({
    storeConversationMemory: jest.fn(async () => {}),
    getSpeakConfigValue: jest.fn(async (key, fallback) => (mockStore.has(key) ? mockStore.get(key) : fallback)),
    setSpeakConfigValue: jest.fn(async (key, value) => { mockStore.set(key, value); }),
    isUserBlacklisted: jest.fn(async () => false),
}));

jest.mock('../src/utils/casinoConfig', () => ({
    getSetting: jest.fn(async key => mockSettings.get(key)),
}));

jest.mock('../src/utils/apiHelpers', () => ({
    callOpenRouterAPI: jest.fn(async () => 'You had one job and the job had two cards.'),
}));

const { callOpenRouterAPI } = require('../src/utils/apiHelpers');
const { storeConversationMemory, isUserBlacklisted } = require('../src/utils/db');
const { considerHeckle, lastHeckleResult, LAST_HECKLE_KEY } = require('../src/utils/casinoHeckle');

const channel = (overrides = {}) => ({
    id: 'c1',
    isTextBased: () => true,
    send: jest.fn(async () => {}),
    ...overrides,
});

const bust = (ch) => considerHeckle({
    channel: ch, userId: 'u1', username: 'Moksi',
    game: 'blackjack', wagered: 120_000, returned: 0,
});

beforeEach(() => {
    mockStore.clear();
    mockSettings.clear();
    mockSettings.set('heckle_enabled', true);
    mockSettings.set('heckle_threshold', 20_000);
    mockSettings.set('heckle_cooldown_seconds', 0);
    jest.clearAllMocks();
    callOpenRouterAPI.mockResolvedValue('You had one job and the job had two cards.');
    isUserBlacklisted.mockResolvedValue(false);
});

describe('heckling a big swing', () => {
    test('a qualifying bust gets a line and a memory', async () => {
        const ch = channel();
        await bust(ch);
        expect(ch.send).toHaveBeenCalledTimes(1);
        expect(storeConversationMemory).toHaveBeenCalledTimes(1);
        expect((await lastHeckleResult()).reason).toBe('spoke');
    });

    test('a zero cooldown means every swing, not one and then silence', async () => {
        const ch = channel();
        await bust(ch);
        await bust(ch);
        await bust(ch);
        expect(ch.send).toHaveBeenCalledTimes(3);
    });

    test('a cooldown still holds when one is set', async () => {
        mockSettings.set('heckle_cooldown_seconds', 600);
        const ch = channel();
        await bust(ch);
        await bust(ch);
        expect(ch.send).toHaveBeenCalledTimes(1);
        expect((await lastHeckleResult()).reason).toBe('cooling down');
    });

    test('a swing under the threshold is not remarked on at all', async () => {
        const ch = channel();
        await considerHeckle({
            channel: ch, userId: 'u1', username: 'Moksi',
            game: 'slots', wagered: 100, returned: 0,
        });
        expect(ch.send).not.toHaveBeenCalled();
        expect(storeConversationMemory).not.toHaveBeenCalled();
    });
});

describe('when it cannot speak', () => {
    // The bug this replaces: a throw from send() skipped both the cooldown
    // release and the memory write, so one missing permission bought a full
    // cooldown of silence and lost the memory with it.
    test('a failed send releases the cooldown instead of burning it', async () => {
        mockSettings.set('heckle_cooldown_seconds', 600);
        mockStore.set(LAST_HECKLE_KEY, 0);
        const ch = channel({ send: jest.fn(async () => { throw new Error('Missing Permissions'); }) });

        await bust(ch);
        expect(Number(mockStore.get(LAST_HECKLE_KEY))).toBe(0);
        const result = await lastHeckleResult();
        expect(result.reason).toBe('failed');
        expect(result.error).toContain('Missing Permissions');
    });

    test('a failed send still writes the memory: watching quietly is the useful half', async () => {
        const ch = channel({ send: jest.fn(async () => { throw new Error('nope'); }) });
        await bust(ch);
        expect(storeConversationMemory).toHaveBeenCalledTimes(1);
        expect(storeConversationMemory.mock.calls[0][3]).toContain('noticed');
    });

    test('missing send permission is named, and costs no model call', async () => {
        const ch = channel({
            guild: { members: { me: {} } },
            permissionsFor: () => ({ has: () => false }),
        });
        await bust(ch);
        expect(ch.send).not.toHaveBeenCalled();
        expect(callOpenRouterAPI).not.toHaveBeenCalled();
        expect((await lastHeckleResult()).reason).toContain('permission');
    });

    test('an empty model reply releases the cooldown and says so', async () => {
        mockSettings.set('heckle_cooldown_seconds', 600);
        mockStore.set(LAST_HECKLE_KEY, 0);
        callOpenRouterAPI.mockResolvedValue(null);
        const ch = channel();

        await bust(ch);
        expect(ch.send).not.toHaveBeenCalled();
        expect(Number(mockStore.get(LAST_HECKLE_KEY))).toBe(0);
        expect((await lastHeckleResult()).reason).toContain('nothing');
    });

    test('a player who opted out of Moksi is left alone, and it is recorded', async () => {
        isUserBlacklisted.mockResolvedValue(true);
        const ch = channel();
        await bust(ch);
        expect(ch.send).not.toHaveBeenCalled();
        expect(storeConversationMemory).not.toHaveBeenCalled();
        expect((await lastHeckleResult()).reason).toContain('opted out');
    });

    test('heckling off means nothing happens, quietly', async () => {
        mockSettings.set('heckle_enabled', false);
        const ch = channel();
        await bust(ch);
        expect(ch.send).not.toHaveBeenCalled();
        expect(await lastHeckleResult()).toBeNull();
    });
});
