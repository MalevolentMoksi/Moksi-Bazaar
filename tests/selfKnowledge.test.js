// tests/selfKnowledge.test.js
//
// The bot explaining its own moderation, without making it up.
//
// Asked in chat what "DM suppressed" meant, it answered: "dm suppression is
// me throttling their ability to message people... the spam detector flags
// the account and i put a mute on their dms." Every clause invented. The
// owner had to tell the channel to ignore it.
//
// Three properties are pinned here, and they are in tension on purpose:
//
//   IT FIRES RARELY. An ordinary reply must carry none of this. The whole
//   design rests on paying only when somebody actually asked.
//   IT CANNOT GO STALE. No number is written in the prose; every one is
//   interpolated from live settings, so the card cannot drift from the code
//   the way a hand-written description always does.
//   NUMBERS ARE FOR STAFF. Mechanisms to anyone; exact thresholds only to
//   people who can already read the mod channels, because "12 days and the
//   third try" is a specification for getting in.

jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockSettings = {};
jest.mock('../src/utils/joinGate/config', () => ({
    getSettings: jest.fn(async () => mockSettings),
    formatDays: minutes => String(Number(minutes) / 1440),
}));

const { describeOwnModeration, wantsExplanation, LOG_VOCABULARY } = require('../src/utils/joinGate/explain');

const ARMED = {
    enabled: true,
    min_account_age_minutes: 12 * 1440,
    dm_enabled: true,
    dm_cooldown_minutes: 60,
    escalate_enabled: true,
    escalate_after_attempts: 3,
    suspicion_enabled: true,
    suspicion_watch_at: 40, suspicion_suspect_at: 70, suspicion_malicious_at: 100,
    suspicion_watch_action: 'log', suspicion_suspect_action: 'log', suspicion_malicious_action: 'log',
    watch_enabled: true, watch_window_minutes: 10, watch_action_at: 100, watch_action: 'log',
};

const load = (over = {}) => Object.assign(mockSettings, ARMED, over);

beforeEach(() => {
    for (const key of Object.keys(mockSettings)) delete mockSettings[key];
});

describe('it fires only when somebody asked', () => {
    test.each([
        'what does dm suppressed mean',
        'why did you kick them',
        'how does your join gate work',
        'their account was too new?',
        'whats a temp ban here',
        'what is a suspicion score',
    ])('"%s" asks about moderation', text => {
        expect(wantsExplanation(text)).toBe(true);
    });

    test.each([
        'hey whats up',
        'i got banned from blackjack lmao',
        'ban me from the casino',
        'kick it to me',
        'that video was insane',
        '',
    ])('"%s" does not', text => {
        expect(wantsExplanation(text)).toBe(false);
    });

    test('a bare callout is not enough on its own', () => {
        // Most callouts are "you're annoying", not "how does your gate work".
        expect(wantsExplanation('youre so annoying', { mode: 'callout', focus: 'the bot being rude' })).toBe(false);
    });

    test('but a callout about moderation is', () => {
        expect(wantsExplanation('explain yourself', { mode: 'callout', focus: 'why the bot kicked someone' })).toBe(true);
        expect(wantsExplanation('explain yourself', { mode: 'callout', focus: 'banned an account' })).toBe(true);
    });

    // The looser check runs on free prose, so it has to survive ordinary
    // words that merely start like moderation ones.
    test.each(['that was a banger track', 'gateau recipe', 'kickstarter link'])(
        'a callout about "%s" is not about moderation', focus => {
            expect(wantsExplanation('explain yourself', { mode: 'callout', focus })).toBe(false);
        });
});

