// tests/interjections.test.js
//
// An interjection is the one thing this bot says that nobody asked for, which
// inverts every trade-off the reply path makes. Latency stops mattering:
// nobody is watching a typing indicator, so there is no reason to ship the
// first draft that arrives. Relevance starts mattering more: an unprompted
// remark that adds nothing is worse than silence, where a merely mediocre
// answer to a real question is not.
//
// So the rules pinned here are the mirror image of the reply pipeline's. The
// scout's read travels forward instead of collapsing to a yes/no. The panel
// is wider. The judge may reject the whole field and post nothing, and when
// the judge cannot be reached the path fails CLOSED, which is the opposite of
// what a reply does.

const fs = require('fs');
const path = require('path');
const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

jest.mock('../src/utils/apiHelpers', () => ({ callOpenRouterAPI: jest.fn() }));
jest.mock('../src/utils/db', () => ({
    getSpeakConfigValue: jest.fn(),
    pool: { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) },
}));

const { callOpenRouterAPI } = require('../src/utils/apiHelpers');
const { getSpeakConfigValue } = require('../src/utils/db');
const {
    DEFAULT_INTERJECTION_PROFILE, normalisePipeline, pickBestDraft,
} = require('../src/utils/speakPipeline');
const { scoutMoment } = require('../src/utils/interjectionBouncer');
const { shouldInterject, creditVeto, resetCooldowns } = require('../src/utils/interjections');

beforeEach(() => {
    jest.clearAllMocks();
    resetCooldowns();
});

/** A channel whose history is whatever these lines say. */
function fakeMessage(lines, channelId = 'c1') {
    const values = lines.map((text, i) => ({
        content: text,
        author: { bot: false, username: `user${i}` },
        member: { displayName: `user${i}` },
    }));
    return {
        channelId,
        content: lines[lines.length - 1] ?? '',
        channel: { messages: { fetch: jest.fn(async () => ({ size: values.length, values: () => values })) } },
    };
}

const CHATTY = ['i think the new season is a downgrade', 'no way, the map is better', 'the map is fine, the guns are not'];

describe('the interjection profile', () => {
    test('it is on by default, with the veto, unlike every other pipeline piece', () => {
        // Deliberate: the reply toggles default off because they cost latency
        // on a path someone is waiting on. This one costs none.
        expect(DEFAULT_INTERJECTION_PROFILE.enabled).toBe(true);
        expect(DEFAULT_INTERJECTION_PROFILE.veto).toBe(true);
    });

    test('the panel is wider than a reply gets, and not all one lineage', () => {
        const writers = DEFAULT_INTERJECTION_PROFILE.writers;
        expect(writers.length).toBe(4);
        expect(writers.length).toBeGreaterThan(normalisePipeline(null).writers.length);
        // Three drafts that rhyme with each other is not a panel.
        const lineages = new Set(writers.map(w => w.split('/')[0]));
        expect(lineages.size).toBeGreaterThanOrEqual(3);
    });

    test('a stored profile overrides the defaults, garbage does not', () => {
        const cfg = normalisePipeline({ interjection: { enabled: false, veto: false, writers: ['a/b', 'nope', 7] } });
        expect(cfg.interjection.enabled).toBe(false);
        expect(cfg.interjection.veto).toBe(false);
        expect(cfg.interjection.writers).toEqual(['a/b']);

        const junk = normalisePipeline({ interjection: { writers: ['nope', 7] } });
        expect(junk.interjection.writers).toEqual([...DEFAULT_INTERJECTION_PROFILE.writers]);
    });

    test('the panel is capped, so a bad config cannot become a bad bill', () => {
        const cfg = normalisePipeline({ interjection: { writers: Array(20).fill('a/b') } });
        expect(cfg.interjection.writers).toHaveLength(5);
    });

    test('the live reply path is untouched by any of it', () => {
        const cfg = normalisePipeline({ interjection: { enabled: true } });
        expect(cfg.prepass).toBe(false);
        expect(cfg.drafts).toBe(false);
    });
});

