// tests/automodSignal.test.js
//
// Discord's AutoMod blocks a message before any bot can read it, so the
// strongest thing a fresh account can do (trip Discord's own spam classifier)
// was invisible to the watch window precisely because the platform handled it
// well. This scores that verdict.
//
// The line that matters is which rules count. The owner's AutoMod is a slur
// list, a politics list and a profanity filter: rules about people misbehaving,
// which a spam bot will never trip. Scoring those here would quietly turn a
// swearing filter into grounds for removal, so keyword triggers are worth zero
// and only Discord's own machine-shaped classifiers count.

const watch = require('../src/utils/joinGate/watch');

const GUILD = 'guild-automod';
const USER = 'user-automod';
const WINDOW_MS = 10 * 60_000;

const signal = (id, points, label = 'test') => ({ id, label, points, detail: 'detail' });
const note = (s, threshold = 100) =>
    watch.noteExternalSignal(GUILD, USER, s, { windowMs: WINDOW_MS, threshold });

beforeEach(() => {
    watch.reset();
    watch.watchMember(GUILD, USER);
});

describe('which AutoMod rules are allowed to score', () => {
    test('a server keyword rule is worth nothing by default', () => {
        // Slurs, politics, profanity. A person behaving badly, not a bot.
        expect(watch.BEHAVIOUR_WEIGHTS.automod_keyword).toBe(0);
    });

    test('Discord\'s own spam classifier is worth a lot', () => {
        expect(watch.BEHAVIOUR_WEIGHTS.automod_spam).toBeGreaterThan(30);
    });

    test('mention spam is worth a lot', () => {
        expect(watch.BEHAVIOUR_WEIGHTS.automod_mention_spam).toBeGreaterThan(30);
    });

    test('a zero-point signal is folded in as nothing at all', () => {
        // The enforcement path returns before ever calling this for a keyword
        // rule, but if it ever did, a zero must not create a phantom entry that
        // later shows up in a report with no points next to it.
        const result = note(signal('automod_keyword', 0));
        expect(result.score).toBe(0);
        expect(result.signals).toEqual([]);
    });
});

describe('an AutoMod verdict scores like anything else', () => {
    test('a watched member is scored', () => {
        const result = note(signal('automod_spam', 45));
        expect(result.score).toBe(45);
        expect(result.report).toBe(true);
        expect(result.signals.map(s => s.id)).toContain('automod_spam');
    });

    test('an unwatched member is ignored entirely', () => {
        expect(watch.noteExternalSignal(GUILD, 'someone-else', signal('automod_spam', 45), {
            windowMs: WINDOW_MS, threshold: 100,
        }).score).toBe(0);
    });

    test('a member whose window has expired is ignored and forgotten', () => {
        const result = watch.noteExternalSignal(GUILD, USER, signal('automod_spam', 45), {
            windowMs: WINDOW_MS, threshold: 100, now: Date.now() + WINDOW_MS + 1000,
        });
        expect(result.score).toBe(0);
        expect(watch.watchedCount(GUILD)).toBe(0);
    });

    test('the same rule firing twice does not stack', () => {
        note(signal('automod_spam', 45));
        expect(note(signal('automod_spam', 45)).score).toBe(45);
    });

    test('it accumulates with signals found in messages', () => {
        note(signal('automod_spam', 45));
        const result = note(signal('automod_mention_spam', 35));
        expect(result.score).toBe(80);
    });
});

describe('it shares the message path\'s arithmetic, not a copy of it', () => {
    test('a bad join score still lowers the bar', () => {
        // prior_suspicion is applied inside the shared fold, so it has to fire
        // for an AutoMod hit exactly as it does for a message. Two scoring
        // paths that drift apart would be worse than either being wrong.
        watch.setJoinScore(GUILD, USER, 60, 'suspect');
        const result = note(signal('automod_spam', 45));
        expect(result.signals.map(s => s.id)).toContain('prior_suspicion');
        expect(result.score).toBeGreaterThan(45);
    });

    test('the reporting rules are the shared ones', () => {
        // Reported once, then silent until it crosses the bar or gets much
        // worse, same as a message.
        expect(note(signal('automod_spam', 45)).report).toBe(true);
        watch.markReported(GUILD, USER, 45);
        expect(note(signal('automod_profile', 20)).report).toBe(false);
    });
});
