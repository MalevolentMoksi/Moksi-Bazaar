// tests/modelCheck.test.js
//
// Three model ids in this bot have been found delisted from OpenRouter, none
// of them by anything in the bot noticing. Every path that calls a model
// degrades quietly on purpose: vision falls back, the scout fails open, the
// distiller returns 'failed' and moves on. That is correct in the moment and
// catastrophic over months, because a dead model becomes indistinguishable
// from a feature that never fires. Profile distillation and the casino
// heckler each had a dead primary AND a dead fallback, so both had simply
// stopped happening.
//
// So the rules here are about being unmissable and being harmless: it must
// name the dead ids loudly, it must never claim health it could not verify,
// and it must never be able to stop the bot booting.

jest.mock('../src/utils/db', () => ({
    getSpeakConfigValue: jest.fn(async () => null),
    pool: { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) },
}));

const fs = require('fs');
const path = require('path');
const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const { verifyModels, lastModelCheck } = require('../src/utils/modelCheck');
const { configuredModels } = require('../src/utils/speakPipeline');
const { SPEAK_MODELS } = require('../src/utils/constants');

const catalogue = ids => ({ ok: true, json: async () => ({ data: ids.map(id => ({ id })) }) });

beforeEach(() => jest.clearAllMocks());
afterEach(() => { delete global.fetch; });

describe('what counts as configured', () => {
    test('the list covers writers, the panel, the utility model and the fixed ones', async () => {
        const ids = await configuredModels();
        for (const fixed of Object.values(SPEAK_MODELS)) expect(ids).toContain(fixed);
        // The interjection panel is wider than the reply lineup, and both are in.
        expect(ids).toContain('moonshotai/kimi-k2.6');
        expect(ids).toContain('z-ai/glm-4.7');
        expect(ids).toContain('deepseek/deepseek-v4-flash-0731');
    });

    test('it deduplicates: the same id twice is one thing to check', async () => {
        const ids = await configuredModels();
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('the check', () => {
    test('a clean catalogue reports every model live', async () => {
        const ids = await configuredModels();
        global.fetch = jest.fn(async () => catalogue(ids));

        const result = await verifyModels();
        expect(result).toMatchObject({ checked: true, missing: [], total: ids.length });
    });

    test('a delisted model is named, not merely counted', async () => {
        const ids = await configuredModels();
        global.fetch = jest.fn(async () => catalogue(ids.filter(id => id !== SPEAK_MODELS.VISION_FALLBACK)));

        const result = await verifyModels();
        expect(result.checked).toBe(true);
        expect(result.missing).toEqual([SPEAK_MODELS.VISION_FALLBACK]);
    });

    test('an unreachable catalogue is reported as unknown, never as healthy', async () => {
        global.fetch = jest.fn(async () => { throw new Error('getaddrinfo ENOTFOUND'); });

        const result = await verifyModels();
        // The distinction that matters: "no missing models" here would be a
        // lie, and the lie would outlive the outage in the settings panel.
        expect(result.checked).toBe(false);
        expect(result.error).toMatch(/ENOTFOUND/);
        expect(lastModelCheck().checked).toBe(false);
    });

    test('an empty catalogue is a failure, not a claim that nothing exists', async () => {
        global.fetch = jest.fn(async () => catalogue([]));
        expect((await verifyModels()).checked).toBe(false);
    });

    test('an HTTP error is a failure too', async () => {
        global.fetch = jest.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
        expect((await verifyModels()).checked).toBe(false);
    });

    test('it never throws, whatever happens: booting matters more than checking', async () => {
        global.fetch = jest.fn(async () => { throw new Error('boom'); });
        await expect(verifyModels()).resolves.toBeDefined();
    });
});

describe('it is wired where it can be seen', () => {
    test('boot runs it without waiting on it', () => {
        const bot = read('src/bot.js');
        expect(bot).toContain("require('./utils/modelCheck').verifyModels()");
        // Not awaited: the gateway login must not queue behind an HTTP call.
        expect(bot).not.toMatch(/await require\('\.\/utils\/modelCheck'\)/);
    });

    test('the settings panel shows the verdict, so a dead model is seen not just logged', () => {
        const settings = read('src/commands/tools/speak_settings.js');
        expect(settings).toContain('lastModelCheck');
        expect(settings).toContain('modelHealthField()');
        expect(settings).toMatch(/failing silently right now/);
    });

    test('no surface carries its own model id any more', () => {
        // The five that did, each one having rotted or been one delisting away.
        for (const file of [
            'src/utils/casinoHeckle.js', 'src/utils/speakProfile.js',
            'src/commands/tools/checkrelationship.js', 'src/commands/tools/relationoverview.js',
        ]) {
            expect(read(file)).toContain('getUtilityModel');
        }
        expect(read('src/utils/db.js')).toContain('getUtilityModel');
    });

    test('the two ids known to be dead are gone from the source entirely', () => {
        for (const file of [
            'src/utils/db.js', 'src/utils/casinoHeckle.js', 'src/utils/speakProfile.js',
            'src/commands/tools/checkrelationship.js', 'src/commands/tools/relationoverview.js',
            'src/utils/interjectionBouncer.js',
        ]) {
            expect(read(file)).not.toContain('xiaomi/mimo-v2-flash');
            expect(read(file)).not.toContain('meta-llama/llama-3.3-8b-instruct');
        }
    });

    test('the sentiment cascade stopped paying for two doomed round trips first', () => {
        const db = read('src/utils/db.js');
        // One live attempt, then one safety net in a different family.
        expect(db).toContain('SPEAK_MODELS.SENTIMENT_SAFETY_NET');
        expect(db).not.toContain('Groq 8B fallback');
    });
});
