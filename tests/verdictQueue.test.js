// tests/verdictQueue.test.js
//
// Every removal through one queue, whatever decided it.
//
// The age path was queued and spaced from the start, because DM creation is
// rate-limited per bot and a raid must not burn that budget. The suspicion
// and behaviour paths removed inline: so a raid of accounts old enough to
// PASS the age gate, the exact kind the scorer exists for, was also the one
// kind allowed to fire unthrottled concurrent DMs and bans.

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

const liveSettings = {
    enabled: true,
    dry_run: false,
    dm_enabled: false,
    min_account_age_minutes: 14 * 1440,
};
jest.mock('../src/utils/joinGate/config', () => ({
    DAY_MS: 86_400_000,
    MINUTE_MS: 60_000,
    getSettings: jest.fn(async () => liveSettings),
    thresholdMs: jest.fn(() => 14 * 86_400_000),
    formatDays: jest.fn(() => '14'),
    incrementStat: jest.fn(async () => {}),
}));

const { enqueueVerdict } = require('../src/utils/joinGate/enforcement');

function fakeMember(id) {
    return {
        id,
        bannable: true,
        kickable: true,
        ban: jest.fn(async () => {}),
        kick: jest.fn(async () => {}),
        send: jest.fn(async () => {}),
        client: {},
        guild: { id: 'g1', name: 'Testable', members: { unban: jest.fn(async () => {}) } },
        user: { createdTimestamp: Date.now() - 30 * 86_400_000, username: 'aged_account' },
    };
}

const decision = (action, id) => ({
    action: 'gate',
    reason: `suspicion score 120 (malicious) [${id}]`,
    ageMs: 30 * 86_400_000,
    thresholdMs: 14 * 86_400_000,
    eligibleAt: Date.now() + 86_400_000,
    unbanKind: 'timed',
});

beforeEach(() => {
    jest.clearAllMocks();
    liveSettings.enabled = true;
    liveSettings.dry_run = false;
});

test('a queued verdict kick runs and reports its outcome', async () => {
    const member = fakeMember('u-kick');
    const outcome = await enqueueVerdict(member, { decision: decision('kick', 'u-kick'), action: 'kick', cause: 'suspicion' });
    expect(outcome.ok).toBe(true);
    expect(outcome.action).toBe('kick');
    expect(outcome.dm).toBe('disabled');
    expect(member.kick).toHaveBeenCalledTimes(1);
});

test('two verdicts are serialised, not concurrent', async () => {
    const a = fakeMember('u-a');
    const b = fakeMember('u-b');
    let aDone = false;
    a.kick.mockImplementation(async () => { await new Promise(r => setTimeout(r, 30)); aDone = true; });
    b.kick.mockImplementation(async () => {
        // By the time the second job runs, the first has fully finished.
        expect(aDone).toBe(true);
    });

    const [oa, ob] = await Promise.all([
        enqueueVerdict(a, { decision: decision('kick', 'u-a'), action: 'kick', cause: 'behaviour' }),
        enqueueVerdict(b, { decision: decision('kick', 'u-b'), action: 'kick', cause: 'behaviour' }),
    ]);
    expect(oa.ok).toBe(true);
    expect(ob.ok).toBe(true);
    expect(b.kick).toHaveBeenCalledTimes(1);
}, 15_000);

test('disarming the gate empties the line politely', async () => {
    const a = fakeMember('u-c');
    const b = fakeMember('u-d');
    a.kick.mockImplementation(async () => { liveSettings.enabled = false; });

    const [oa, ob] = await Promise.all([
        enqueueVerdict(a, { decision: decision('kick', 'u-c'), action: 'kick', cause: 'suspicion' }),
        enqueueVerdict(b, { decision: decision('kick', 'u-d'), action: 'kick', cause: 'suspicion' }),
    ]);
    expect(oa.ok).toBe(true);
    expect(ob.ok).toBe(false);
    expect(ob.benign).toBe(true);
    expect(b.kick).not.toHaveBeenCalled();
}, 15_000);
