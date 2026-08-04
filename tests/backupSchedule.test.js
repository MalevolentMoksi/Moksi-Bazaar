// tests/backupSchedule.test.js
//
// The weekly slot's one real hazard: a transient failure (a Discord outage,
// closed DMs) silently costing a full week of backups. These pin that a
// failed run comes back around at the next check, and a successful one does
// not.

const mockStore = new Map();

jest.mock('../src/utils/db', () => ({
    pool: { query: jest.fn() },
    getSpeakConfigValue: jest.fn(async (key, fallback) => (mockStore.has(key) ? mockStore.get(key) : fallback)),
    setSpeakConfigValue: jest.fn(async (key, value) => { mockStore.set(key, value); }),
}));

const { checkAndRun, LAST_RUN_KEY, CHANNEL_KEY } = require('../src/utils/backup');

const SIX_HOURS = 6 * 60 * 60 * 1000;
const WEEK = 7 * 24 * 60 * 60 * 1000;

const fakeClient = { guilds: { cache: new Map() } };

beforeEach(() => {
    mockStore.clear();
    mockStore.set(CHANNEL_KEY, 'c1');
});

describe('the weekly backup slot', () => {
    test('a failed run is retried at the next check, not next week', async () => {
        const send = jest.fn(async () => ({ ok: false, sentTo: [], errors: ['Discord said no'] }));
        await checkAndRun(fakeClient, { send });

        expect(send).toHaveBeenCalledTimes(1);
        const stamped = Number(mockStore.get(LAST_RUN_KEY));
        const dueIn = stamped + WEEK - Date.now();
        expect(dueIn).toBeLessThanOrEqual(SIX_HOURS + 1000);
        expect(dueIn).toBeGreaterThan(0);
    });

    test('a successful run holds the slot for a week', async () => {
        const send = jest.fn(async () => ({
            ok: true, sentTo: ['DM'], errors: [],
            meta: { tables: 1, totalRows: 1, counts: {}, truncated: [], bytes: 10 },
        }));
        await checkAndRun(fakeClient, { send });

        const dueIn = Number(mockStore.get(LAST_RUN_KEY)) + WEEK - Date.now();
        expect(dueIn).toBeGreaterThan(WEEK - 60_000);
    });

    test('a run that is not due yet does nothing at all', async () => {
        mockStore.set(LAST_RUN_KEY, Date.now() - 60_000);
        const send = jest.fn();
        await checkAndRun(fakeClient, { send });
        expect(send).not.toHaveBeenCalled();
    });
});
