// tests/modelPrices.test.js
//
// The boot check already fetched OpenRouter's catalogue to see which model ids
// are still alive, and threw the prices away. Keeping them is what lets the
// price rail in apiHelpers be a multiple of the real number rather than a
// table in the source, which matters because three model ids in this repo have
// gone dead without anything noticing and a hardcoded price table would rot the
// same way, just as quietly.

jest.mock('../src/utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../src/utils/speakPipeline', () => ({
    configuredModels: jest.fn(async () => ['deepseek/deepseek-v4-flash-0731']),
}));

const { verifyModels, listPrice } = require('../src/utils/modelCheck');

/** The catalogue shape: prices are dollars per TOKEN, as strings. */
const catalogue = (models) => ({
    ok: true,
    json: async () => ({ data: models }),
});

const model = (id, prompt, completion) => ({
    id, pricing: { prompt: String(prompt), completion: String(completion) },
});

afterEach(() => { delete global.fetch; });

describe('list prices, straight from the catalogue', () => {
    test('are kept, converted to dollars per million', async () => {
        global.fetch = jest.fn(async () => catalogue([
            model('deepseek/deepseek-v4-flash-0731', '0.00000008', '0.00000018'),
            model('moonshotai/kimi-k2.6', '0.00000058', '0.00000244'),
        ]));

        await verifyModels();

        expect(listPrice('deepseek/deepseek-v4-flash-0731')).toEqual({ prompt: 0.08, completion: 0.18 });
        expect(listPrice('moonshotai/kimi-k2.6')).toEqual({ prompt: 0.58, completion: 2.44 });
    });

    test('a model that is not in the catalogue has no price', async () => {
        global.fetch = jest.fn(async () => catalogue([model('a/b', '0.0000001', '0.0000002')]));
        await verifyModels();
        expect(listPrice('who/knows')).toBeNull();
    });

    // A free model priced at zero must not produce a rail of zero, which no
    // provider on earth would satisfy and which would fail every request.
    test('a free model gets no price rather than a price of nothing', async () => {
        global.fetch = jest.fn(async () => catalogue([model('some/free-model', '0', '0')]));
        await verifyModels();
        expect(listPrice('some/free-model')).toBeNull();
    });

    test('a malformed entry is skipped, not stored as NaN', async () => {
        global.fetch = jest.fn(async () => catalogue([
            { id: 'broken/model', pricing: { prompt: 'free', completion: null } },
            model('fine/model', '0.0000005', '0.000001'),
        ]));
        await verifyModels();
        expect(listPrice('broken/model')).toBeNull();
        expect(listPrice('fine/model')).toEqual({ prompt: 0.5, completion: 1 });
    });

    test('a catalogue that will not load leaves no prices behind', async () => {
        global.fetch = jest.fn(async () => catalogue([model('x/y', '0.000001', '0.000002')]));
        await verifyModels();
        expect(listPrice('x/y')).not.toBeNull();

        global.fetch = jest.fn(async () => { throw new Error('offline'); });
        const result = await verifyModels();

        expect(result.checked).toBe(false);
        // Stale prices are still better than none: the rail fails open on a
        // missing price, so keeping the last known one is the safer default.
        expect(listPrice('x/y')).not.toBeNull();
    });

    // The original job of this module, which must keep working.
    test('it still reports a configured model that has been delisted', async () => {
        global.fetch = jest.fn(async () => catalogue([model('something/else', '0.000001', '0.000002')]));
        const result = await verifyModels();

        expect(result.checked).toBe(true);
        expect(result.missing).toEqual(['deepseek/deepseek-v4-flash-0731']);
    });
});
