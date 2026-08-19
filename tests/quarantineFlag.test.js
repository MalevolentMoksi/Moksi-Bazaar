// tests/quarantineFlag.test.js
//
// An 85-point signal that could never fire.
//
// `discord_quarantined` is one of only two signals that force the malicious
// tier outright, no matter what the arithmetic says. It read the account's
// flags through discord.js's `UserFlagsBitField#has`, which masks with `&`.
// That is a 32-bit operator, and Quarantined is bit 44, so the answer was
// always false:
//
//     new UserFlagsBitField(UserFlags.Quarantined).has(UserFlags.Quarantined)
//     // false
//
// Two independent faults, in fact. The second is that Discord publishes
// quarantine on the GUILD MEMBER, not the user, so even a working bit test
// against the user object was asking somewhere the answer is not kept.
//
// Spammer is bit 20 and was never affected; it is pinned here so a fix for
// the wide flags cannot quietly break the narrow one.

const { UserFlags, UserFlagsBitField, GuildMemberFlags, GuildMemberFlagsBitField } = require('discord.js');
const suspicion = require('../src/utils/joinGate/suspicion');

describe('the bug itself, pinned against discord.js', () => {
    test('has() still cannot see a flag above bit 31', () => {
        const bf = new UserFlagsBitField(UserFlags.Quarantined);
        // If this ever starts passing, discord.js has fixed its bit width and
        // the workaround below is merely redundant rather than load-bearing.
        expect(bf.has(UserFlags.Quarantined)).toBe(false);
        expect(bf.toArray()).toEqual([]);
    });

    test('Quarantined really is a wide flag, and Spammer really is not', () => {
        expect(UserFlags.Quarantined).toBe(2 ** 44);
        expect(UserFlags.Spammer).toBe(2 ** 20);
    });
});

describe('hasFlag reads wide flags correctly', () => {
    const withFlags = bitfield => ({ id: '1', username: 'x', flags: new UserFlagsBitField(bitfield) });

    test('Quarantined is seen when Discord sets it', () => {
        expect(suspicion.hasFlag(withFlags(UserFlags.Quarantined), 'Quarantined')).toBe(true);
    });

    test('and is not seen when it is absent', () => {
        expect(suspicion.hasFlag(withFlags(UserFlags.Spammer), 'Quarantined')).toBe(false);
    });

    test('Spammer, the narrow flag, still works', () => {
        expect(suspicion.hasFlag(withFlags(UserFlags.Spammer), 'Spammer')).toBe(true);
        expect(suspicion.hasFlag(withFlags(UserFlags.Quarantined), 'Spammer')).toBe(false);
    });

    test('both at once', () => {
        const both = withFlags(UserFlags.Spammer | 0);
        both.flags = new UserFlagsBitField(UserFlags.Quarantined + UserFlags.Spammer);
        expect(suspicion.hasFlag(both, 'Quarantined')).toBe(true);
        expect(suspicion.hasFlag(both, 'Spammer')).toBe(true);
    });

    test('an account with no flags at all is not evidence of anything', () => {
        expect(suspicion.hasFlag({ id: '1' }, 'Quarantined')).toBe(false);
        expect(suspicion.hasFlag({ id: '1', flags: null }, 'Spammer')).toBe(false);
    });
});

describe('quarantine is read from the member, where Discord actually puts it', () => {
    const member = flag => ({ flags: new GuildMemberFlagsBitField(flag) });

    test.each([
        ['username or nickname', 'AutomodQuarantinedUsernameOrGuildNickname'],
        ['bio', 'AutomodQuarantinedBio'],
        ['guild tag', 'AutoModQuarantinedGuildTag'],
    ])('a member quarantined over their %s counts', (_label, flagName) => {
        expect(suspicion.isQuarantined({ id: '1' }, member(GuildMemberFlags[flagName]))).toBe(true);
    });

    test('an ordinary member does not', () => {
        expect(suspicion.isQuarantined({ id: '1' }, member(GuildMemberFlags.DidRejoin))).toBe(false);
        expect(suspicion.isQuarantined({ id: '1' }, null)).toBe(false);
    });

    test('the user-level flag still counts on its own', () => {
        const user = { id: '1', flags: new UserFlagsBitField(UserFlags.Quarantined) };
        expect(suspicion.isQuarantined(user, null)).toBe(true);
    });
});

describe('and the signal now reaches the score', () => {
    const base = { id: '619637817294848012', username: 'someone', globalName: 'Someone', avatar: 'abc' };

    test('a quarantined member is forced to malicious, as documented', () => {
        const result = suspicion.scoreAccount(base, {
            member: { flags: new GuildMemberFlagsBitField(GuildMemberFlags.AutomodQuarantinedBio) },
        });
        expect(result.signals.map(s => s.id)).toContain('discord_quarantined');
        expect(result.forcedByDiscord).toBe(true);
        expect(result.tier).toBe('malicious');
    });

    test('an ordinary member is untouched by any of this', () => {
        const result = suspicion.scoreAccount(base, { member: { flags: new GuildMemberFlagsBitField(0) } });
        expect(result.signals.map(s => s.id)).not.toContain('discord_quarantined');
        expect(result.forcedByDiscord).toBe(false);
    });
});