describe('the silence gate', () => {
    const drafts = ['first draft', 'second draft', 'third draft'];
    const args = { drafts, conversationContext: 'a: hello\nb: hi', userPrompt: '(interjection)', utilityModel: 'x/y' };

    test('a judge that answers 0 posts nothing at all', async () => {
        callOpenRouterAPI.mockResolvedValue('0');
        expect(await pickBestDraft({ ...args, veto: true })).toBeNull();
    });

    test('a judge that picks one still returns it', async () => {
        callOpenRouterAPI.mockResolvedValue('2');
        expect(await pickBestDraft({ ...args, veto: true })).toBe('second draft');
    });

    test('an unreachable judge fails closed here and open on a real reply', async () => {
        callOpenRouterAPI.mockRejectedValue(new Error('gateway timeout'));
        expect(await pickBestDraft({ ...args, veto: true })).toBeNull();
        expect(await pickBestDraft({ ...args, veto: false })).toBe('first draft');
    });

    test('an unreadable verdict is not treated as a veto by accident', async () => {
        callOpenRouterAPI.mockResolvedValue('the second one, obviously');
        // "second" contains no digit; there is no pick, so it fails closed
        // rather than guessing at what the judge meant.
        expect(await pickBestDraft({ ...args, veto: true })).toBeNull();
    });

    test('a single surviving draft is still judged when the veto is on', async () => {
        callOpenRouterAPI.mockResolvedValue('0');
        expect(await pickBestDraft({ ...args, drafts: ['only one'], veto: true })).toBeNull();
        expect(callOpenRouterAPI).toHaveBeenCalled();
    });

    test('and is shipped unjudged when it is off: no judge can improve on one option', async () => {
        expect(await pickBestDraft({ ...args, drafts: ['only one'], veto: false })).toBe('only one');
        expect(callOpenRouterAPI).not.toHaveBeenCalled();
    });

    test('the veto is offered to the judge in words, not just in parsing', async () => {
        callOpenRouterAPI.mockResolvedValue('1');
        await pickBestDraft({ ...args, veto: true });
        const prompt = callOpenRouterAPI.mock.calls[0][1][0].content;
        expect(prompt).toContain('answer 0');
        expect(prompt).toMatch(/stay silent/i);
    });
});

describe('the scout', () => {
    test('its read travels forward instead of collapsing to a yes', async () => {
        callOpenRouterAPI.mockResolvedValue('{"worth": true, "hook": "the map is fine, the guns are not", "mode": "banter"}');
        const read = await scoutMoment(fakeMessage(CHATTY), { model: 'x/y' });
        expect(read).toEqual({ worth: true, hook: 'the map is fine, the guns are not', mode: 'banter' });
    });

    test('an unreachable model lets the moment through rather than silencing everything', async () => {
        callOpenRouterAPI.mockResolvedValue(null);
        expect((await scoutMoment(fakeMessage(CHATTY), { model: 'x/y' })).worth).toBe(true);
    });

    test('a channel with nothing but images is not a moment to react to', async () => {
        const read = await scoutMoment(fakeMessage(['']), { model: 'x/y' });
        expect(read.worth).toBe(false);
        expect(callOpenRouterAPI).not.toHaveBeenCalled();
    });

    test('a model that answers in bare words instead of JSON is still understood', async () => {
        callOpenRouterAPI.mockResolvedValue('NO');
        expect((await scoutMoment(fakeMessage(CHATTY), { model: 'x/y' })).worth).toBe(false);
    });

    test('it reads more of the channel than a reply gate would', () => {
        expect(require('../src/utils/interjectionBouncer').CONTEXT_MESSAGES).toBeGreaterThanOrEqual(12);
    });
});

