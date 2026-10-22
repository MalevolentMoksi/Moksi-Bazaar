// tests/logRouting.test.js
//
// Age kicks arrive several a day and used to share "Kicks & bans" with the
// temp-bans and the lift notices, so the rare entry worth reading sat under a
// stack of routine ones. They were split into three categories. These pin
// where each entry lands, and that an unset category follows the temp-ban
// channel before the default one, so the split moved nothing on deploy.

jest.mock('../src/utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../src/utils/db', () => ({
    pool: { query: jest.fn(async () => ({ rows: [] })) },
    recordSuspicionReport: jest.fn(async () => 1),
}));

const { DEFAULTS } = require('../src/utils/joinGate/config');
const {
    outcomeEmbed, routeOf, logOutcome, logUnban, logSupersededUnban,
} = require('../src/utils/joinGate/logging');

const user = {
    id: 'u1', tag: 'new#0001', username: 'new', createdTimestamp: Date.now() - 86_400_000,
    displayAvatarURL: () => null,
};
const decision = { ageMs: 86_400_000, eligibleAt: Date.now() + 11 * 86_400_000 };
const base = { user, decision, origin: 'join', attempt: 1, dryRun: false };

/** A guild whose channels each record what was sent to them. */
function fakeGuild(ids) {
    const sent = {};
    const cache = new Map(ids.map(id => [id, {
        isTextBased: () => true,
        guild: { id: 'g1' },
        permissionsFor: () => ({ has: () => true }),
        send: jest.fn(async (payload) => { (sent[id] ??= []).push(payload); }),
    }]));
    return { guild: { id: 'g1', channels: { cache, fetch: jest.fn(async () => null) }, members: { me: {} } }, sent };
}

describe('which category an outcome belongs to', () => {
    const categoryOf = result => outcomeEmbed(DEFAULTS, { ...base, result }).category;

    test('a plain age kick, first or repeat, is an age kick', () => {
        expect(categoryOf({ ok: true, action: 'kick', dm: 'sent' })).toBe('ageKick');
        expect(outcomeEmbed(DEFAULTS, { ...base, attempt: 2, result: { ok: true, action: 'kick' } }).category).toBe('ageKick');
    });

    test('"they already left" goes with the routine kicks', () => {
        expect(categoryOf({ ok: false, benign: true, action: 'kick', error: 'gone' })).toBe('ageKick');
        expect(categoryOf({ ok: false, benign: true, action: 'ban', error: 'gone' })).toBe('ageKick');
    });

    test('a temp-ban keeps its own channel', () => {
        expect(categoryOf({ ok: true, action: 'ban', unbanAt: decision.eligibleAt })).toBe('kick');
    });

    test('failures and dry runs are untouched', () => {
        expect(categoryOf({ ok: false, action: 'kick', error: 'Missing Permissions' })).toBe('failure');
        expect(outcomeEmbed(DEFAULTS, { ...base, dryRun: true, result: { ok: true, action: 'kick' } }).category).toBe('preview');
    });
});

describe('an unset split category follows the temp-bans', () => {
    test('own override wins', () => {
        const s = { ...DEFAULTS, log_age_kick_channel_id: 'a', log_kick_channel_id: 'k', log_channel_id: 'd' };
        expect(routeOf(s, 'ageKick')).toEqual({ overrideId: 'a', effectiveId: 'a', inheritedFrom: null });
    });

    test('unset, it borrows the temp-ban override and says so', () => {
        const s = { ...DEFAULTS, log_kick_channel_id: 'k', log_channel_id: 'd' };
        expect(routeOf(s, 'ageKick')).toEqual({ overrideId: null, effectiveId: 'k', inheritedFrom: 'Temp-bans' });
        expect(routeOf(s, 'lift')).toEqual({ overrideId: null, effectiveId: 'k', inheritedFrom: 'Temp-bans' });
    });

    test('with no temp-ban override either, it is the default channel', () => {
        const s = { ...DEFAULTS, log_channel_id: 'd' };
        expect(routeOf(s, 'lift')).toEqual({ overrideId: null, effectiveId: 'd', inheritedFrom: null });
    });

    test('categories without a parent never borrow one', () => {
        const s = { ...DEFAULTS, log_kick_channel_id: 'k', log_channel_id: 'd' };
        expect(routeOf(s, 'failure').effectiveId).toBe('d');
    });
});

describe('entries reach the channel they were routed to', () => {
    const settings = {
        ...DEFAULTS,
        log_channel_id: 'default',
        log_age_kick_channel_id: 'kicks',
        log_kick_channel_id: 'bans',
        log_lift_channel_id: 'lifts',
        log_failure_channel_id: 'staff',
    };

    test('kick, ban, lift, cancelled lift and failed lift each land apart', async () => {
        const { guild, sent } = fakeGuild(['default', 'kicks', 'bans', 'lifts', 'staff']);
        await logOutcome(guild, settings, { ...base, result: { ok: true, action: 'kick', dm: 'sent' } });
        await logOutcome(guild, settings, { ...base, attempt: 3, result: { ok: true, action: 'ban', unbanAt: decision.eligibleAt } });
        await logUnban(guild, settings, { userId: 'u1', bannedAtMs: Date.now(), ok: true });
        await logSupersededUnban(guild, settings, { userId: 'u1', cause: 'ban' });
        await logUnban(guild, settings, { userId: 'u1', bannedAtMs: Date.now(), ok: false, error: 'Unknown Ban' });

        expect(Object.fromEntries(Object.entries(sent).map(([k, v]) => [k, v.length])))
            .toEqual({ kicks: 1, bans: 1, lifts: 2, staff: 1 });
    });

    test('switching age kicks off silences only them', async () => {
        const { guild, sent } = fakeGuild(['default', 'kicks', 'bans', 'lifts', 'staff']);
        const off = { ...settings, log_age_kicks: false };
        await logOutcome(guild, off, { ...base, result: { ok: true, action: 'kick' } });
        await logOutcome(guild, off, { ...base, result: { ok: true, action: 'ban', unbanAt: decision.eligibleAt } });
        expect(sent.kicks).toBeUndefined();
        expect(sent.bans).toHaveLength(1);
    });
});