describe('nothing in the prose can go stale', () => {
    test('the source writes down no threshold of its own', () => {
        const source = require('fs').readFileSync(
            require('path').join(__dirname, '..', 'src', 'utils', 'joinGate', 'explain.js'), 'utf8');
        // Strip the block comments, the regex list and the interpolations,
        // then look for bare numbers pretending to be facts about config.
        const prose = source
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\$\{[^}]*\}/g, '')
            .replace(/const ASKS_ABOUT_MODERATION[\s\S]*?'i'\);/, '');
        expect(prose).not.toMatch(/\b\d+\s*days\b/i);
        expect(prose).not.toMatch(/\b\d+\s*minutes\b/i);
        expect(prose).not.toMatch(/attempt \d/i);
    });

    test('the numbers it does state come from the settings it was handed', async () => {
        load({ min_account_age_minutes: 30 * 1440, escalate_after_attempts: 5 });
        const text = await describeOwnModeration('g1', { staff: true });
        expect(text).toContain('30 days');
        expect(text).toContain('attempt 5');
        expect(text).not.toContain('12 days');
    });
});

describe('numbers are for staff', () => {
    test('staff get the exact configuration', async () => {
        load();
        const text = await describeOwnModeration('g1', { staff: true });
        expect(text).toContain('12 days');
        expect(text).toContain('watch at 40');
        expect(text).toMatch(/first 10 minutes/);
    });

    test('everyone else gets the mechanism and no numbers', async () => {
        load();
        const text = await describeOwnModeration('g1', { staff: false });
        expect(text).not.toContain('12 days');
        expect(text).not.toContain('watch at 40');
        expect(text).not.toMatch(/attempt \d/);
        // The mechanism still gets explained, which is the point.
        expect(text).toMatch(/how old their Discord account is/);
        expect(text).toMatch(/lifts itself/);
    });

    test('and is told not to recite the thresholds it was not given', async () => {
        load();
        const text = await describeOwnModeration('g1', { staff: false });
        expect(text).toMatch(/not staff/i);
    });
});

describe('what it says about the line that caused all this', () => {
    test('the DM field is described as the bot notifying, never as a restriction', async () => {
        load();
        const text = await describeOwnModeration('g1', { staff: true });
        expect(text).toContain('Told them why');
        expect(text).toMatch(/never a restriction placed on them/);
        expect(text).toMatch(/no ability to/);
    });

    test('and that a temp-ban lifts itself, with a human ban replacing it', async () => {
        load();
        const text = await describeOwnModeration('g1', { staff: true });
        expect(text).toMatch(/lifts itself/);
        expect(text).toMatch(/stops the automatic lift/);
    });

    test('the vocabulary is stated, not hedged', () => {
        expect(LOG_VOCABULARY.join(' ')).toMatch(/Told them why/);
    });
});

describe('it never overstates a switched-off system', () => {
    test('a disabled gate says so and claims nothing else', async () => {
        load({ enabled: false });
        const text = await describeOwnModeration('g1', { staff: true });
        expect(text).toMatch(/switched off/);
        expect(text).not.toMatch(/12 days/);
        expect(text).not.toMatch(/suspicion/i);
    });

    test('a disabled scorer is simply absent', async () => {
        load({ suspicion_enabled: false, watch_enabled: false });
        const text = await describeOwnModeration('g1', { staff: true });
        expect(text).toContain('12 days');
        expect(text).not.toMatch(/score the PROFILE/);
        expect(text).not.toMatch(/what brand-new members POST/);
    });

    test('an unreadable config says nothing at all rather than guessing', async () => {
        const { getSettings } = require('../src/utils/joinGate/config');
        getSettings.mockRejectedValueOnce(new Error('db down'));
        expect(await describeOwnModeration('g1', { staff: true })).toBe('');
    });
});

describe('it is a briefing, not a capability', () => {
    test('the module cannot act on anybody', () => {
        const source = require('fs').readFileSync(
            require('path').join(__dirname, '..', 'src', 'utils', 'joinGate', 'explain.js'), 'utf8');
        for (const forbidden of ['.ban(', '.kick(', '.timeout(', '.send(', 'updateSettings']) {
            expect(source).not.toContain(forbidden);
        }
    });

    test('and it admits its own limits', async () => {
        load();
        const text = await describeOwnModeration('g1', { staff: true });
        expect(text).toMatch(/say you\s+are not sure|are not sure/);
    });
});
