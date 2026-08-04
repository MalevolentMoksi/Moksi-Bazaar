// tests/guard.test.js
//
// The audit-log guard. Two things need pinning harder than the detection logic.
//
// One: bans, kicks and timeouts are NOT watched. That is the decision that
// keeps this out of the way. Wick has to own every ban because it cannot
// otherwise tell a legitimate one from a nuke, which is why using it means
// routing all moderation through it. Here, a mass-ban through Dyno must trip
// nothing at all, and a test should fail loudly if anyone ever "improves" that.
//
// Two: it never acts. The audit log is written after the fact, so this could
// not intercept anything even if it tried, but there must be no moderation call
// in the module for anyone to find and wire up later.

const { AuditLogEvent, PermissionFlagsBits } = require('discord.js');
const guard = require('../src/utils/joinGate/guard');

const GUILD = 'guild-guard';
const ACTOR = 'actor-1';
const T0 = 1_700_000_000_000;

const settings = {
    guard_enabled: true,
    guard_window_seconds: 60,
    guard_delete_limit: 4,
    guard_create_limit: 6,
    guard_perm_limit: 2,
    guard_webhook_limit: 3,
    guard_watch_identity: true,
    guard_watch_bots: true,
    guard_exempt_user_ids: [],
};

const entry = (action, extra = {}) => ({ action, executorId: ACTOR, ...extra });
const at = (action, n, extra = {}) => guard.record(GUILD, entry(action, extra), settings, T0 + n * 1000);

beforeEach(() => guard.clear());

describe('moderation is not watched, and must never be', () => {
    const moderation = [
        ['MemberBanAdd', AuditLogEvent.MemberBanAdd],
        ['MemberBanRemove', AuditLogEvent.MemberBanRemove],
        ['MemberKick', AuditLogEvent.MemberKick],
        ['MemberUpdate (timeouts)', AuditLogEvent.MemberUpdate],
        ['MessageDelete', AuditLogEvent.MessageDelete],
        ['MessageBulkDelete', AuditLogEvent.MessageBulkDelete],
    ];

    for (const [label, action] of moderation) {
        test(`${label} is not in the watch list`, () => {
            expect(guard.WATCHED[action]).toBeUndefined();
        });
    }

    test('banning fifty people in a minute trips nothing', () => {
        // The exact thing the owner does through Dyno when cleaning out a batch.
        for (let n = 0; n < 50; n++) {
            expect(guard.record(GUILD, entry(AuditLogEvent.MemberBanAdd), settings, T0 + n * 1000)).toBeNull();
        }
    });
});

describe('structure deletion', () => {
    test('under the limit is silent', () => {
        expect(at(AuditLogEvent.ChannelDelete, 0)).toBeNull();
        expect(at(AuditLogEvent.ChannelDelete, 1)).toBeNull();
        expect(at(AuditLogEvent.ChannelDelete, 2)).toBeNull();
    });

    test('crossing the limit reports once', () => {
        at(AuditLogEvent.ChannelDelete, 0);
        at(AuditLogEvent.ChannelDelete, 1);
        at(AuditLogEvent.ChannelDelete, 2);
        const verdict = at(AuditLogEvent.ChannelDelete, 3);
        expect(verdict).not.toBeNull();
        expect(verdict.count).toBe(4);
        expect(verdict.actorId).toBe(ACTOR);
    });

    test('channels and roles count toward the same limit', () => {
        // "Deleted two channels and two roles" is one attack, not two events
        // that each politely stayed under their own threshold.
        at(AuditLogEvent.ChannelDelete, 0);
        at(AuditLogEvent.ChannelDelete, 1);
        at(AuditLogEvent.RoleDelete, 2);
        expect(at(AuditLogEvent.RoleDelete, 3)).not.toBeNull();
    });

    test('a nuke produces one alert, not three hundred', () => {
        let alerts = 0;
        for (let n = 0; n < 300; n++) if (at(AuditLogEvent.ChannelDelete, n * 0.05)) alerts++;
        expect(alerts).toBe(1);
    });

    test('actions spread outside the window never accumulate', () => {
        // A real admin tidying up over an afternoon.
        for (let n = 0; n < 10; n++) {
            expect(at(AuditLogEvent.ChannelDelete, n * 120)).toBeNull();
        }
    });

    test('two different people are counted separately', () => {
        for (let n = 0; n < 3; n++) at(AuditLogEvent.ChannelDelete, n);
        const other = guard.record(GUILD, { action: AuditLogEvent.ChannelDelete, executorId: 'actor-2' }, settings, T0 + 3000);
        expect(other).toBeNull();
    });
});

