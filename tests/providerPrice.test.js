// tests/providerPrice.test.js
//
// A rail on the throughput sort, and why it exists.
//
// When `provider: { sort: 'throughput' }` went in, the comment beside it said
// the price spread between providers was noise at this bot's token counts.
// That was asserted, not measured, and the 2026-08-11 telemetry export
// measured it: the same model, at the same prompt sizes, was billed anywhere
// from 0.37x to 3.50x of its list price, 2.29x on average.
//
// The mechanism is not mysterious. Twenty-seven providers serve
// deepseek-v4-flash-0731 between $0.080 and $0.280 per million input tokens,
// the dearest of them (Wafer, 3.50x) is also the fastest (732ms against
// 1606ms), and a sort on throughput alone is exactly the instruction to pick
// it every time.
//
// The sort stays: sorting on price is what routed a reply to a host generating
// at 2 tokens/second and held it for 61 seconds. What is new is a ceiling.

jest.mock('../src/utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const mockListPrice = jest.fn();
jest.mock('../src/utils/modelCheck', () => ({ listPrice: (...a) => mockListPrice(...a) }));

const { routing, PRICE_CAP_MULTIPLE } = require('../src/utils/apiHelpers');

beforeEach(() => {
    jest.clearAllMocks();
    mockListPrice.mockReset();
});

describe('the rail', () => {
    test('is a multiple of the model\'s real list price', () => {
        mockListPrice.mockReturnValue({ prompt: 0.08, completion: 0.18 });

        expect(routing('deepseek/deepseek-v4-flash-0731')).toEqual({
            sort: 'throughput',
            max_price: { prompt: 0.16, completion: 0.36 },
        });
    });

    // The list price is read from the catalogue modelCheck already fetches at
    // boot, not from a table in the source. Three model ids in this repo have
    // gone dead without anything noticing; a hardcoded price table would rot
    // the same way and nothing would notice that either.
    test('is asked for, per model, rather than hardcoded', () => {
        mockListPrice.mockReturnValue({ prompt: 0.58, completion: 2.44 });
        routing('moonshotai/kimi-k2.6');
        expect(mockListPrice).toHaveBeenCalledWith('moonshotai/kimi-k2.6');
    });

    test('excludes the provider that caused this and keeps most of the rest', () => {
        mockListPrice.mockReturnValue({ prompt: 0.08, completion: 0.18 });
        const cap = routing('deepseek/deepseek-v4-flash-0731').max_price.prompt;

        // Real per-provider prices for that model, in $/M input, read from
        // OpenRouter's endpoints listing. Four of the twenty-seven sit above a
        // 2x rail; the other twenty-three stay eligible.
        const above = { wafer: 0.280, phala: 0.200, venice: 0.175, mancer: 0.175 };
        const below = { ioNet: 0.149, fireworks: 0.140, baseten: 0.130, gmi: 0.112, deepInfra: 0.080 };

        for (const [name, price] of Object.entries(above)) {
            expect([name, price > cap]).toEqual([name, true]);
        }
        for (const [name, price] of Object.entries(below)) {
            expect([name, price <= cap]).toEqual([name, true]);
        }
    });

    test('the multiple is generous enough to leave real choice', () => {
        expect(PRICE_CAP_MULTIPLE).toBeGreaterThanOrEqual(2);
    });
});

describe('it fails open, in every direction', () => {
    test('an unknown model gets no rail at all', () => {
        mockListPrice.mockReturnValue(null);
        expect(routing('some/unlisted-model')).toEqual({ sort: 'throughput' });
    });

    test('a catalogue that never loaded gets no rail', () => {
        mockListPrice.mockImplementation(() => { throw new Error('never fetched'); });
        expect(routing('deepseek/deepseek-v4-flash-0731')).toEqual({ sort: 'throughput' });
    });

    // The retry that drops the rail. A request OpenRouter refuses because no
    // provider is cheap enough must not become a reply that never arrives.
    test('the retry asks for no rail', () => {
        mockListPrice.mockReturnValue({ prompt: 0.08, completion: 0.18 });
        expect(routing('deepseek/deepseek-v4-flash-0731', true)).toEqual({ sort: 'throughput' });
    });

    test('the sort survives the rail; this is not cheapest-first', () => {
        mockListPrice.mockReturnValue({ prompt: 0.08, completion: 0.18 });
        expect(routing('x/y').sort).toBe('throughput');
        expect(routing('x/y', true).sort).toBe('throughput');
    });
});

describe('the source still says what it learned', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'src/utils/apiHelpers.js'), 'utf8');

    test('the claim that was wrong is not left standing in the comment', () => {
        expect(source).not.toMatch(/the price spread between providers is noise\.$/m);
    });

    test('and the retry happens before the model is given up on', () => {
        const noPriceCapAt = source.indexOf('noPriceCap: true');
        const fallbackAt = source.indexOf('Attempting OpenRouter fallback model');
        expect(noPriceCapAt).toBeGreaterThan(0);
        expect(noPriceCapAt).toBeLessThan(fallbackAt);
    });
});
