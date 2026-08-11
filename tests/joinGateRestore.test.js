// tests/joinGateRestore.test.js
//
// What a deploy used to cost the moderation stack.
//
// Three of the things that decide whether a newcomer is a problem lived only
// in the process, and Railway replaces the process on every push. The worst of
// them was the behaviour window: watchMember is called from exactly one place,
// the guildMemberAdd handler, and nothing re-armed it. A member who joined two
// minutes before a deploy was never watched again, because the only event that
// could start watching them had already happened.
//
// So a spammer who joined and waited (waiting is the entire reason that window
// exists) scored zero for everything they then posted. The 102 that earned a
// timeout on 2026-08-11 would have been a nothing.

jest.mock('../src/utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../src/utils/db', () => ({
    pool: { query: jest.fn(async () => ({ rows: [] })) },
    getSpeakConfigValue: jest.fn(async () => null),
    setSpeakConfigValue: jest.fn(async () => {}),
}));
jest.mock('../src/utils/joinGate/logging', () => ({
    logOutcome: jest.fn(async () => {}), logBurst: jest.fn(async () => {}), logSuspicion: jest.fn(async () => {}),
}));

const { AuditLogEvent } = require('discord.js');
const restore = require('../src/utils/joinGate/restore');
const watch = require('../src/utils/joinGate/watch');
const suspicion = require('../src/utils/joinGate/suspicion');
const guard = require('../src/utils/joinGate/guard');
const { DEFAULTS } = require('../src/utils/joinGate/config');

const NOW = 1_760_000_000_000;
const MINUTE = 60_000;

const settings = (over = {}) => ({
    ...DEFAULTS, enabled: true, watch_enabled: true, watch_window_minutes: 10, ...over,
});

/** A member as discord.js hands it over, minutes after joining. */
const member = (id, joinedMinutesAgo, over = {}) => ({
    id,
    joinedTimestamp: NOW - joinedMinutesAgo * MINUTE,
    guild: { id: 'g1', roles: { cache: new Map() }, members: { cache: new Map() } },
    user: {
        id,
        bot: false,
        username: over.username ?? `user${id}`,
        avatar: over.avatar ?? null,
        createdTimestamp: over.createdTimestamp ?? NOW - 400 * 24 * 3_600_000,
        flags: { has: () => false },
        ...over.user,
    },
    ...over.member,
});

const guildWith = (members, { auditEntries = null } = {}) => ({
    id: 'g1',
    roles: { cache: new Map() },
    members: { fetch: jest.fn(async () => new Map(members.map(m => [m.id, m]))) },
    fetchAuditLogs: auditEntries
        ? jest.fn(async () => ({ entries: new Map(auditEntries.map((e, i) => [String(i), e])) }))
        : jest.fn(async () => { throw new Error('Missing Permissions'); }),
});

beforeEach(() => {
    jest.clearAllMocks();
    watch.reset();
    suspicion.resetCorrelation();
    guard.clear();
});

describe('the behaviour window comes back', () => {
    test('a member still inside their window is watched again', async () => {
        const guild = guildWith([member('u1', 3)]);
        const result = await restore.restoreGuild(guild, settings(), { now: NOW });

        expect(result.watched).toBe(1);
        expect(watch.isWatched('g1', 'u1', 10 * MINUTE, NOW)).toBe(true);
    });

    // The whole point: the messages they post AFTER the restart have to score.
    test('and what they post next is scored, instead of vanishing', async () => {
        const guild = guildWith([member('u1', 3)]);
        await restore.restoreGuild(guild, settings(), { now: NOW });

        const result = watch.inspectMessage('g1', {
            content: '@everyone join https://discord.gg/abcdef',
            channelId: 'c1',
            author: { id: 'u1' },
            mentions: { everyone: true, users: { size: 0 }, roles: { size: 0 } },
        }, { windowMs: 10 * MINUTE, threshold: 100, now: NOW });

        // The live incident's score, which used to be 0 after a deploy.
        expect(result.score).toBe(102);
        expect(result.report).toBe(true);
    });

    test('the window expires when it would have, not a fresh ten minutes', async () => {
        const guild = guildWith([member('u1', 9)]);
        await restore.restoreGuild(guild, settings(), { now: NOW });

        // One minute of their window is left, so two minutes later it is shut.
        expect(watch.isWatched('g1', 'u1', 10 * MINUTE, NOW + 2 * MINUTE)).toBe(false);
    });

    test('members past the window are left alone', async () => {
        const guild = guildWith([member('u1', 40), member('u2', 11)]);
        const result = await restore.restoreGuild(guild, settings(), { now: NOW });

        expect(result.watched).toBe(0);
        expect(watch.isWatched('g1', 'u2', 10 * MINUTE, NOW)).toBe(false);
    });

    test('bots are not watched', async () => {
        const bot = member('b1', 2);
        bot.user.bot = true;
        const result = await restore.restoreGuild(guildWith([bot]), settings(), { now: NOW });
        expect(result.watched).toBe(0);
    });

    test('nothing happens when the window is switched off', async () => {
        const guild = guildWith([member('u1', 2)]);
        const result = await restore.restoreGuild(guild, settings({ watch_enabled: false }), { now: NOW });
        expect(result.watched).toBe(0);
    });

    // A restart is not evidence. The restore may watch and score; it may never
    // remove anybody, or the bot would hand out punishments on every deploy.
    test('it never removes anyone, whatever the profile scores', async () => {
        const brandNew = member('u1', 1, { createdTimestamp: NOW - 60_000, username: 'discordnitro-free' });
        brandNew.kick = jest.fn();
        brandNew.ban = jest.fn();

        await restore.restoreGuild(guildWith([brandNew]), settings(), { now: NOW });

        expect(brandNew.kick).not.toHaveBeenCalled();
        expect(brandNew.ban).not.toHaveBeenCalled();
    });
});

