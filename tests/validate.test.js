// tests/validate.test.js
//
// These rules used to live inline inside the panel's interaction handlers,
// tangled up with modals and ephemeral replies. That was fine while the panel
// was the only writer. The moment a second one exists, two copies of "a timeout
// may not exceed 28 days" is how one of them ends up wrong, and the wrong one
// is the one nobody tested.
//
// So they are pinned here, once, against the behaviour the panel already had.

const v = require('../src/utils/joinGate/validate');
const { LIMITS, TIER_ACTIONS, DAY_MINUTES } = require('../src/utils/joinGate/config');
const { DEFAULT_WEIGHTS } = require('../src/utils/joinGate/suspicion');

describe('numeric fields', () => {
    test('account age is given in days and stored in minutes', () => {
        expect(v.numericField('min_account_age_minutes', '14').patch)
            .toEqual({ min_account_age_minutes: 14 * DAY_MINUTES });
    });

    test('a decimal day is accepted', () => {
        expect(v.numericField('min_account_age_minutes', '0.5').patch)
            .toEqual({ min_account_age_minutes: 720 });
    });

    test('a comma is treated as a decimal point', () => {
        // Half of Europe types 0,5 and means 0.5, and the panel already
        // accepted it. Losing that in the move would be a silent regression.
        expect(v.numericField('min_account_age_minutes', '0,5').patch)
            .toEqual({ min_account_age_minutes: 720 });
    });

    test('junk is rejected rather than clamped to the minimum', () => {
        // Storing the minimum would report success and change the wrong thing.
        const result = v.numericField('watch_window_minutes', 'abc');
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/not a number/);
    });

    test('blank is rejected', () => {
        expect(v.numericField('watch_window_minutes', '   ').ok).toBe(false);
    });

    test('negative is rejected', () => {
        expect(v.numericField('watch_window_minutes', '-5').ok).toBe(false);
    });

    test('out of range is clamped, because it reads as "give me the most"', () => {
        expect(v.numericField('watch_timeout_minutes', '999999').patch.watch_timeout_minutes)
            .toBe(LIMITS.TIMEOUT_MINUTES.max);
    });

    test('a timeout can never exceed what Discord allows', () => {
        // Discord's own ceiling is 28 days; past it the call simply fails.
        expect(LIMITS.TIMEOUT_MINUTES.max).toBe(28 * DAY_MINUTES);
        expect(v.numericField('watch_timeout_minutes', String(60 * 24 * 365)).patch.watch_timeout_minutes)
            .toBeLessThanOrEqual(28 * DAY_MINUTES);
    });

    test('an unknown key is refused rather than written', () => {
        expect(v.numericField('drop_table', '1').ok).toBe(false);
    });

    test('every field in the table round-trips its own minimum', () => {
        for (const [key, field] of Object.entries(v.NUMERIC_FIELDS)) {
            const result = v.numericField(key, String(field.bounds.min));
            expect(result.ok).toBe(true);
            expect(result.patch[key]).toBe(field.bounds.min);
        }
    });
});

describe('suspicion thresholds must rise', () => {
    test('an ordered set is accepted', () => {
        expect(v.thresholds({ watch: 40, suspect: 70, malicious: 100 }).patch).toEqual({
            suspicion_watch_at: 40, suspicion_suspect_at: 70, suspicion_malicious_at: 100,
        });
    });

    test('equal thresholds are allowed', () => {
        expect(v.thresholds({ watch: 50, suspect: 50, malicious: 50 }).ok).toBe(true);
    });

    test('out of order is refused', () => {
        expect(v.thresholds({ watch: 100, suspect: 50, malicious: 200 }).ok).toBe(false);
    });

    test('junk in any position is refused', () => {
        expect(v.thresholds({ watch: 40, suspect: 'x', malicious: 100 }).ok).toBe(false);
    });
});

describe('actions declare the permissions they need', () => {
    test('ban needs Ban Members', () => {
        expect(v.tierActions({ watch: 'log', suspect: 'log', malicious: 'ban' }).requires)
            .toEqual(['BanMembers']);
    });

    test('timeout needs Moderate Members', () => {
        expect(v.watchWindow({ minutes: 10, at: 100, action: 'timeout', timeout: 60 }).requires)
            .toEqual(['ModerateMembers']);
    });

    test('log needs nothing', () => {
        expect(v.tierActions({ watch: 'log', suspect: 'log', malicious: 'log' }).requires).toEqual([]);
    });

    test('a permission is named once even when several tiers need it', () => {
        expect(v.tierActions({ watch: 'ban', suspect: 'ban', malicious: 'ban' }).requires)
            .toEqual(['BanMembers']);
    });

    test('an unknown action is refused', () => {
        const result = v.tierActions({ watch: 'log', suspect: 'obliterate', malicious: 'ban' });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/obliterate/);
    });

    test('every documented action validates', () => {
        for (const action of TIER_ACTIONS) {
            expect(v.tierActions({ watch: action, suspect: action, malicious: action }).ok).toBe(true);
        }
    });

    test('a whole patch reports everything it would need', () => {
        expect(v.permissionsForPatch({ watch_action: 'ban', guard_enabled: true }).sort())
            .toEqual(['BanMembers', 'ViewAuditLog']);
        expect(v.permissionsForPatch({ escalate_enabled: true })).toEqual(['BanMembers']);
        expect(v.permissionsForPatch({ dry_run: true })).toEqual([]);
    });
});