describe('the gauntlet', () => {
    const config = (extra = {}) => ({
        enabled: true, channels: ['c1'], keywords: [], chance: 100, cooldownMinutes: 10, bouncer: false, ...extra,
    });

    beforeEach(() => {
        getSpeakConfigValue.mockImplementation(async (key) => (key === 'interjections' ? config() : null));
    });

    test('a clean pass reports no scout read when the scout is off', async () => {
        expect(await shouldInterject(fakeMessage(CHATTY))).toEqual({ ok: true, scout: null });
    });

    test('the cooldown blocks the very next message', async () => {
        expect((await shouldInterject(fakeMessage(CHATTY))).ok).toBe(true);
        expect((await shouldInterject(fakeMessage(CHATTY))).ok).toBe(false);
    });

    test('a passing scout hands its read to the caller', async () => {
        getSpeakConfigValue.mockImplementation(async (key) =>
            (key === 'interjections' ? config({ bouncer: true }) : null));
        callOpenRouterAPI.mockResolvedValue('{"worth": true, "hook": "the guns", "mode": "banter"}');

        const verdict = await shouldInterject(fakeMessage(CHATTY));
        expect(verdict).toEqual({ ok: true, scout: { hook: 'the guns', mode: 'banter' } });
    });

    test('a scout that refuses costs a quarter of the window, not all of it', async () => {
        getSpeakConfigValue.mockImplementation(async (key) =>
            (key === 'interjections' ? config({ bouncer: true }) : null));
        callOpenRouterAPI.mockResolvedValue('{"worth": false, "hook": "", "mode": "banter"}');

        expect((await shouldInterject(fakeMessage(CHATTY))).ok).toBe(false);

        // Two and a half minutes of a ten minute window remain: a dull moment
        // must not buy silence through an interesting one.
        const now = Date.now();
        jest.spyOn(Date, 'now').mockReturnValue(now + 2 * 60_000);
        callOpenRouterAPI.mockResolvedValue('{"worth": true, "hook": "x", "mode": "banter"}');
        expect((await shouldInterject(fakeMessage(CHATTY))).ok).toBe(false);

        jest.spyOn(Date, 'now').mockReturnValue(now + 3 * 60_000);
        expect((await shouldInterject(fakeMessage(CHATTY))).ok).toBe(true);
        Date.now.mockRestore();
    });

    test('a vetoed remark hands the same share back', async () => {
        expect((await shouldInterject(fakeMessage(CHATTY))).ok).toBe(true);
        await creditVeto('c1');

        const now = Date.now();
        jest.spyOn(Date, 'now').mockReturnValue(now + 3 * 60_000);
        expect((await shouldInterject(fakeMessage(CHATTY))).ok).toBe(true);
        Date.now.mockRestore();
    });
});

// The wiring inside speak.js needs a live reply to exercise.
describe('the wiring', () => {
    const speak = read('src/commands/tools/speak.js');

    test('an interjection gets the profile whatever the live toggles say', () => {
        expect(speak).toContain('richInterjection || pipeline.prepass');
        expect(speak).toContain('richInterjection || pipeline.drafts');
        expect(speak).toContain('richInterjection ? interjectProfile.writers : pipeline.writers');
    });

    test('it thinks for longer, but not forever', () => {
        expect(speak).toMatch(/INTERJECTION_DEADLINE_MS = \d\d_000/);
        const ceiling = Number(speak.match(/INTERJECTION_DEADLINE_MS = (\d+)_000/)[1]);
        expect(ceiling).toBeGreaterThan(20);
        expect(ceiling).toBeLessThanOrEqual(60);
    });

    test('the judge is never skipped for the clock when it holds the veto', () => {
        expect(speak).toContain('wants.veto || timeLeft > JUDGE_MIN_BUDGET_MS');
    });

    test('a veto ends the turn quietly and gives the cooldown back', () => {
        const block = speak.slice(speak.indexOf('if (vetoed)'), speak.indexOf('if (vetoed)') + 400);
        expect(block).toContain("outcome: 'vetoed'");
        expect(block).toContain('creditVeto(channelId)');
        // No sendError, no message: staying quiet is the feature.
        expect(block).not.toContain('sendError');
    });

    test('the scout read is reused rather than paid for twice', () => {
        expect(speak).toContain('_interjectionScout');
        expect(speak).toContain("from: scout?.hook ? 'scout' : 'prepass'");
    });

    test('an interjection never shows a typing indicator', () => {
        expect(read('src/events/client/messageCreate.js')).toContain('if (!interjecting) this._startTyping()');
    });
});
