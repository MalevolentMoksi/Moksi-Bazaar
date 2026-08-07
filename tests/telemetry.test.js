// tests/telemetry.test.js
//
// The telemetry system's one non-negotiable: it observes the pipeline, it
// must never be able to hurt it. Every write is fire-and-forget, a missing
// trace means silence rather than an error, and the pruner may never eat the
// owner's verdicts. The context travels by AsyncLocalStorage, so these also
// pin that a deeply nested call really does land on the right trace.

const mockPool = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) };
jest.mock('../src/utils/db', () => ({
    pool: mockPool,
    getSpeakConfigValue: jest.fn(async () => ({ enabled: true })),
}));

const fs = require('fs');
const path = require('path');
const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const telemetry = require('../src/utils/telemetry');
const { getSpeakConfigValue } = require('../src/utils/db');

beforeEach(() => {
    jest.clearAllMocks();
    mockPool.query.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    getSpeakConfigValue.mockImplementation(async () => ({ enabled: true }));
});

const queriesLike = fragment =>
    mockPool.query.mock.calls.filter(([sql]) => String(sql).includes(fragment));

describe('the trace context', () => {
    test('a call outside any trace writes nothing, silently', async () => {
        await telemetry.logCall({ kind: 'vision', outcome: 'ok' });
        expect(mockPool.query).not.toHaveBeenCalled();
    });

    test('a call inside a trace writes the trace row, the input, and the call', async () => {
        await telemetry.runWithTrace({ kind: 'reply', userId: 'u1', channelId: 'c1' }, async (trace) => {
            await telemetry.logCall({ kind: 'draft', model: 'x/y', input: 'hello', output: 'hi', outcome: 'ok' });
            expect(queriesLike('INSERT INTO telemetry_traces')).toHaveLength(1);
            expect(queriesLike('INSERT INTO telemetry_inputs')).toHaveLength(1);
            const callRows = queriesLike('INSERT INTO telemetry_calls');
            expect(callRows).toHaveLength(1);
            expect(callRows[0][1][0]).toBe(trace.id); // trace_id param
        });
    });

    test('a deeply nested, detached async call still lands on the right trace', async () => {
        let nestedWrite;
        await telemetry.runWithTrace({ kind: 'reply' }, async (trace) => {
            // Simulates vision-inside-media-inside-context-builder: not
            // awaited by the wrapper, started three promises deep.
            nestedWrite = (async () => {
                await new Promise(r => setImmediate(r));
                return telemetry.logCall({ kind: 'vision', outcome: 'ok' });
            })();
            await nestedWrite;
            const callRows = queriesLike('INSERT INTO telemetry_calls');
            expect(callRows[0][1][0]).toBe(trace.id);
        });
    });

    test('enterTrace covers the rest of the flow without a closure', async () => {
        const trace = telemetry.enterTrace({ kind: 'reply', userId: 'u9' });
        await telemetry.logCall({ kind: 'chat', outcome: 'ok' });
        const callRows = queriesLike('INSERT INTO telemetry_calls');
        expect(callRows[0][1][0]).toBe(trace.id);
        await telemetry.finishTrace({ replyText: 'done', outcome: 'ok' });
        expect(queriesLike('UPDATE telemetry_traces')).toHaveLength(1);
    });

    test('disabled means no rows, and a broken database write breaks nothing', async () => {
        getSpeakConfigValue.mockImplementation(async () => ({ enabled: false }));
        await telemetry.runWithTrace({ kind: 'reply' }, async () => {
            await telemetry.logCall({ kind: 'draft', outcome: 'ok' });
        });
        expect(mockPool.query).not.toHaveBeenCalled();

        getSpeakConfigValue.mockImplementation(async () => ({ enabled: true }));
        mockPool.query.mockImplementation(async () => { throw new Error('db down'); });
        await expect(
            telemetry.runWithTrace({ kind: 'reply' }, () =>
                telemetry.logCall({ kind: 'draft', outcome: 'ok' }))
        ).resolves.toBeUndefined();
    });
});