describe('the watch window', () => {
    test('a blank timeout leaves the stored value alone', () => {
        // The field is optional, and an empty box means "leave it", not "zero".
        const result = v.watchWindow({ minutes: 10, at: 100, action: 'kick', timeout: '' });
        expect(result.ok).toBe(true);
        expect(result.patch).not.toHaveProperty('watch_timeout_minutes');
    });

    test('a supplied timeout is written', () => {
        expect(v.watchWindow({ minutes: 10, at: 100, action: 'timeout', timeout: '30' })
            .patch.watch_timeout_minutes).toBe(30);
    });

    test('a bad action refuses the whole change', () => {
        expect(v.watchWindow({ minutes: 10, at: 100, action: 'nope', timeout: '' }).ok).toBe(false);
    });
});

describe('weight overrides', () => {
    test('valid lines parse', () => {
        const result = v.weights('default_avatar = 20\ndigit_suffix=15');
        expect(result.patch.suspicion_weights).toEqual({ default_avatar: 20, digit_suffix: 15 });
    });

    test('an unknown signal is an error, not a silent skip', () => {
        // A typo that saves cleanly and changes nothing is worse than one that
        // complains: the owner walks away believing the tuning took.
        expect(v.weights('defalut_avatar = 20').ok).toBe(false);
    });

    test('a non-numeric value is an error', () => {
        expect(v.weights('default_avatar = lots').ok).toBe(false);
    });

    test('weights are bounded', () => {
        expect(v.weights('default_avatar = 9999').patch.suspicion_weights.default_avatar).toBe(100);
        expect(v.weights('default_avatar = -9999').patch.suspicion_weights.default_avatar).toBe(-100);
    });

    test('empty clears the overrides', () => {
        expect(v.weights('').patch.suspicion_weights).toEqual({});
    });

    test('every real signal name is accepted', () => {
        for (const key of Object.keys(DEFAULT_WEIGHTS)) {
            expect(v.weights(`${key} = 5`).ok).toBe(true);
        }
    });
});

describe('user ID lists', () => {
    test('mentions and raw ids both work', () => {
        expect(v.userIds('123456789012345678, <@987654321098765432>').ids)
            .toEqual(['123456789012345678', '987654321098765432']);
    });

    test('duplicates collapse', () => {
        expect(v.userIds('123456789012345678 123456789012345678').ids).toHaveLength(1);
    });

    test('a non-id is refused rather than dropped', () => {
        // Silently dropping it would mean silently not exempting somebody the
        // owner believes is exempt.
        expect(v.userIds('123456789012345678 bob').ok).toBe(false);
    });

    test('the list has a ceiling', () => {
        // Built as strings, not arithmetic: a snowflake is past
        // Number.MAX_SAFE_INTEGER, so adding to one silently yields the same
        // number every time and the whole list dedupes to a single entry.
        const many = Array.from({ length: LIMITS.EXEMPT_IDS + 1 }, (_, n) => `1${String(n).padStart(17, '0')}`);
        expect(v.userIds(many.join(' ')).ok).toBe(false);
    });

    test('empty is an empty list, not an error', () => {
        expect(v.userIds('').ids).toEqual([]);
    });
});

describe('the rejoin invite', () => {
    test('a Discord invite is accepted', () => {
        expect(v.inviteUrl('https://discord.gg/abc123').patch.dm_invite_url).toBe('https://discord.gg/abc123');
    });

    test('the /invite form is accepted', () => {
        expect(v.inviteUrl('https://discord.com/invite/abc123').ok).toBe(true);
    });

    test('anything else is refused, because this string is DMed to strangers', () => {
        for (const url of ['https://evil.example/x', 'http://discord.gg/abc', 'discord.gg/abc', 'javascript:alert(1)']) {
            expect(v.inviteUrl(url).ok).toBe(false);
        }
    });

    test('blank clears it', () => {
        expect(v.inviteUrl('').patch.dm_invite_url).toBeNull();
    });
});
