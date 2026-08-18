// tests/burstWindow.test.js
//
// The burst window, and the two couplings it used to have.
//
// First: turning the burst ALERT off also stopped the window being written,
// which silently killed the join_burst signal the profile scorer feeds on.
// Recording and alerting are separate concerns; the toggle silences the
// announcement and nothing else.
//
// Second: only gated joins were ever counted, so a raid of accounts old
// enough to pass the age gate produced no burst at all. Counting every join
// fixes that, but a popular invite is not a raid, so it is opt-in
// (burst_count_all_joins, off by default) and the alert reports the mix.

jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/utils/health', () => ({ report: jest.fn() }));
jest.mock('../src/utils/db', () => ({
    pool: { query: jest.fn(async () => ({ rows: [] })) },
}));
jest.mock('../src/utils/joinGate/unbanScheduler', () => ({
    insertPendingUnban: jest.fn(async () => {}),
    scheduleNext: jest.fn(async () => {}),
}));
jest.mock('../src/utils/joinGate/logging', () => ({
    logOutcome: jest.fn(async () => {}),
    logBurst: jest.fn(async () => {}),
    logSuspicion: jest.fn(async () => {}),
}));
jest.mock('../src/utils/joinGate/invites', () => ({
    resolveJoin: jest.fn(async () => null),
}));
jest.mock('../src/utils/joinGate/activity', () => ({
    countsForGuild: jest.fn(async () => new Map()),
    trackingSince: jest.fn(async () => 0),
}));

const { logBurst } = require('../src/utils/joinGate/logging');
const { isInBurst, noteJoinForBurst } = require('../src/utils/joinGate/enforcement');

const settings = (over = {}) => ({
    burst_alert_enabled: true,
    burst_count_all_joins: false,
    burst_threshold: 3,
    burst_window_seconds: 60,
    ...over,
});

// Every test gets its own guild id: the window is module state.
let n = 0;
const guild = () => ({ id: `burst-guild-${n++}` });

beforeEach(() => jest.clearAllMocks());

describe('recording is not alerting', () => {
    test('gated joins fill the window even with the alert switched off', () => {
        const g = guild();
        const s = settings({ burst_alert_enabled: false });
        noteJoinForBurst(g, s, { gated: true });
        noteJoinForBurst(g, s, { gated: true });
        noteJoinForBurst(g, s, { gated: true });
        expect(isInBurst(g.id, s)).toBe(true);
        expect(logBurst).not.toHaveBeenCalled();
    });

    test('with the alert on, crossing the threshold announces once', () => {
        const g = guild();
        const s = settings();
        noteJoinForBurst(g, s, { gated: true });
        noteJoinForBurst(g, s, { gated: true });
        expect(logBurst).not.toHaveBeenCalled();
        noteJoinForBurst(g, s, { gated: true });
        expect(logBurst).toHaveBeenCalledTimes(1);
        // The cooldown keeps one raid from being two hundred alerts.
        noteJoinForBurst(g, s, { gated: true });
        expect(logBurst).toHaveBeenCalledTimes(1);
    });
});

describe('clean joins are opt-in', () => {
    test('by default a wave of clean joins is invisible, as before', () => {
        const g = guild();
        const s = settings();
        for (let i = 0; i < 5; i++) noteJoinForBurst(g, s, { gated: false });
        expect(isInBurst(g.id, s)).toBe(false);
        expect(logBurst).not.toHaveBeenCalled();
    });

    test('opted in, an aged-account raid is at least visible as a surge', () => {
        const g = guild();
        const s = settings({ burst_count_all_joins: true });
        noteJoinForBurst(g, s, { gated: false });
        noteJoinForBurst(g, s, { gated: false });
        noteJoinForBurst(g, s, { gated: false });
        expect(isInBurst(g.id, s)).toBe(true);
        expect(logBurst).toHaveBeenCalledTimes(1);
    });

    test('the alert is told the mix, so a clean surge never reads as a raid', () => {
        const g = guild();
        const s = settings({ burst_count_all_joins: true });
        noteJoinForBurst(g, s, { gated: false });
        noteJoinForBurst(g, s, { gated: true });
        noteJoinForBurst(g, s, { gated: false });
        expect(logBurst).toHaveBeenCalledWith(g, s, expect.objectContaining({
            count: 3,
            gatedCount: 1,
        }));
    });
});
