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
const { deliverDueReminder, isStillPresent } = require('../src/utils/warnReminderScheduler');

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
    // No guilds accessor: membership is unknowable, which must always fall
    // through to sending. These fixtures are about DELIVERY, not presence.
});

/** A client whose guild either has the member or does not. */
const clientWithMember = (channel, { present, code = 10007 }) => ({
    channels: { fetch: jest.fn(async () => channel) },
    guilds: {
        fetch: jest.fn(async () => ({
            members: {
                fetch: jest.fn(async () => {
                    if (present) return { id: 'u1' };
                    const err = new Error('Unknown Member');
                    err.code = code;
                    throw err;
                }),
            },
        })),
    },
});

const queriesRun = () => pool.query.mock.calls.map(([sql]) => sql.trim().split(/\s+/)[0].toUpperCase());

beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rows: [] });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
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

// ── Is there anybody left to remind? ────────────────────────────────────────
//
// A reminder fired at 19:21 asking staff to review a warning, and the answer
// from staff was "He left its okay". The reminder had done work for nobody.
//
// Membership is checked at FIRE time and never at warn time, because someone
// can be warned, leave, and come back inside the thirty days, and only the
// state at the moment of reminding decides anything.
//
// The three-valued result is the careful part: "unknowable" is not "absent".
// A reminder from before ids were recorded, a missing intent or a network
// blip must never be read as "they left", because a dropped reminder about
// somebody still present is the exact failure this feature exists to prevent.
describe('a reminder about somebody who left', () => {
    const withId = { ...reminder, id: 'presence-1', user_id: 'u1' };

    test('is dropped without being sent', async () => {
        const channel = { send: jest.fn(async () => {}) };
        await deliverDueReminder(clientWithMember(channel, { present: false }), withId);
        expect(channel.send).not.toHaveBeenCalled();
        expect(queriesRun()).toEqual(['DELETE']);
    });

    test('and a deleted account counts as gone too', async () => {
        const channel = { send: jest.fn(async () => {}) };
        await deliverDueReminder(clientWithMember(channel, { present: false, code: 10013 }), withId);
        expect(channel.send).not.toHaveBeenCalled();
        expect(queriesRun()).toEqual(['DELETE']);
    });

    test('but somebody still here gets the reminder as normal', async () => {
        const channel = { send: jest.fn(async () => {}) };
        await deliverDueReminder(clientWithMember(channel, { present: true }), withId);
        expect(channel.send).toHaveBeenCalledTimes(1);
        expect(queriesRun()).toEqual(['DELETE']);
    });
});

describe('unknowable is never treated as absent', () => {
    const present = (client, over = {}) => isStillPresent(client, { ...reminder, user_id: 'u1', ...over });

    test('a reminder with no resolved account cannot be judged', async () => {
        expect(await present(clientWithMember({}, { present: false }), { user_id: null })).toBeNull();
    });

    test('an unreachable guild cannot be judged', async () => {
        const client = { guilds: { fetch: jest.fn(async () => { throw new Error('nope'); }) } };
        expect(await present(client)).toBeNull();
    });

    test('an unexpected API failure cannot be judged', async () => {
        const client = {
            guilds: {
                fetch: jest.fn(async () => ({
                    members: { fetch: jest.fn(async () => { throw new Error('503 service unavailable'); }) },
                })),
            },
        };
        expect(await present(client)).toBeNull();
    });

    test('and an unknowable reminder is still sent', async () => {
        const channel = { send: jest.fn(async () => {}) };
        // No guilds accessor at all: the legacy shape.
        await deliverDueReminder(clientWith(channel), { ...reminder, id: 'legacy-1', user_id: null });
        expect(channel.send).toHaveBeenCalledTimes(1);
    });

    test('a real absence is still reported as absence', async () => {
        expect(await present(clientWithMember({}, { present: false }))).toBe(false);
        expect(await present(clientWithMember({}, { present: true }))).toBe(true);
    });
});
