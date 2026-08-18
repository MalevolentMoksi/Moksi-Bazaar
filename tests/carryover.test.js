// tests/carryover.test.js
//
// The deploy carry, round-tripped.
//
// restore.js re-derives who should be watched from what Discord still knows.
// What it cannot re-derive is what only the dying process knew: the messages
// inside each watch window, the signals that already fired, the score a
// report already went out at, and the burst window. This pins the round
// trip: park it, boot "again", get the same member mid-sweep instead of a
// stranger with a clean scoreboard.

jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/utils/health', () => ({ report: jest.fn() }));
jest.mock('../src/utils/joinGate/unbanScheduler', () => ({
    insertPendingUnban: jest.fn(async () => {}),
    scheduleNext: jest.fn(async () => {}),
}));
jest.mock('../src/utils/joinGate/logging', () => ({
    logOutcome: jest.fn(async () => {}),
    logBurst: jest.fn(async () => {}),
    logSuspicion: jest.fn(async () => {}),
}));
jest.mock('../src/utils/joinGate/invites', () => ({ resolveJoin: jest.fn(async () => null) }));
jest.mock('../src/utils/joinGate/activity', () => ({
    countsForGuild: jest.fn(async () => new Map()),
    trackingSince: jest.fn(async () => 0),
}));

// A one-row database, which is all the carryover uses.
let mockStoredRow = null;
jest.mock('../src/utils/db', () => ({
    pool: {
        query: jest.fn(async (sql, params) => {
            const verb = sql.trim().split(/\s+/)[0].toUpperCase();
            if (verb === 'INSERT') {
                mockStoredRow = { payload: JSON.parse(params[1]), saved_at_ms: params[2] };
                return { rows: [] };
            }
            if (verb === 'SELECT') return { rows: mockStoredRow ? [mockStoredRow] : [] };
            if (verb === 'DELETE') { mockStoredRow = null; return { rows: [] }; }
            return { rows: [] };
        }),
    },
}));

const watch = require('../src/utils/joinGate/watch');
const enforcement = require('../src/utils/joinGate/enforcement');
const carryover = require('../src/utils/joinGate/carryover');

const GUILD = 'carry-guild';
const USER = 'carry-user';
const WINDOW_MS = 10 * 60_000;

const ADVERT = '@everyone come over https://discord.gg/elsewhere';

function message(content, channelId, id) {
    return {
        id,
        content,
        channelId,
        author: { id: USER },
        mentions: { everyone: true, users: { size: 0 }, roles: { size: 0 } },
    };
}

beforeEach(() => {
    mockStoredRow = null;
    watch.reset();
});

test('the watch window survives a park-and-boot with its memory intact', async () => {
    // A member mid-sweep: watched, one advert seen, already reported.
    watch.watchMember(GUILD, USER);
    const before = watch.inspectMessage(GUILD, message(ADVERT, 'chan-a', 'm1'), {
        windowMs: WINDOW_MS, threshold: 100,
    });
    expect(before.score).toBeGreaterThan(0);
    watch.markReported(GUILD, USER, before.score);

    const parked = await carryover.save();
    expect(parked.watched).toBe(1);

    // "New process": empty memory.
    watch.reset();
    expect(watch.watchedCount(GUILD)).toBe(0);

    const recovered = await carryover.load(() => WINDOW_MS);
    expect(recovered.watched).toBe(1);
    expect(watch.watchedCount(GUILD)).toBe(1);

    // The evidence is back.
    const evidence = watch.evidenceFor(GUILD, USER);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].content).toContain('discord.gg/elsewhere');

    // And the reported score is back: the same advert again does NOT
    // re-report, exactly as it would not have without the deploy.
    const again = watch.inspectMessage(GUILD, message(ADVERT, 'chan-a', 'm1'), {
        windowMs: WINDOW_MS, threshold: 100,
    });
    expect(again.score).toBe(before.score);
    expect(again.report).toBe(false);
});

test('the row is consumed: a second boot restores nothing', async () => {
    watch.watchMember(GUILD, USER);
    watch.inspectMessage(GUILD, message(ADVERT, 'chan-a', 'm1'), { windowMs: WINDOW_MS });
    await carryover.save();

    watch.reset();
    await carryover.load(() => WINDOW_MS);
    watch.reset();
    const second = await carryover.load(() => WINDOW_MS);
    expect(second).toBeNull();
    expect(watch.watchedCount(GUILD)).toBe(0);
});

test('entries outside their window age out instead of being resurrected', async () => {
    // Joined eleven minutes ago, window is ten: parked, but expired by boot.
    watch.watchMember(GUILD, USER, Date.now() - 11 * 60_000);
    await carryover.save();

    watch.reset();
    const recovered = await carryover.load(() => WINDOW_MS);
    expect(recovered?.watched ?? 0).toBe(0);
    expect(watch.watchedCount(GUILD)).toBe(0);
});

test('the burst window rides along', async () => {
    const g = { id: 'carry-burst-guild' };
    const settings = { burst_alert_enabled: false, burst_count_all_joins: false, burst_threshold: 3, burst_window_seconds: 600 };
    enforcement.noteJoinForBurst(g, settings, { gated: true });
    enforcement.noteJoinForBurst(g, settings, { gated: true });

    await carryover.save();
    // A fresh process would have an empty window for this guild; the import
    // overwrites whatever is there, so loading is enough to test the ride.
    const recovered = await carryover.load(() => WINDOW_MS);
    expect(recovered.bursts).toBeGreaterThanOrEqual(2);
    enforcement.noteJoinForBurst(g, settings, { gated: true });
    expect(enforcement.isInBurst(g.id, settings)).toBe(true);
});
