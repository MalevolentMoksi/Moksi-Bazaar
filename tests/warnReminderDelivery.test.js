// tests/warnReminderDelivery.test.js
//
// A reminder that cannot be sent, and what it must never do again.
//
// The row used to be deleted only on the success path, so a failed send
// rescheduled against a still-overdue row, computed a delay of zero, and
// went again: a full-speed retry loop of two queries, a channel fetch and a
// rejected send, forever. The other failure was quieter: an unfetchable
// channel returned early, the caller deleted the row anyway, and the
// reminder simply ceased to exist.
//
// Now: delivered means deleted, failed means deferred with growing backoff
// (persisted, so a restart cannot resume the loop), and giving up is loud.

jest.mock('../src/utils/db', () => ({
    pool: { query: jest.fn(async () => ({ rows: [] })) },
}));

const { pool } = require('../src/utils/db');
const { deliverDueReminder } = require('../src/utils/warnReminderScheduler');

const reminder = {
    id: 'r1',
    channel_id: 'chan-1',
    guild_id: 'g1',
    warned_user: 'somebody',
    warn_ids: null,
    warn_count: 1,
    due_at_utc_ms: String(Date.now() - 1000),
};

const clientWith = channel => ({
    channels: { fetch: jest.fn(async () => { if (!channel) throw new Error('Unknown Channel'); return channel; }) },
});

const queriesRun = () => pool.query.mock.calls.map(([sql]) => sql.trim().split(/\s+/)[0].toUpperCase());

beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rows: [] });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

test('a delivered reminder is deleted', async () => {
    const channel = { send: jest.fn(async () => {}) };
    await deliverDueReminder(clientWith(channel), { ...reminder, id: 'ok-1' });
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(queriesRun()).toEqual(['DELETE']);
});

test('an unfetchable channel defers the row instead of deleting it', async () => {
    await deliverDueReminder(clientWith(null), { ...reminder, id: 'gone-1' });
    expect(queriesRun()).toEqual(['UPDATE']);
    // The deferral is into the future: that is the whole anti-hot-loop.
    const [, params] = pool.query.mock.calls[0];
    expect(Number(params[1])).toBeGreaterThan(Date.now());
});

test('a failing send defers with growing backoff, then gives up loudly', async () => {
    const channel = { send: jest.fn(async () => { throw new Error('Missing Access'); }) };
    const client = clientWith(channel);
    const id = 'stubborn-1';

    const deferredTo = [];
    for (let attempt = 1; attempt <= 8; attempt++) {
        pool.query.mockClear();
        await deliverDueReminder(client, { ...reminder, id });
        const kinds = queriesRun();
        if (attempt < 8) {
            expect(kinds).toEqual(['UPDATE']);
            deferredTo.push(Number(pool.query.mock.calls[0][1][1]));
        } else {
            // The eighth failure stops retrying, deletes, and says so.
            expect(kinds).toEqual(['DELETE']);
            expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Giving up'));
        }
    }

    // Backoff grows: each deferral lands later than the one before it.
    for (let i = 1; i < deferredTo.length; i++) {
        expect(deferredTo[i]).toBeGreaterThan(deferredTo[i - 1]);
    }
});
