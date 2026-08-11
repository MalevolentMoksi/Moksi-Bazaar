// tests/watch.test.js
//
// The behaviour window, pinned against a real incident.
//
// On 2026-08-04 an advertising bot joined, scored 44 on its profile (watch
// tier), then posted "@everyone ... https://discord.gg/..." into three
// channels. It scored 67 against an action threshold of 100 and nothing
// happened. These tests encode both the scoring and, more importantly, the
// structural reason the sweep across channels was invisible.

const watch = require('../src/utils/joinGate/watch');

const GUILD = 'guild-1';
const USER = 'user-1';
const WINDOW_MS = 10 * 60_000;

/** The exact payload from the incident. */
const ADVERT =
    '@everyone If you\'re interested in learning more about psychedelics, cannabis, '
    + 'and current research, this community is a welcoming place for respectful discussions, '
    + 'educational resources, harm reduction information, and shared experiences. '
    + 'https://discord.gg/5kBrKqqtZ';

function message(content, channelId, { everyone = false, mentions = 0 } = {}) {
    return {
        content,
        channelId,
        author: { id: USER },
        mentions: {
            everyone,
            users: { size: mentions },
            roles: { size: 0 },
        },
    };
}

const inspect = (msg, threshold = 100) =>
    watch.inspectMessage(GUILD, msg, { windowMs: WINDOW_MS, threshold });

beforeEach(() => {
    watch.reset();
    watch.watchMember(GUILD, USER);
});

describe('the incident', () => {
    test('one advert message now clears an action threshold of 100', () => {
        const result = inspect(message(ADVERT, 'chan-a'));

        const ids = result.signals.map(s => s.id);
        expect(ids).toEqual(expect.arrayContaining([
            'link_in_first_message', 'invite_link', 'everyone_attempt', 'advert_broadcast',
        ]));
        // 12 link + 30 invite + 25 everyone + 35 combination.
        expect(result.score).toBe(102);
        expect(result.report).toBe(true);
    });

    test('the same advert in a second channel escalates instead of scoring zero', () => {
        inspect(message(ADVERT, 'chan-a'));
        watch.markReported(GUILD, USER, 102);

        const second = inspect(message(ADVERT, 'chan-b'));
        expect(second.signals.map(s => s.id)).toEqual(expect.arrayContaining([
            'cross_channel_spam', 'link_sweep',
        ]));
        // Previously this scored 0: the member had been forgotten after the
        // first report, so no later message was examined at all.
        expect(second.score).toBeGreaterThan(102);
        expect(second.report).toBe(true);
    });

    test('a profile already flagged on arrival lowers the bar further', () => {
        watch.setJoinScore(GUILD, USER, 44, 'watch');
        const result = inspect(message(ADVERT, 'chan-a'));
        // A quarter of 44, rounded.
        expect(result.signals.find(s => s.id === 'prior_suspicion')?.points).toBe(11);
        expect(result.score).toBe(113);
    });

    test('a clear profile carries nothing over', () => {
        watch.setJoinScore(GUILD, USER, 12, 'clear');
        const result = inspect(message(ADVERT, 'chan-a'));
        expect(result.signals.some(s => s.id === 'prior_suspicion')).toBe(false);
        expect(result.score).toBe(102);
    });

    test('the echo never testifies alone: an innocuous message reports nothing', () => {
        // The panel this pins away: a watch-tier joiner posts something
        // ordinary, and the mod channel gets "Behaviour flag: score 13" whose
        // only line is the profile echo, under a footer swearing it was
        // triggered by what they posted. Every point was how the profile looks.
        watch.setJoinScore(GUILD, USER, 51, 'watch');
        const result = inspect(message('nice cat', 'chan-a'));

        expect(result.signals).toEqual([]);
        expect(result.score).toBe(0);
        expect(result.report).toBe(false);
    });

    test('a join notification is not the member speaking', () => {
        // The production case behind the score-13 panel: thevortex2229 NEVER
        // spoke. Their entire message history was Discord's own "just landed.
        // Wave to say hi!" announcement, which arrives authored as the member,
        // with system=true and no content, the instant they join. The watch
        // treated it as their first message, stored "(no text)" as evidence,
        // and reported them for it.
        watch.setJoinScore(GUILD, USER, 51, 'watch');
        const joinNotice = { ...message('', 'chan-general'), system: true };
        const result = inspect(joinNotice);

        expect(result).toEqual({ score: 0, signals: [], report: false, fresh: [] });
        // Nothing recorded either: the day a real report fires, its evidence
        // must not open with a message the member never typed.
        expect(watch.evidenceFor(GUILD, USER)).toEqual([]);
    });

    test('a system message never becomes evidence even mid-spree', () => {
        // Order matters: a boost announcement landing between two real spam
        // messages must not appear in the quoted evidence.
        inspect(message(ADVERT, 'chan-a'));
        inspect({ ...message('', 'chan-a'), system: true });

        const evidence = watch.evidenceFor(GUILD, USER);
        expect(evidence).toHaveLength(1);
        expect(evidence[0].content).toContain('discord.gg');
    });

    test('the echo joins the first real signal, at full strength', () => {
        // Staying quiet on innocuous messages must not cost the carry-over
        // when behaviour does appear: same points as if it had been there all
        // along.
        watch.setJoinScore(GUILD, USER, 44, 'watch');
        inspect(message('hello', 'chan-a'));
        const result = inspect(message(ADVERT, 'chan-a'));

        expect(result.signals.find(s => s.id === 'prior_suspicion')?.points).toBe(11);
        expect(result.score).toBe(113);
        expect(result.report).toBe(true);
    });
});