describe('input serialisation', () => {
    test('a data URI is replaced with a placeholder, not stored', () => {
        const text = telemetry.serializeInput([{
            role: 'user',
            content: [
                { type: 'text', text: 'describe this' },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${'x'.repeat(5000)}` } },
            ],
        }]);
        expect(text).toContain('describe this');
        expect(text).toContain('[image: inline data');
        expect(text).not.toContain('xxxxx');
    });

    test('an ordinary image URL is kept: the analyst can open it', () => {
        const text = telemetry.serializeInput([{
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'https://cdn.example/pic.png' } }],
        }]);
        expect(text).toContain('[image: https://cdn.example/pic.png]');
    });

    test('plain message arrays read as role-labelled text', () => {
        const text = telemetry.serializeInput([
            { role: 'system', content: 'be dry' },
            { role: 'user', content: 'hello' },
        ]);
        expect(text).toBe('[system]\nbe dry\n\n[user]\nhello');
    });
});

describe('the CSV is actually well-formed', () => {
    test('quotes, commas and newlines survive the round trip', () => {
        const csv = telemetry.toCsv(['a', 'b'], [{ a: 'said "no", twice', b: 'line1\nline2' }]);
        expect(csv).toBe('"a","b"\r\n"said ""no"", twice","line1\nline2"');
    });

    test('null is an empty cell, and objects become JSON', () => {
        const csv = telemetry.toCsv(['x', 'y'], [{ x: null, y: { mode: 'banter' } }]);
        expect(csv.split('\r\n')[1]).toBe(',"{""mode"":""banter""}"');
    });
});

describe('pruning never eats a verdict', () => {
    test('the delete filters unrated rows only and keeps the newest window', async () => {
        await telemetry.pruneTelemetry();
        const del = queriesLike('DELETE FROM telemetry_traces');
        expect(del).toHaveLength(1);
        const [sql, params] = del[0];
        expect(sql).toContain('rating IS NULL');
        expect(sql).toContain('rating_comment IS NULL');
        expect(sql).toContain('judge_wrong_pick IS NOT TRUE');
        expect(params).toEqual([telemetry.TELEMETRY_MAX_TRACES]);
    });

    test('rateTrace refuses garbage ratings', async () => {
        await expect(telemetry.rateTrace('id', { rating: 5 })).rejects.toThrow('rating');
        await expect(telemetry.rateTrace('id', {})).rejects.toThrow('nothing to rate');
    });
});

// Source-level guards for the wiring that needs a live process to exercise.
describe('the hooks are actually installed', () => {
    test('every OpenRouter call reports real usage and cost', () => {
        expect(read('src/utils/apiHelpers.js')).toContain('usage: { include: true }');
        expect(read('src/utils/db.js')).toContain('usage: { include: true }');
    });

    test('speak.js opens the trace and closes it on every path', () => {
        const speak = read('src/commands/tools/speak.js');
        expect(speak).toContain('telemetry.enterTrace');
        // ok, no_reply, and error all close the trace
        expect((speak.match(/telemetry\.finishTrace\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    });

    test('the named kinds cover the whole pipeline', () => {
        const sources = ['src/commands/tools/speak.js', 'src/utils/speakPipeline.js', 'src/utils/db.js', 'src/utils/interjectionBouncer.js', 'src/utils/media/videoFrame.js']
            .map(read).join('\n');
        for (const kind of ['draft', 'chat', 'judge', 'room_read', 'sentiment', 'vision', 'vision_fallback', 'bouncer', 'video_frame', 'gif_storyboard', 'media_skip']) {
            expect(sources).toContain(`'${kind}'`);
        }
    });

    test('the janitor prunes and the dashboard has the Brain page', () => {
        expect(read('src/utils/janitor.js')).toContain('pruneTelemetry');
        expect(read('src/web/html.js')).toContain("href: '/brain'");
        expect(read('src/web/server.js')).toContain("'/brain/export/:name'");
        expect(read('src/web/api.js')).toContain('telemetry/verdict');
    });

    test('every row carries the version that produced it', () => {
        expect(read('src/utils/telemetry.js')).toContain('RAILWAY_GIT_COMMIT_SHA');
    });
});