describe('the carry-over comes back', () => {
    test('a profile that looked wrong on arrival still lowers the bar', async () => {
        // Brand-new account, scam-flavoured name: enough to score on the
        // profile alone, which is what prior_suspicion carries.
        const suspect = member('u1', 2, {
            createdTimestamp: NOW - 2 * 3_600_000,
            username: 'free-nitro-giveaway',
        });
        await restore.restoreGuild(guildWith([suspect]), settings(), { now: NOW });

        const result = watch.inspectMessage('g1', {
            content: 'hello https://youtu.be/x',
            channelId: 'c1',
            author: { id: 'u1' },
            mentions: { everyone: false, users: { size: 0 }, roles: { size: 0 } },
        }, { windowMs: 10 * MINUTE, threshold: 100, now: NOW });

        expect(result.signals.map(s => s.id)).toContain('prior_suspicion');
    });

    // Ordering, pinned. The carry-over is scored with the correlation, so the
    // join list has to be seeded before anyone is scored against it. Seed it
    // afterwards and every member of a cluster is scored as though they had
    // arrived alone: these two score 6 apiece in isolation, and 56 together
    // once the shared avatar and the near-identical name can be seen.
    test('a member is scored against the others restored alongside them', async () => {
        const clustered = n => member(`u${n}`, n + 1, {
            username: `raidbot00${n}`,
            avatar: 'sharedhash',
            createdTimestamp: NOW - 200 * 24 * 3_600_000,
        });
        await restore.restoreGuild(guildWith([clustered(1), clustered(2)]), settings(), { now: NOW });

        const result = watch.inspectMessage('g1', {
            content: 'hey https://youtu.be/x',
            channelId: 'c1',
            author: { id: 'u1' },
            mentions: { everyone: false, users: { size: 0 }, roles: { size: 0 } },
        }, { windowMs: 10 * MINUTE, threshold: 100, now: NOW });

        const carried = result.signals.find(s => s.id === 'prior_suspicion');
        expect(carried).toBeDefined();
        expect(carried.detail).toBe('profile scored 56 (watch) when they joined');
    });
});

describe('the join correlation comes back whole', () => {
    test('four arrivals in the window are still four arrivals', async () => {
        const guild = guildWith([member('u1', 2), member('u2', 3), member('u3', 4), member('u4', 30)]);
        const result = await restore.restoreGuild(guild, settings(), { now: NOW });

        // The 30-minute-old join is outside the ten-minute correlation window.
        expect(result.joins).toBe(3);
        expect(suspicion.correlateJoin('g1', { id: 'u9', username: 'x', avatar: null, createdTimestamp: NOW }, NOW))
            .toMatchObject({ windowSize: 4 });
    });

    // The two windows are different lengths and must stay that way. A guild
    // that watches behaviour for half an hour has not asked for half an hour
    // of raid correlation, and widening it silently would make every ordinary
    // afternoon look like a cluster.
    test('a long watch window does not stretch the correlation window', async () => {
        const guild = guildWith([member('u1', 2), member('u2', 20)]);
        const result = await restore.restoreGuild(guild, settings({ watch_window_minutes: 30 }), { now: NOW });

        expect(result.watched).toBe(2);
        expect(result.joins).toBe(1);
    });

    test('a shared avatar across the restart is still a cluster', async () => {
        const shared = 'abc123';
        const guild = guildWith([
            member('u1', 2, { avatar: shared }),
            member('u2', 3, { avatar: shared }),
        ]);
        await restore.restoreGuild(guild, settings(), { now: NOW });

        const correlation = suspicion.correlateJoin(
            'g1', { id: 'u3', username: 'zzz', avatar: shared, createdTimestamp: NOW }, NOW,
        );
        expect(correlation.sharedAvatarCount).toBe(2);
    });
});

