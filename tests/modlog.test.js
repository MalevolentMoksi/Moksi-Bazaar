// tests/modlog.test.js
//
// Discord keeps its audit log for 45 days and then discards it, and the other
// copy of this server's moderation history lives on Dyno's servers. Neither
// answers "has this person been in trouble before" a year later, which is
// exactly when that gets asked.
//
// The mapping is the part worth pinning. Timeouts are the awkward case: Discord
// files them as a generic MemberUpdate, and the only thing separating a timeout
// from a nickname change is one key in the changes array.

const { AuditLogEvent } = require('discord.js');
const { describe: classify } = require('../src/utils/joinGate/modlog');

describe('what counts as moderation', () => {
    test.each([
        ['a ban', AuditLogEvent.MemberBanAdd, 'ban'],
        ['an unban', AuditLogEvent.MemberBanRemove, 'unban'],
        ['a kick', AuditLogEvent.MemberKick, 'kick'],
    ])('%s is recorded', (_label, action, expected) => {
        expect(classify({ action }).action).toBe(expected);
    });

    test('a timeout is found inside a generic member update', () => {
        const entry = {
            action: AuditLogEvent.MemberUpdate,
            changes: [{ key: 'communication_disabled_until', old: null, new: '2026-08-05T12:00:00Z' }],
        };
        expect(classify(entry).action).toBe('timeout');
    });

    test('a lifted timeout is its own event, not a second timeout', () => {
        const entry = {
            action: AuditLogEvent.MemberUpdate,
            changes: [{ key: 'communication_disabled_until', old: '2026-08-05T12:00:00Z', new: null }],
        };
        expect(classify(entry).action).toBe('timeout_cleared');
    });

    test('a nickname change is not moderation', () => {
        expect(classify({
            action: AuditLogEvent.MemberUpdate,
            changes: [{ key: 'nick', old: 'Bob', new: 'Robert' }],
        })).toBeNull();
    });

    test('a member update with no changes at all is not moderation', () => {
        expect(classify({ action: AuditLogEvent.MemberUpdate })).toBeNull();
    });
});

describe('what is deliberately not recorded here', () => {
    // This table is moderation history. Structure events belong to the guard,
    // which reports them; duplicating them here would make a member's history
    // unreadable and imply the guard acts on them, which it does not.
    const notModeration = [
        ['channel deletion', AuditLogEvent.ChannelDelete],
        ['role deletion', AuditLogEvent.RoleDelete],
        ['a bot being added', AuditLogEvent.BotAdd],
        ['server settings', AuditLogEvent.GuildUpdate],
        ['message deletion', AuditLogEvent.MessageDelete],
        ['a role update', AuditLogEvent.RoleUpdate],
    ];

    for (const [label, action] of notModeration) {
        test(`${label} is ignored`, () => {
            expect(classify({ action })).toBeNull();
        });
    }
});

describe('the module records and nothing more', () => {
    test('it makes no moderation call and raises no alert', () => {
        const source = require('fs').readFileSync(
            require('path').join(__dirname, '..', 'src', 'utils', 'joinGate', 'modlog.js'), 'utf8');
        for (const call of ['.ban(', '.kick(', '.timeout(', '.send(', 'logSuspicion', 'EmbedBuilder']) {
            expect(source).not.toContain(call);
        }
    });
});
