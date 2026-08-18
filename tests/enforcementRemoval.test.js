// tests/enforcementRemoval.test.js
//
// The failure domains of a temp-ban, kept separate.
//
// A ban is two promises made in one breath: you are removed, and it lifts at
// an exact hour. The removal is an API call, the lift is a database row, and
// for a while they shared one try block, so a database hiccup produced a
// PERMANENT ban wearing a log line that said no ban had happened, minutes
// after a DM promised the user when it would end. If the row cannot be
// written, the ban is walked back: this gate temp-bans or it does not ban.

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

const { insertPendingUnban, scheduleNext } = require('../src/utils/joinGate/unbanScheduler');
const { removeMember, applyTimeout, evaluate } = require('../src/utils/joinGate/enforcement');
const { DEFAULTS } = require('../src/utils/joinGate/config');

const settings = { ...DEFAULTS, enabled: true, min_account_age_minutes: 7 * 24 * 60 };

function fakeMember(over = {}) {
    return {
        id: 'u1',
        bannable: true,
        kickable: true,
        ban: jest.fn(async () => {}),
        kick: jest.fn(async () => {}),
        timeout: jest.fn(async () => {}),
        client: {},
        guild: {
            id: 'g1',
            members: { unban: jest.fn(async () => {}) },
        },
        user: { createdTimestamp: Date.now() - 3_600_000 },
        ...over,
    };
}

const decision = {
    action: 'gate',
    reason: 'account is 0.04d old, minimum is 7d',
    ageMs: 3_600_000,
    thresholdMs: 7 * 86_400_000,
    eligibleAt: Date.now() + 6 * 86_400_000,
};

beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks keeps implementations, so a rejection installed by one
    // test would leak into the next; pin the happy path back explicitly.
    insertPendingUnban.mockResolvedValue(undefined);
    scheduleNext.mockResolvedValue(undefined);
});

describe('a temp-ban whose lift cannot be recorded', () => {
    test('the happy path bans once and schedules the lift', async () => {
        const member = fakeMember();
        const result = await removeMember(member, settings, decision, 'ban');
        expect(result.ok).toBe(true);
        expect(result.unbanAt).toBe(decision.eligibleAt);
        expect(member.ban).toHaveBeenCalledTimes(1);
        expect(insertPendingUnban).toHaveBeenCalledTimes(1);
        expect(member.guild.members.unban).not.toHaveBeenCalled();
    });

    test('one failed write is retried, not walked back', async () => {
        insertPendingUnban.mockRejectedValueOnce(new Error('deadlock'));
        const member = fakeMember();
        const result = await removeMember(member, settings, decision, 'ban');
        expect(result.ok).toBe(true);
        expect(insertPendingUnban).toHaveBeenCalledTimes(2);
        expect(member.guild.members.unban).not.toHaveBeenCalled();
    });

    test('two failed writes walk the ban back', async () => {
        insertPendingUnban.mockRejectedValue(new Error('db down'));
        const member = fakeMember();
        const result = await removeMember(member, settings, decision, 'ban');
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/walked back/);
        expect(member.ban).toHaveBeenCalledTimes(1);
        expect(member.guild.members.unban).toHaveBeenCalledTimes(1);
    });

    test('a scheduling hiccup is not a reason to walk anything back', async () => {
        scheduleNext.mockRejectedValueOnce(new Error('timer trouble'));
        const member = fakeMember();
        const result = await removeMember(member, settings, decision, 'ban');
        expect(result.ok).toBe(true);
        expect(member.guild.members.unban).not.toHaveBeenCalled();
    });
});

describe('one timeout, both scoring paths', () => {
    test('applies the configured minutes and says so', async () => {
        const member = fakeMember();
        const result = await applyTimeout(member, { ...settings, watch_timeout_minutes: 30 }, 'why');
        expect(result).toEqual({ ok: true, action: 'timeout', minutes: 30 });
        expect(member.timeout).toHaveBeenCalledWith(30 * 60_000, 'why');
    });

    test('a broken duration setting still times out for something', async () => {
        const member = fakeMember();
        const result = await applyTimeout(member, { watch_timeout_minutes: 'soon' }, 'why');
        expect(result.ok).toBe(true);
        expect(result.minutes).toBe(60);
    });

    test('a member the bot cannot touch reports the failure instead of throwing', async () => {
        const member = fakeMember({ timeout: jest.fn(async () => { throw new Error('Missing Permissions'); }) });
        const result = await applyTimeout(member, settings, 'why');
        expect(result).toEqual({ ok: false, action: 'timeout', error: 'Missing Permissions' });
    });
});

describe('an unreadable account age fails open', () => {
    test('a missing createdTimestamp falls back to the snowflake', () => {
        // A snowflake from 2015: unquestionably old enough.
        const verdict = evaluate({ id: '155149108183695360', bot: false, createdTimestamp: undefined }, settings);
        expect(verdict.action).toBe('allow');
        expect(verdict.reason).toMatch(/old/);
    });

    test('no timestamp and no readable snowflake means allow, never gate', () => {
        const verdict = evaluate({ id: 'not-a-snowflake', bot: false, createdTimestamp: NaN }, settings);
        expect(verdict.action).toBe('allow');
        expect(verdict.reason).toMatch(/failing open/);
    });
});