describe('permission escalation', () => {
    const grant = perm => ({ changes: [{ key: 'permissions', old: '0', new: String(perm) }] });

    test('granting Administrator counts', () => {
        at(AuditLogEvent.RoleUpdate, 0, grant(PermissionFlagsBits.Administrator));
        expect(at(AuditLogEvent.RoleUpdate, 1, grant(PermissionFlagsBits.Administrator))).not.toBeNull();
    });

    test('removing a dangerous permission never counts', () => {
        const remove = { changes: [{ key: 'permissions', old: String(PermissionFlagsBits.Administrator), new: '0' }] };
        for (let n = 0; n < 10; n++) expect(at(AuditLogEvent.RoleUpdate, n, remove)).toBeNull();
    });

    test('a harmless role edit never counts', () => {
        const rename = { changes: [{ key: 'name', old: 'Members', new: 'Regulars' }] };
        for (let n = 0; n < 10; n++) expect(at(AuditLogEvent.RoleUpdate, n, rename)).toBeNull();
    });

    test('granting a mild permission never counts', () => {
        const mild = { changes: [{ key: 'permissions', old: '0', new: String(PermissionFlagsBits.AddReactions) }] };
        for (let n = 0; n < 10; n++) expect(at(AuditLogEvent.RoleUpdate, n, mild)).toBeNull();
    });
});

describe('single-event reports', () => {
    test('a vanity URL change reports immediately', () => {
        const verdict = at(AuditLogEvent.GuildUpdate, 0, {
            changes: [{ key: 'vanity_url_code', old: 'moksi', new: 'stolen' }],
        });
        expect(verdict).not.toBeNull();
        expect(verdict.identity).toEqual(['vanity URL']);
    });

    test('an uninteresting server change does not', () => {
        expect(at(AuditLogEvent.GuildUpdate, 0, {
            changes: [{ key: 'afk_timeout', old: 300, new: 600 }],
        })).toBeNull();
    });

    test('a bot being added reports, and names who added it', () => {
        const verdict = at(AuditLogEvent.BotAdd, 0, { targetId: 'bot-99' });
        expect(verdict).not.toBeNull();
        expect(verdict.actorId).toBe(ACTOR);
        expect(verdict.targetId).toBe('bot-99');
    });

    test('identity and bot watching can be switched off', () => {
        const off = { ...settings, guard_watch_identity: false, guard_watch_bots: false };
        expect(guard.record(GUILD, entry(AuditLogEvent.BotAdd), off, T0)).toBeNull();
        expect(guard.record(GUILD, entry(AuditLogEvent.GuildUpdate, {
            changes: [{ key: 'vanity_url_code', old: 'a', new: 'b' }],
        }), off, T0)).toBeNull();
    });
});

describe('exemptions and hygiene', () => {
    test('an exempt actor is ignored entirely', () => {
        const exempt = { ...settings, guard_exempt_user_ids: [ACTOR] };
        for (let n = 0; n < 20; n++) {
            expect(guard.record(GUILD, entry(AuditLogEvent.ChannelDelete), exempt, T0 + n * 1000)).toBeNull();
        }
    });

    test('an entry with no executor is ignored', () => {
        expect(guard.record(GUILD, { action: AuditLogEvent.ChannelDelete }, settings, T0)).toBeNull();
    });

    test('idle counters are pruned', () => {
        at(AuditLogEvent.ChannelDelete, 0);
        expect(guard.prune(60_000, T0 + 10 * 60_000)).toBe(1);
    });
});

describe('the module cannot act', () => {
    test('it contains no moderation call at all', () => {
        // Belt and braces against a future edit. If someone adds enforcement
        // here, this fails and they have to think about it first.
        const source = require('fs').readFileSync(
            require('path').join(__dirname, '..', 'src', 'utils', 'joinGate', 'guard.js'), 'utf8');
        // Discord mutations specifically. A bare ".delete(" would match Map
        // deletes on the counters, which are the module doing its actual job.
        const forbidden = [
            '.ban(', '.kick(', '.timeout(', '.setPermissions(', 'bulkDelete(',
            'roles.add(', 'roles.remove(', '.disableCommunicationUntil',
            'channels.delete(', 'members.edit(',
        ];
        for (const call of forbidden) {
            expect(source).not.toContain(call);
        }
    });
});