describe('the guard counters come back', () => {
    const deletion = (secondsAgo, actorId = 'mod1') => ({
        action: AuditLogEvent.ChannelDelete,
        executorId: actorId,
        createdTimestamp: NOW - secondsAgo * 1000,
        changes: [],
    });

    test('deletions inside the window are counted again', async () => {
        const guild = guildWith([], { auditEntries: [deletion(5), deletion(10), deletion(15)] });
        const result = await restore.restoreGuild(guild, settings({ guard_enabled: true }), { now: NOW });
        expect(result.guard).toBe(3);
    });

    // The point of restoring them: an actor three deletions into a limit of
    // four used to start again from zero and get three more for free.
    test('so the fourth deletion still trips the limit', async () => {
        const s = settings({ guard_enabled: true, guard_delete_limit: 4, guard_window_seconds: 60 });
        const guild = guildWith([], { auditEntries: [deletion(5), deletion(10), deletion(15)] });
        await restore.restoreGuild(guild, s, { now: NOW });

        const alert = guard.record('g1', deletion(0), s, NOW);
        expect(alert).not.toBeNull();
        expect(alert.count).toBe(4);
    });

    test('entries older than the window are ignored', async () => {
        const guild = guildWith([], { auditEntries: [deletion(300), deletion(600)] });
        const result = await restore.restoreGuild(guild, settings({ guard_enabled: true }), { now: NOW });
        expect(result.guard).toBe(0);
    });

    // Seeding must never announce. Replaying the log through the alert path
    // would re-report whatever was already reported before the restart, and an
    // alarm that cries wolf on every deploy is worse than the gap it closes.
    test('seeding is silent even when it seeds past the limit', async () => {
        const s = settings({ guard_enabled: true, guard_delete_limit: 2 });
        const guild = guildWith([], { auditEntries: [deletion(5), deletion(10), deletion(15)] });
        const result = await restore.restoreGuild(guild, s, { now: NOW });

        expect(result.guard).toBe(3);
        expect(result.alert).toBeUndefined();
    });

    // The reason seeding cannot simply replay the log through record(): that
    // would set alertedAt during boot, and record() allows one alert per actor
    // per window. The first genuine nuke after a restart would be swallowed by
    // an alert that was never sent to anybody.
    test('seeding does not spend the one alert the window allows', async () => {
        const s = settings({ guard_enabled: true, guard_delete_limit: 2, guard_window_seconds: 60 });
        const guild = guildWith([], { auditEntries: [deletion(30), deletion(40), deletion(50)] });
        await restore.restoreGuild(guild, s, { now: NOW });

        const alert = guard.record('g1', deletion(0), s, NOW);
        expect(alert).not.toBeNull();
        expect(alert.bucket).toBe('destructive');
    });

    test('an exempt actor is not counted', async () => {
        const s = settings({ guard_enabled: true, guard_exempt_user_ids: ['mod1'] });
        const guild = guildWith([], { auditEntries: [deletion(5), deletion(10)] });
        expect((await restore.restoreGuild(guild, s, { now: NOW })).guard).toBe(0);
    });

    test('a guild that will not show its audit log is not a failure', async () => {
        const guild = guildWith([member('u1', 2)]);  // fetchAuditLogs throws
        const result = await restore.restoreGuild(guild, settings({ guard_enabled: true }), { now: NOW });

        expect(result.guard).toBe(0);
        expect(result.watched).toBe(1);  // the rest of the restore still ran
    });
});

describe('a boot that goes wrong', () => {
    test('an unreadable member list does not stop the guard restore', async () => {
        const guild = {
            id: 'g1',
            members: { fetch: jest.fn(async () => { throw new Error('gateway timeout'); }) },
            fetchAuditLogs: jest.fn(async () => ({ entries: new Map() })),
        };
        const result = await restore.restoreGuild(guild, settings({ guard_enabled: true }), { now: NOW });
        expect(result).toMatchObject({ watched: 0, joins: 0, guard: 0 });
    });

    test('a disabled gate is skipped entirely', async () => {
        const guild = guildWith([member('u1', 1)]);
        const result = await restore.restoreGuild(guild, settings({ enabled: false }), { now: NOW });

        expect(result.skipped).toBe('gate disabled');
        expect(guild.members.fetch).not.toHaveBeenCalled();
    });

    test('one broken guild does not stop the next', async () => {
        const client = {
            guilds: {
                cache: new Map([
                    ['g1', { id: 'g1', members: { fetch: async () => { throw new Error('nope'); } } }],
                    ['g2', guildWith([member('u1', 2)])],
                ]),
                fetch: jest.fn(),
            },
        };
        const totals = await restore.restoreAll(client, [['g1', settings()], ['g2', settings()]]);
        expect(totals.guilds).toBe(2);
    });
});