describe('cumulative scoring is a union, not a sum', () => {
    test('the same invite posted twice in one channel does not double the invite', () => {
        const first = inspect(message('join https://discord.gg/abcd', 'chan-a'));
        const second = inspect(message('join https://discord.gg/abcd', 'chan-a'));
        // Second copy adds nothing on its own: same signals, same channel, and
        // two is below the duplicate threshold of three.
        expect(second.score).toBe(first.score);
    });

    test('a third copy in one channel is repetition and does add', () => {
        inspect(message('join https://discord.gg/abcd', 'chan-a'));
        inspect(message('join https://discord.gg/abcd', 'chan-a'));
        const third = inspect(message('join https://discord.gg/abcd', 'chan-a'));
        expect(third.signals.map(s => s.id)).toContain('duplicate_spam');
    });

    test('signals from different messages combine', () => {
        const ping = inspect(message('@everyone hey', 'chan-a', { everyone: true }));
        expect(ping.signals.map(s => s.id)).toEqual(['everyone_attempt']);

        const invite = inspect(message('https://discord.gg/abcd', 'chan-a'));
        // The window remembers the ping, so the pair earns the combination
        // even though they arrived in separate messages.
        expect(invite.signals.map(s => s.id)).toContain('advert_broadcast');
    });
});

describe('reporting', () => {
    test('does not re-report the same standing over and over', () => {
        const first = inspect(message('https://discord.gg/abcd', 'chan-a'));
        expect(first.report).toBe(true);
        watch.markReported(GUILD, USER, first.score);

        const second = inspect(message('https://discord.gg/abcd', 'chan-a'));
        expect(second.score).toBe(first.score);
        expect(second.report).toBe(false);
    });

    test('reports again once it crosses the action threshold', () => {
        const first = inspect(message('https://discord.gg/abcd', 'chan-a'));
        watch.markReported(GUILD, USER, first.score);
        expect(first.score).toBeLessThan(100);

        const second = inspect(message(ADVERT, 'chan-b'));
        expect(second.score).toBeGreaterThanOrEqual(100);
        expect(second.report).toBe(true);
    });
});

describe('ordinary newcomers stay quiet', () => {
    test('a plain hello scores nothing', () => {
        expect(inspect(message('hi everyone, glad to be here', 'chan-a')).score).toBe(0);
    });

    test('a single link is noted but nowhere near actionable', () => {
        const result = inspect(message('here is the track https://youtube.com/watch?v=x', 'chan-a'));
        expect(result.score).toBe(12);
        expect(result.score).toBeLessThan(100);
    });

    test('saying the word everyone without the ping is not a ping', () => {
        expect(inspect(message('hello everyone', 'chan-a')).score).toBe(0);
    });

    test('an invite on its own is not enough to act on', () => {
        const result = inspect(message('my other server is https://discord.gg/abcd', 'chan-a'));
        // 30 invite + 12 link. Logged, not actioned.
        expect(result.score).toBe(42);
        expect(result.score).toBeLessThan(100);
    });

    // "join us at discord.gg/ours" is help, not advertising, and people paste
    // it constantly. Scored as an invite it came to 42: a mod report, in the
    // same words as a real advert, for doing the server a favour.
    test('this server\'s own invite is not an invite to another server', () => {
        const ours = new Set(['festivalhub']);
        const result = watch.inspectMessage(GUILD, message('the invite is https://discord.gg/festivalhub', 'chan-a'), {
            windowMs: WINDOW_MS, threshold: 100, ownInviteCodes: ours,
        });
        expect(result.signals.map(s => s.id)).not.toContain('invite_link');
        expect(result.score).toBe(12); // still a link, and that is all it is
    });

    test('ours alongside someone else\'s is still advertising', () => {
        const ours = new Set(['festivalhub']);
        const result = watch.inspectMessage(GUILD, message(
            'we are at discord.gg/festivalhub and also discord.gg/otherplace', 'chan-a',
        ), { windowMs: WINDOW_MS, threshold: 100, ownInviteCodes: ours });
        expect(result.signals.map(s => s.id)).toContain('invite_link');
    });

    test('codes that could not be looked up leave the old behaviour alone', () => {
        // A failed fetch must not quietly stop counting invites.
        const result = watch.inspectMessage(GUILD, message('join https://discord.gg/festivalhub', 'chan-a'), {
            windowMs: WINDOW_MS, threshold: 100, ownInviteCodes: null,
        });
        expect(result.signals.map(s => s.id)).toContain('invite_link');
    });

    test('a member who was never watched scores nothing at all', () => {
        watch.forget(GUILD, USER);
        expect(inspect(message(ADVERT, 'chan-a')).score).toBe(0);
    });

    test('a member whose window has closed is dropped', () => {
        const result = watch.inspectMessage(GUILD, message(ADVERT, 'chan-a'), {
            windowMs: WINDOW_MS,
            now: Date.now() + WINDOW_MS + 1,
        });
        expect(result.score).toBe(0);
        expect(watch.watchedCount(GUILD)).toBe(0);
    });
});
