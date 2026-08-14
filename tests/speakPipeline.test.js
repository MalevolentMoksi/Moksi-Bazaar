// tests/speakPipeline.test.js
//
// The pipeline exists because every previous fix was "fix an input" or "add a
// rule", and both hit the same ceiling: one sample at temperature 0.85,
// published unconditionally. These pin the selection machinery, and above all
// its failure posture: every piece must degrade to the old behaviour, never
// block a reply, and never lose the legacy path while the toggles are off.

const fs = require('fs');
const path = require('path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

jest.mock('../src/utils/apiHelpers', () => ({
    callOpenRouterAPI: jest.fn(),
}));

const { callOpenRouterAPI } = require('../src/utils/apiHelpers');
const {
    DEFAULT_PIPELINE, normalisePipeline, readRoom, readBlock,
    pickBestDraft, stripReactionKey, recentOwnReplies, attitudeSentence,
    factualPanel, FACTUAL_MODES,
} = require('../src/utils/speakPipeline');

beforeEach(() => jest.clearAllMocks());

describe('the config cannot arrive broken', () => {
    test('everything is off by default: the legacy path until a switch is flipped', () => {
        expect(DEFAULT_PIPELINE.prepass).toBe(false);
        expect(DEFAULT_PIPELINE.drafts).toBe(false);
        expect(DEFAULT_PIPELINE.memory).toBe(false);
        expect(DEFAULT_PIPELINE.attitude).toBe(false);
    });

    test('the default lineup is two flash drafts and the humor wildcard', () => {
        expect(DEFAULT_PIPELINE.writers).toEqual([
            'deepseek/deepseek-v4-flash-0731',
            'deepseek/deepseek-v4-flash-0731',
            'moonshotai/kimi-k2.6',
        ]);
    });

    test('garbage writers fall back to the defaults instead of an empty lineup', () => {
        const cfg = normalisePipeline({ writers: ['not a model', 123, ''] });
        expect(cfg.writers).toEqual([...DEFAULT_PIPELINE.writers]);
    });

    test('a partial config only changes what it names', () => {
        const cfg = normalisePipeline({ prepass: true });
        expect(cfg.prepass).toBe(true);
        expect(cfg.drafts).toBe(false);
        expect(cfg.utilityModel).toBe(DEFAULT_PIPELINE.utilityModel);
    });

    test('null and non-objects mean the defaults', () => {
        expect(normalisePipeline(null)).toMatchObject({ prepass: false, drafts: false });
        expect(normalisePipeline('yes please')).toMatchObject({ prepass: false });
    });
});

describe('reading the room', () => {
    const args = {
        conversationContext: 'Moksi: check this out',
        askerName: 'Moksi',
        userRequest: 'thoughts?',
        isInterjection: false,
        utilityModel: 'x/y',
    };

    test('a clean JSON verdict parses into mode, focus and clamped tone', async () => {
        callOpenRouterAPI.mockResolvedValue('{"mode":"question","focus":"the new album","tone":0.4}');
        const read = await readRoom(args);
        expect(read).toEqual({ mode: 'question', focus: 'the new album', tone: 0.4 });
    });

    test('chatter around the JSON is tolerated; models narrate', async () => {
        callOpenRouterAPI.mockResolvedValue('Sure! Here is my read:\n{"mode":"media","focus":"a cat on a keyboard","tone":2}\nHope that helps.');
        const read = await readRoom(args);
        expect(read.mode).toBe('media');
        expect(read.tone).toBe(1); // clamped
    });

    test('an unknown mode lands on banter rather than crashing the prompt', async () => {
        callOpenRouterAPI.mockResolvedValue('{"mode":"vibes","focus":"","tone":"loud"}');
        const read = await readRoom(args);
        expect(read.mode).toBe('banter');
        expect(read.tone).toBe(0);
    });

    test('no JSON at all means no read, and the reply goes on without one', async () => {
        callOpenRouterAPI.mockResolvedValue('i cannot help with that');
        expect(await readRoom(args)).toBeNull();
        callOpenRouterAPI.mockResolvedValue(null);
        expect(await readRoom(args)).toBeNull();
    });

    test('the read block is empty for a null read and short for a real one', () => {
        expect(readBlock(null)).toBe('');
        const block = readBlock({ mode: 'heavy', focus: 'their dog died', tone: 0 });
        expect(block).toContain('their dog died');
        expect(block).toContain('drop the bit');
    });
});

describe('judging drafts', () => {
    const drafts = ['first draft', 'second draft', 'third draft'];
    const base = { conversationContext: 'a: hi\nYou (Cooler Moksi): hello', userPrompt: 'a: hi', utilityModel: 'x/y' };

    test('the winning number picks the draft', async () => {
        callOpenRouterAPI.mockResolvedValue('2');
        expect(await pickBestDraft({ drafts, ...base })).toBe('second draft');
    });

    test('a chatty verdict still yields its number', async () => {
        callOpenRouterAPI.mockResolvedValue('The best is 3.');
        expect(await pickBestDraft({ drafts, ...base })).toBe('third draft');
    });

    test('nonsense, silence and out-of-range all ship the first draft', async () => {
        callOpenRouterAPI.mockResolvedValue('they are all bad');
        expect(await pickBestDraft({ drafts, ...base })).toBe('first draft');
        callOpenRouterAPI.mockResolvedValue(null);
        expect(await pickBestDraft({ drafts, ...base })).toBe('first draft');
        callOpenRouterAPI.mockResolvedValue('9');
        expect(await pickBestDraft({ drafts, ...base })).toBe('first draft');
    });

    test('a judge that throws ships the first draft; a reply is waiting', async () => {
        callOpenRouterAPI.mockRejectedValue(new Error('down'));
        expect(await pickBestDraft({ drafts, ...base })).toBe('first draft');
    });

    test('one draft needs no judge and costs no call', async () => {
        expect(await pickBestDraft({ drafts: ['only'], ...base })).toBe('only');
        expect(callOpenRouterAPI).not.toHaveBeenCalled();
    });

    test('the shape criterion sees only the bot\'s own recent lines', () => {
        const log = 'Moksi: hi\nYou (Cooler Moksi): what.\nDyno: [automod]\nYou (Cooler Moksi): still here.';
        expect(recentOwnReplies(log)).toEqual(['what.', 'still here.']);
    });

    test('a mod panel is not a reply the judge should compare shapes against', () => {
        // From the spam-incident traces: the bot's last "reply" was the
        // behaviour-flag panel, so the judge's shape-variety criterion was
        // measuring candidate prose against a moderation report. Panels are
        // filtered before the slice, so they also cannot crowd a real typed
        // reply out of the comparison window.
        const log = [
            'You (Cooler Moksi): what.',
            'You (Cooler Moksi): [no text] [panel: humphrey00614 | 🚨 Behaviour flag: score 102]',
            'zoeyy: it doesnt say who',
            'You (Cooler Moksi): still here.',
        ].join('\n');

        expect(recentOwnReplies(log)).toEqual(['what.', 'still here.']);
    });

    test('the rubric kills descriptions of media that nothing describes', async () => {
        // Both live judge misses shared one signature: no candidate had ground
        // truth, and the most confidently specific fabrication won. The knife
        // GIF pick even violated the rubric's own first criterion, because
        // "invents nothing not in the log" reads as being about events, not
        // about whether a bare URL counts as having watched a GIF.
        callOpenRouterAPI.mockResolvedValue('1');
        await pickBestDraft({ drafts, ...base });

        const prompt = callOpenRouterAPI.mock.calls[0][1][0].content;
        expect(prompt).toContain('no tag describes its contents');
        // Deliberately anchored to shared MEDIA and nothing wider. A broader
        // "claims not in the log lose" would also condemn a correct answer to
        // "why did discord do X" drawn from genuine knowledge, and teach the
        // judge to prefer sheepishness over knowing things.
        expect(prompt).toMatch(/If media was shared and no tag describes its contents/);
    });
});

describe('the attitude sentence stops contradicting itself', () => {
    test('a long-known neutral user is familiar, never a stranger', () => {
        const line = attitudeSentence({ interactionCount: 200, sentimentScore: 0 });
        expect(line).toContain('regular');
        expect(line).not.toContain('stranger');
    });

    test('a genuinely unknown user still reads as one', () => {
        expect(attitudeSentence({ interactionCount: 0, sentimentScore: 0 })).toContain('never spoken');
    });

    test('earned hostility survives the rewrite', () => {
        expect(attitudeSentence({ interactionCount: 10, sentimentScore: -0.8 })).toContain('hostility');
    });
});

// Source-level guards, same style as persona.test.js: the reversibility
// promise is a property of the code, so the code is what gets checked.
describe('nothing legacy was lost', () => {
    test('the old writer still exists for the pipeline-off path', () => {
        expect(read('src/commands/tools/speak.js')).toContain("'deepseek/deepseek-chat'");
    });

    test('the reply deadline is 20 seconds and the luxuries check it', () => {
        const speak = read('src/commands/tools/speak.js');
        expect(speak).toContain('REPLY_DEADLINE_MS = 20_000');
        expect(speak).toContain('PREPASS_LATEST_START_MS');
        expect(speak).toContain('JUDGE_MIN_BUDGET_MS');
    });

    test('memory retention is per user; the global cap is gone', () => {
        const db = read('src/utils/db.js');
        expect(db).toContain('WHERE user_id = $1 AND id NOT IN');
        expect(db).not.toContain('reltuples');
    });

    test('the full reset demands the literal word RESET and runs as one transaction', () => {
        const settings = read('src/commands/tools/speak_settings.js');
        expect(settings).toContain("!== 'RESET'");
        expect(settings).toContain('DELETE FROM conversation_memories');
        expect(settings).toContain("'BEGIN'");
        expect(settings).toContain("'COMMIT'");
        expect(settings).toContain("'ROLLBACK'");
    });
});

// The August 2026 telemetry round: the worst-rated cluster was fabricated
// real-world facts, every draft equally wrong, judge marked blameless. A rule
// or a criterion only selects among fabrications; the fix is a writer that
// actually knows the answer, seated only for the moments that need one.
describe('factual moments get a writer that knows things', () => {
    test('the factual writer is a different lineage from the panel and the judge', () => {
        expect(DEFAULT_PIPELINE.factualWriter).toBe('google/gemini-3.7-flash');
        expect(DEFAULT_PIPELINE.writers).not.toContain(DEFAULT_PIPELINE.factualWriter);
        expect(DEFAULT_PIPELINE.utilityModel).not.toBe(DEFAULT_PIPELINE.factualWriter);
    });

    test('a garbage factual writer falls back; a real id is kept', () => {
        expect(normalisePipeline({ factualWriter: 'not a model' }).factualWriter)
            .toBe(DEFAULT_PIPELINE.factualWriter);
        expect(normalisePipeline({ factualWriter: 'vendor/some-model' }).factualWriter)
            .toBe('vendor/some-model');
    });

    test('question and media are factual moments; banter and callout are not', () => {
        expect(FACTUAL_MODES.has('question')).toBe(true);
        expect(FACTUAL_MODES.has('media')).toBe(true);
        expect(FACTUAL_MODES.has('banter')).toBe(false);
        expect(FACTUAL_MODES.has('callout')).toBe(false);
    });

    test('the factual writer takes the last slot and never doubles up', () => {
        expect(factualPanel(['a/x', 'a/x', 'b/y'], 'c/z')).toEqual(['a/x', 'a/x', 'c/z']);
        expect(factualPanel(['a/x', 'c/z'], 'c/z')).toEqual(['a/x', 'c/z']);
        expect(factualPanel([], 'c/z')).toEqual([]);
        expect(factualPanel(['a/x'], null)).toEqual(['a/x']);
    });

    test('the model-id watchdog covers the factual writer', () => {
        expect(read('src/utils/speakPipeline.js'))
            .toMatch(/cfg\.factualWriter,\s*\n\s*\.\.\.Object\.values\(SPEAK_MODELS\)/);
    });

    test('the prepass is told a playful factual ask is still a question', async () => {
        callOpenRouterAPI.mockResolvedValue('{"mode":"question","focus":"x","tone":0}');
        await readRoom({ conversationContext: 'a: hi', askerName: 'a', userRequest: 'spoil me thor', utilityModel: 'm/m' });
        const prompt = callOpenRouterAPI.mock.calls[0][1][0].content;
        expect(prompt).toContain('a playful ask for real information');
    });

    test('speak.js swaps the panel on a factual read, and only then', () => {
        const speak = read('src/commands/tools/speak.js');
        expect(speak).toContain('FACTUAL_MODES.has(roomRead?.mode)');
        expect(speak).toContain('factualPanel(wants.writers, pipeline.factualWriter)');
    });

    test('the persona extends the no-manufactured-facts law to real media', () => {
        const speak = read('src/commands/tools/speak.js');
        expect(speak).toContain('real films, shows, games and events');
        expect(speak).toContain('the beats you state must be the real ones');
    });
});

// The other August 2026 cluster: repetition. The "typo apology" bit was
// referenced three times inside ten minutes, every repeat downvoted, and two
// media replies were the media's name plus a stock jab. The judge is where
// pleas become bars, so both faults are losing conditions now.
describe('the judge holds repetition and captions against a draft', () => {
    const base = { conversationContext: 'a: hi\nYou (Cooler Moksi): hello', userPrompt: 'a: hi', utilityModel: 'x/y' };

    test('a reused callback and a media caption are named losing conditions', async () => {
        callOpenRouterAPI.mockResolvedValue('1');
        await pickBestDraft({ drafts: ['a', 'b'], ...base });
        const prompt = callOpenRouterAPI.mock.calls[0][1][0].content;
        expect(prompt).toContain('It does not repeat the bot');
        expect(prompt).toContain('repetition, not memory');
        expect(prompt).toContain('a caption, not a reaction');
    });

    test('the repetition window sees five own replies, not two', () => {
        const log = ['one', 'two', 'three', 'four', 'five', 'six']
            .map(t => `You (Cooler Moksi): ${t}`).join('\n');
        expect(recentOwnReplies(log)).toEqual(['two', 'three', 'four', 'five', 'six']);
    });

    test('the judge reads candidates without their reaction-key plumbing', async () => {
        callOpenRouterAPI.mockResolvedValue('1');
        await pickBestDraft({ drafts: ['fine, keep the hat\n\nunamused', 'no'], ...base });
        const prompt = callOpenRouterAPI.mock.calls[0][1][0].content;
        expect(prompt).toContain('1: fine, keep the hat');
        expect(prompt).not.toContain('unamused');
    });

    test('stripReactionKey mirrors the extractor: bare last line only, text must remain', () => {
        expect(stripReactionKey('sure.\nsmile')).toBe('sure.');
        expect(stripReactionKey('sure.\n\nnone')).toBe('sure.');
        // A one-word reply that happens to be a key is a reply, not plumbing.
        expect(stripReactionKey('tired')).toBe('tired');
        // A key mid-prose is prose; only the trailing bare line is plumbing.
        expect(stripReactionKey('i am tired of this')).toBe('i am tired of this');
    });

    test('the persona carries the same two lessons', () => {
        const speak = read('src/commands/tools/speak.js');
        expect(speak).toContain('A callback lands once');
        expect(speak).toContain('a caption, not a reaction');
    });
});
