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
    pickBestDraft, recentOwnReplies, attitudeSentence,
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
