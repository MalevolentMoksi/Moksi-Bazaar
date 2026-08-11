// tests/apiHelpers.test.js
//
// Every model call in the bot funnels through callOpenRouterAPI, which makes
// its request shape and its timeout the two most load-bearing details in the
// entire speak path. Both had a silent failure mode, found via one traced
// 73-second reply:
//
//  - The abort timer was cleared as soon as the response HEADERS arrived, so
//    the "timeout" was a time-to-first-byte check. A provider that answered
//    200 in half a second and then generated at 2 tokens/second held a reply
//    hostage for 61 seconds, entirely inside the "timeout".
//  - Nothing disabled reasoning. The writers and utility models are hybrid
//    reasoners, and a provider that defaults reasoning ON spends the whole
//    max_tokens budget on thinking that lands in a separate field:
//    finish_reason "length", empty content, full price. Three of the six
//    calls in that trace died this way, including the judge, whose 6-token
//    budget cannot survive a single thought.

process.env.OPENROUTER_API_KEY = 'test-key';

jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/utils/telemetry', () => ({ logCall: jest.fn() }));

const telemetry = require('../src/utils/telemetry');
const { callOpenRouterAPI } = require('../src/utils/apiHelpers');

/** A fetch that answers headers instantly and then never finishes the body,
 *  which is exactly the provider behaviour that caused the 61-second call. */
function stallingFetch() {
    return jest.fn(async (url, opts) => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => new Promise((resolve, reject) => {
            opts.signal.addEventListener('abort', () =>
                reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
        }),
    }));
}

function respondingFetch(content) {
    return jest.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
            choices: [{ message: { content } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00001 },
        }),
    }));
}

afterEach(() => {
    delete global.fetch;
    jest.clearAllMocks();
});

describe('the timeout covers the body, not just the headers', () => {
    test('a provider that trickles the body is abandoned at the deadline', async () => {
        global.fetch = stallingFetch();

        const startedAt = Date.now();
        const result = await callOpenRouterAPI('vendor/model', [{ role: 'user', content: 'hi' }], { timeout: 120 });

        expect(result).toBeNull();
        // Generous bound: the point is "about the timeout", not "a minute".
        expect(Date.now() - startedAt).toBeLessThan(3_000);
        expect(telemetry.logCall).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'timeout' }));
    });

    test('a healthy call still returns its content', async () => {
        global.fetch = respondingFetch('hello there');
        const result = await callOpenRouterAPI('vendor/model', [{ role: 'user', content: 'hi' }]);
        expect(result).toBe('hello there');
    });
});

describe('the request shape', () => {
    const sentBody = fetchMock => JSON.parse(fetchMock.mock.calls[0][1].body);

    test('reasoning is off by default, so hybrid reasoners write instead of thinking', async () => {
        global.fetch = respondingFetch('x');
        await callOpenRouterAPI('vendor/model', [{ role: 'user', content: 'hi' }]);
        // effort "none" is the form OpenRouter documents as "disables
        // reasoning entirely"; exclude would still think, and still bill.
        expect(sentBody(global.fetch).reasoning).toEqual({ effort: 'none' });
    });

    test('providers are sorted by throughput, so a 2 tok/s host never gets picked over a 121 tok/s one', async () => {
        global.fetch = respondingFetch('x');
        await callOpenRouterAPI('vendor/model', [{ role: 'user', content: 'hi' }]);
        expect(sentBody(global.fetch).provider).toEqual({ sort: 'throughput' });
    });

    test('a caller that wants different routing or reasoning can still say so', async () => {
        global.fetch = respondingFetch('x');
        await callOpenRouterAPI('vendor/model', [{ role: 'user', content: 'hi' }], {
            reasoning: { effort: 'low' },
            provider: { sort: 'price' },
        });
        const body = sentBody(global.fetch);
        expect(body.reasoning).toEqual({ effort: 'low' });
        expect(body.provider).toEqual({ sort: 'price' });
    });
});

// A dead model looks exactly like a quiet afternoon: no error reaches anyone,
// replies simply stop being right. This funnel is the only place that sees
// every model call, so it is where the bot notices.
describe('the AI reports its own health', () => {
    const health = require('../src/utils/health');
    const failingFetch = () => jest.fn(async () => ({
        ok: false, status: 502, headers: { get: () => null }, text: async () => 'bad gateway',
    }));
    const call = () => callOpenRouterAPI('vendor/model', [{ role: 'user', content: 'hi' }]);

    beforeEach(async () => {
        // Zero the streak left by whatever ran before, then clear the registry.
        global.fetch = respondingFetch('x');
        await call();
        health.reset();
    });

    test('one failure is a hiccup and says nothing', async () => {
        global.fetch = failingFetch();
        await call();
        await call();
        expect(health.snapshot().state).toBe('ok');
    });

    test('three in a row is the model being down', async () => {
        global.fetch = failingFetch();
        await call();
        await call();
        await call();
        const snap = health.snapshot();
        expect(snap.state).toBe('degraded');
        expect(snap.worst.label).toBe('AI');
        expect(snap.worst.detail).toContain('3 calls failed');
    });

    test('one working call is enough to take it back', async () => {
        global.fetch = failingFetch();
        await call(); await call(); await call();
        global.fetch = respondingFetch('back');
        await call();
        expect(health.snapshot().state).toBe('ok');
    });

    // The fallback path recurses into the same function, so a rescued call
    // records a failure and then a success. It must net out healthy, or every
    // fallback in the pipeline would read as an outage.
    test('a call rescued by its fallback is not an outage', async () => {
        let attempt = 0;
        global.fetch = jest.fn(async () => {
            attempt += 1;
            return attempt === 1
                ? { ok: false, status: 502, headers: { get: () => null }, text: async () => 'bad gateway' }
                : {
                    ok: true, status: 200, headers: { get: () => null },
                    json: async () => ({ choices: [{ message: { content: 'rescued' } }], usage: {} }),
                };
        });

        const result = await callOpenRouterAPI('vendor/model', [{ role: 'user', content: 'hi' }], {
            fallbackModel: 'vendor/spare',
        });
        expect(result).toBe('rescued');
        expect(health.snapshot().state).toBe('ok');
    });
});
