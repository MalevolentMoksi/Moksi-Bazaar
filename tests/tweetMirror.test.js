// tests/tweetMirror.test.js
//
// This is the only part of the bot that spends money per request rather than
// per conversation, and it runs unattended on a timer. That inverts what the
// tests are for: the interesting failures here are not "it did not post", they
// are "it posted twice" and "it quietly cost twenty dollars".
//
// So the things pinned below are the ones that cost something when they break:
// the query's parentheses, the spend cap, the claim that survives a deploy
// overlap, and the lookback clamp that stops an outage becoming a flood.

const mockStore = new Map();
const mockClaimed = new Set();

jest.mock('../src/utils/db', () => ({
    getSpeakConfigValue: jest.fn(async (key, fallback = null) => (mockStore.has(key) ? mockStore.get(key) : fallback)),
    setSpeakConfigValue: jest.fn(async (key, value) => { mockStore.set(key, value); }),
    // The real one is an INSERT ... ON CONFLICT DO NOTHING RETURNING, which is
    // exactly a set insert: true the first time, false forever after.
    claimTweet: jest.fn(async id => (mockClaimed.has(id) ? false : (mockClaimed.add(id), true))),
    recordMirrorMessage: jest.fn(async () => {}),
    releaseTweet: jest.fn(async id => { mockClaimed.delete(id); }),
    pruneMirroredTweets: jest.fn(async () => 0),
}));
jest.mock('../src/utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const mirror = require('../src/utils/tweetMirror');
const {
    buildQuery, normalizeTweet, renderEmbed, runOnce, readSpend, recordSpend, monthKey,
    CHANNEL_KEY, ENABLED_KEY, ACCOUNTS_KEY, SINCE_KEY, SPEND_KEY, BUDGET_KEY, STYLE_KEY,
    MAX_POSTS_PER_TICK, MAX_LOOKBACK_MS, COST_PER_UNIT_USD, SEARCH_PAGE_SIZE,
} = mirror;

let sent;
let client;

beforeEach(() => {
    jest.clearAllMocks();
    mockStore.clear();
    mockClaimed.clear();
    sent = [];
    process.env.TWITTERAPI_KEY = 'test-key';
    mockStore.set(CHANNEL_KEY, 'chan-1');
    client = {
        channels: {
            fetch: jest.fn(async () => ({
                isTextBased: () => true,
                // Returns a message the way Discord does, since the mirror
                // records its id and may later edit it.
                send: jest.fn(async payload => {
                    sent.push(payload);
                    return { id: `msg-${sent.length}`, edit: jest.fn(async () => {}) };
                }),
                messages: { fetch: jest.fn(async () => ({ embeds: [{}] })) },
            })),
        },
    };
    global.fetch = jest.fn();
});

afterEach(() => {
    delete process.env.TWITTERAPI_KEY;
    delete global.fetch;
});

/** One tweet in the shape twitterapi.io returns. */
function apiTweet(id, { at = '2026-08-07T12:00:00.000Z', handle = 'HYPEX', text = 'leak', media = null } = {}) {
    return {
        id: String(id),
        text,
        createdAt: at,
        author: { userName: handle, name: handle, profilePicture: 'https://x/a.jpg' },
        likeCount: 5,
        retweetCount: 2,
        ...(media ? { extendedEntities: { media } } : {}),
    };
}

function respond({ tweets = [], hasNext = false, status = 200, body = null } = {}) {
    global.fetch.mockResolvedValueOnce({
        ok: status >= 200 && status < 300,
        status,
        text: async () => body ?? JSON.stringify({ tweets, has_next_page: hasNext, next_cursor: '' }),
    });
}

const lastQuery = () => decodeURIComponent(new URL(global.fetch.mock.calls[0][0]).searchParams.get('query'));

// ── The query ───────────────────────────────────────────────────────────────

describe('the search query', () => {
    test('groups the accounts so since_time applies to all of them', () => {
        const q = buildQuery(['HYPEX', 'ShiinaBR', 'FNFestival'], 1000);
        // Without the parentheses X reads this as "a OR b OR (c AND since)",
        // so two of the three accounts would ignore the time filter and return
        // their whole recent history on every poll. Every tweet is billed, so
        // that mistake is charged to us every ten minutes, forever.
        expect(q).toContain('(from:HYPEX OR from:ShiinaBR OR from:FNFestival)');
        expect(q.indexOf(')')).toBeLessThan(q.indexOf('since_time:'));
    });

    test('strips a leading @ and excludes replies', () => {
        const q = buildQuery(['@HYPEX'], 5);
        expect(q).toContain('from:HYPEX');
        expect(q).not.toContain('@HYPEX');
        expect(q).toContain('-filter:replies');
    });

    test('since_time is whole seconds, never a float', () => {
        expect(buildQuery(['a'], 1754000000.789)).toContain('since_time:1754000000');
    });
});

// ── Parsing what comes back ─────────────────────────────────────────────────

describe('reading a tweet off a scraped API', () => {
    test('builds the fxtwitter link from the handle and id', () => {
        const t = normalizeTweet(apiTweet('123', { handle: 'ShiinaBR' }));
        expect(t.url).toBe('https://fxtwitter.com/ShiinaBR/status/123');
    });

    test("accepts Twitter's own date format, not just ISO", () => {
        const t = normalizeTweet(apiTweet('1', { at: 'Tue Dec 10 07:00:30 +0000 2024' }));
        expect(new Date(t.atMs).getUTCFullYear()).toBe(2024);
        expect(new Date(t.atMs).getUTCMonth()).toBe(11);
    });

    test('an unreadable date does not lose the post', () => {
        const t = normalizeTweet(apiTweet('1', { at: 'not a date' }));
        expect(t).not.toBeNull();
        expect(Number.isFinite(t.atMs)).toBe(true);
    });

    test('tolerates the snake_case shape as well as the camelCase one', () => {
        const t = normalizeTweet({
            id_str: '9', text: 'x', created_at: '2026-01-01T00:00:00Z',
            user: { screen_name: 'HYPEX' },
        });
        expect(t.id).toBe('9');
        expect(t.handle).toBe('HYPEX');
    });

    test('drops anything with no id or no author, rather than posting a broken link', () => {
        expect(normalizeTweet({ text: 'no id', author: { userName: 'a' } })).toBeNull();
        expect(normalizeTweet({ id: '1', text: 'no author' })).toBeNull();
        expect(normalizeTweet(null)).toBeNull();
        expect(normalizeTweet('nonsense')).toBeNull();
    });

    test('finds a photo, and notices a video it cannot show', () => {
        const withPhoto = normalizeTweet(apiTweet('1', {
            media: [{ type: 'photo', media_url_https: 'https://x/p.jpg' }],
        }));
        expect(withPhoto.photo).toBe('https://x/p.jpg');
        expect(withPhoto.hasVideo).toBe(false);

        const withVideo = normalizeTweet(apiTweet('2', { media: [{ type: 'video' }] }));
        expect(withVideo.hasVideo).toBe(true);
        expect(withVideo.photo).toBeNull();
    });

    test('the built-in embed stays inside Discord field limits', () => {
        const t = normalizeTweet(apiTweet('1', { text: 'x'.repeat(9000), handle: 'H'.repeat(40) }));
        const json = renderEmbed(t).toJSON();
        expect(json.description.length).toBeLessThanOrEqual(4096);
        expect(json.author.name.length).toBeLessThanOrEqual(256);
    });
});

// ── Spending ────────────────────────────────────────────────────────────────

describe('spend accounting', () => {
    test('an empty response still bills one unit, because the floor is per request', async () => {
        const spend = await recordSpend(0);
        expect(spend.usd).toBeCloseTo(COST_PER_UNIT_USD, 8);
        expect(spend.calls).toBe(1);
    });

    test('a response with tweets bills per tweet, not per tweet plus a floor', async () => {
        const spend = await recordSpend(4);
        expect(spend.usd).toBeCloseTo(4 * COST_PER_UNIT_USD, 8);
    });

    test('a new month starts from zero without anyone resetting it', async () => {
        mockStore.set(SPEND_KEY, { month: '2001-01', usd: 19.99, calls: 500, tweets: 40 });
        const spend = await readSpend();
        expect(spend.usd).toBe(0);
        expect(spend.month).toBe(monthKey());
    });

    test('the cap stops the request being made at all', async () => {
        mockStore.set(BUDGET_KEY, 1.0);
        mockStore.set(SPEND_KEY, { month: monthKey(), usd: 1.0, calls: 9999, tweets: 0 });

        const result = await runOnce(client);

        expect(result.skipped).toBe('budget reached');
        // The point of a cap is that it costs nothing to enforce.
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('spend is recorded even when nothing gets posted', async () => {
        respond({ tweets: [] });
        await runOnce(client);
        expect((await readSpend()).calls).toBe(1);
    });

    // The vendor's usage page is sampled and says so; its balance is exact.
    // The only way to know this panel's arithmetic still matches that balance
    // a year from now is to keep a counter that outlives the month.
    describe('the meter that outlives the month', () => {
        test('credits accumulate at fifteen to the billing unit', async () => {
            await recordSpend(0);
            await recordSpend(4);
            const spend = await readSpend();
            expect(spend.lifetime.credits).toBe(15 + 4 * 15);
        });

        test('a new month zeroes the month and not the meter', async () => {
            mockStore.set(SPEND_KEY, {
                month: '2001-01', usd: 19.99, calls: 500, tweets: 40,
                lifetime: { credits: 123_456, sinceMs: 1 },
            });
            const spend = await readSpend();
            expect(spend.usd).toBe(0);
            expect(spend.lifetime.credits).toBe(123_456);
        });

        test('what was paid for and what was used are counted separately', async () => {
            respond({ tweets: [apiTweet('1'), apiTweet('2')] });
            await runOnce(client);
            const spend = await readSpend();
            expect(spend.tweets).toBe(2);
            expect(spend.posted).toBe(2);
        });
    });
});

describe('reconciling against the vendor ledger', () => {
    const balance = credits => global.fetch.mockResolvedValueOnce({
        ok: true, status: 200, json: async () => ({ recharge_credits: credits }),
    });

    test('the first read only sets the reference point', async () => {
        balance(1_000_000);
        const out = await mirror.accountBalance('k', { now: 1000 });
        expect(out.credits).toBe(1_000_000);
        expect(out.billed).toBe(0);
        expect(out.counted).toBe(0);
    });

    test('afterwards it compares their subtraction with ours', async () => {
        balance(1_000_000);
        await mirror.accountBalance('k', { now: 1000 });
        await recordSpend(0); // 15 credits by our count
        balance(999_985);
        const out = await mirror.accountBalance('k', { now: 10 * 60_000, force: true });

        expect(out.billed).toBe(15);
        expect(out.counted).toBe(15);
    });

    test('a top-up moves the reference rather than reading as a refund', async () => {
        balance(9_000);
        await mirror.accountBalance('k', { now: 1000 });
        await recordSpend(0);
        balance(1_009_000);
        const out = await mirror.accountBalance('k', { now: 2000, force: true });

        expect(out.credits).toBe(1_009_000);
        expect(out.billed).toBe(0);
        expect(out.counted).toBe(0);
    });

    test('an unreachable vendor keeps the last known number, not a blank', async () => {
        balance(500_000);
        await mirror.accountBalance('k', { now: 1000 });
        global.fetch.mockRejectedValueOnce(new Error('down'));
        const out = await mirror.accountBalance('k', { now: 60 * 60_000, force: true });
        expect(out.credits).toBe(500_000);
    });

    test('no key means no request', async () => {
        expect(await mirror.accountBalance(null)).toBeNull();
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('a cached reading costs nothing', async () => {
        balance(1_000);
        await mirror.accountBalance('k', { now: 1000 });
        await mirror.accountBalance('k', { now: 2000 });
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });
});

// ── Not spending ────────────────────────────────────────────────────────────

describe('conditions that must never fire a request', () => {
    test.each([
        ['no API key', () => { delete process.env.TWITTERAPI_KEY; }, 'no TWITTERAPI_KEY set'],
        ['no channel', () => mockStore.delete(CHANNEL_KEY), 'no channel set'],
        ['switched off', () => mockStore.set(ENABLED_KEY, false), 'disabled'],
        ['no accounts', () => mockStore.set(ACCOUNTS_KEY, []), 'no accounts set'],
    ])('%s', async (_label, setup, reason) => {
        setup();
        const result = await runOnce(client);
        expect(result.skipped).toBe(reason);
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

// ── Posting ─────────────────────────────────────────────────────────────────

describe('what reaches the channel', () => {
    test('finds the tweets whether or not they arrive wrapped in an envelope', async () => {
        // Advanced Search returns them at the root; /twitter/user/info on the
        // same host wraps its payload in {status, data, msg}. Both are real
        // shapes observed from this vendor, so both are read.
        respond({ body: JSON.stringify({ tweets: [apiTweet('root')], has_next_page: false }) });
        await runOnce(client);
        expect(sent.map(s => s.content)).toEqual(['https://fxtwitter.com/HYPEX/status/root']);

        sent = [];
        respond({ body: JSON.stringify({ status: 'success', data: { tweets: [apiTweet('wrapped')] }, msg: 'success' }) });
        await runOnce(client);
        expect(sent.map(s => s.content)).toEqual(['https://fxtwitter.com/HYPEX/status/wrapped']);
    });

    test('posts the fxtwitter link by default, so video plays', async () => {
        respond({ tweets: [apiTweet('1', { handle: 'HYPEX' })] });
        const result = await runOnce(client);

        expect(result.posted).toBe(1);
        expect(sent).toEqual([{ content: 'https://fxtwitter.com/HYPEX/status/1' }]);
    });

    test('builds its own embed when asked to', async () => {
        mockStore.set(STYLE_KEY, 'embed');
        respond({ tweets: [apiTweet('1')] });
        await runOnce(client);

        expect(sent[0].embeds).toHaveLength(1);
        expect(sent[0].content).toBeUndefined();
    });

    test('delivers oldest first, so the channel reads in order', async () => {
        respond({
            tweets: [
                apiTweet('new', { at: '2026-08-07T12:00:00Z' }),
                apiTweet('old', { at: '2026-08-07T10:00:00Z' }),
                apiTweet('mid', { at: '2026-08-07T11:00:00Z' }),
            ],
        });
        await runOnce(client);
        expect(sent.map(s => s.content)).toEqual([
            'https://fxtwitter.com/HYPEX/status/old',
            'https://fxtwitter.com/HYPEX/status/mid',
            'https://fxtwitter.com/HYPEX/status/new',
        ]);
    });

    test('a burst is capped, and what was dropped is reported rather than swallowed', async () => {
        const many = Array.from({ length: 15 }, (_, i) =>
            apiTweet(`t${i}`, { at: new Date(Date.UTC(2026, 7, 7, 10, i)).toISOString() }));
        respond({ tweets: many });

        const result = await runOnce(client);

        expect(result.posted).toBe(MAX_POSTS_PER_TICK);
        expect(result.dropped).toBe(5);
        // The newest survive the cull, and the oldest five are the ones lost.
        expect(sent[0].content).toContain('t5');
        expect(sent[sent.length - 1].content).toContain('t14');
        expect(require('../src/utils/logger').warn).toHaveBeenCalled();
    });
});

// ── Telling "nothing was missed" from "something was" ───────────────────────
//
// This vendor sets has_next_page on nearly every response, including ones
// carrying a single tweet. Believing it produced a warning on the first real
// leak the mirror ever mirrored: "More posts than one poll delivers; older
// ones skipped", with dropped: 0 in the very same line. A warning that fires
// when nothing is wrong is worse than no warning, because it trains you to
// scroll past the one that matters.

describe('the pagination warning', () => {
    const warn = () => require('../src/utils/logger').warn.mock.calls
        .filter(c => /will not be delivered/.test(c[0]));

    test('stays quiet when a short page claims there is more', async () => {
        // Exactly the production case: one tweet, has_next_page true.
        respond({ tweets: [apiTweet('only')], hasNext: true });

        const result = await runOnce(client);

        expect(result.posted).toBe(1);
        expect(warn()).toHaveLength(0);
    });

    test('stays quiet on a comfortable page that claims there is more', async () => {
        const some = Array.from({ length: 7 }, (_, i) => apiTweet(`t${i}`));
        respond({ tweets: some, hasNext: true });

        await runOnce(client);

        expect(warn()).toHaveLength(0);
    });

    test('speaks up when a FULL page claims there is more', async () => {
        // A full page really can have older posts behind it, and the cursor
        // is about to move past them.
        const full = Array.from({ length: SEARCH_PAGE_SIZE }, (_, i) =>
            apiTweet(`t${i}`, { at: new Date(Date.UTC(2026, 7, 7, 10, i)).toISOString() }));
        respond({ tweets: full, hasNext: true });

        await runOnce(client);

        expect(warn()).toHaveLength(1);
        expect(warn()[0][1]).toMatchObject({ morePages: true, returned: SEARCH_PAGE_SIZE });
    });

    test('speaks up when posts were dropped, page size regardless', async () => {
        const many = Array.from({ length: 12 }, (_, i) =>
            apiTweet(`t${i}`, { at: new Date(Date.UTC(2026, 7, 7, 10, i)).toISOString() }));
        respond({ tweets: many, hasNext: false });

        await runOnce(client);

        expect(warn()).toHaveLength(1);
        expect(warn()[0][1]).toMatchObject({ dropped: 2, morePages: false });
    });

    test('the test panel stops putting a "+" on every check it runs', async () => {
        // The same lie in the place the owner actually reads: "found 7+" when
        // seven was the whole truth.
        respond({ tweets: Array.from({ length: 7 }, (_, i) => apiTweet(`t${i}`)), hasNext: true });
        expect((await mirror.testFetch()).more).toBe(false);

        respond({ tweets: Array.from({ length: SEARCH_PAGE_SIZE }, (_, i) => apiTweet(`f${i}`)), hasNext: true });
        expect((await mirror.testFetch()).more).toBe(true);
    });
});

// ── The thing that breaks on every deploy ───────────────────────────────────

describe('two containers running at once', () => {
    test('the second one to reach a tweet does not post it', async () => {
        respond({ tweets: [apiTweet('1'), apiTweet('2')] });
        await runOnce(client);
        expect(sent).toHaveLength(2);

        // Same window, same tweets, a different process: Railway keeps the old
        // container alive while the new one boots, and both hold this cursor.
        sent = [];
        mockStore.delete(SINCE_KEY);
        respond({ tweets: [apiTweet('1'), apiTweet('2')] });
        const second = await runOnce(client);

        expect(second.posted).toBe(0);
        expect(sent).toHaveLength(0);
    });

    test('a tweet is mockClaimed before it is sent, never after', async () => {
        const order = [];
        const db = require('../src/utils/db');
        db.claimTweet.mockImplementationOnce(async id => { order.push(`claim:${id}`); return true; });
        client.channels.fetch = jest.fn(async () => ({
            isTextBased: () => true,
            send: jest.fn(async () => { order.push('send'); }),
        }));

        respond({ tweets: [apiTweet('1')] });
        await runOnce(client);

        expect(order).toEqual(['claim:1', 'send']);
    });

    test('a failed send is retried, and the retry cannot run forever', async () => {
        // This asserted the opposite until the audit: that a failed send kept
        // its claim, reasoning that retrying is how a channel gets spammed.
        // Wrong in the case that actually happens. The realistic failure is a
        // missing Send Messages permission, which fails every post equally,
        // and keeping the claim meant silently discarding all of them while
        // the panel went on reporting a healthy, spending mirror.
        //
        // Retrying is safe because the lookback clamp bounds it: once a
        // failure is older than the clamp, the window outruns it unaided, so
        // a permanently unpostable tweet cannot wedge the mirror.
        client.channels.fetch = jest.fn(async () => ({
            isTextBased: () => true,
            send: jest.fn(async () => { throw new Error('Missing Permissions'); }),
            messages: { fetch: jest.fn(async () => ({ embeds: [{}] })) },
        }));
        const at = Date.now() - 30 * 60 * 1000;
        respond({ tweets: [apiTweet('1', { at: new Date(at).toISOString() })] });

        const result = await runOnce(client, { sleep: noWait });

        expect(result.posted).toBe(0);
        expect(mockClaimed.has('1')).toBe(false);
        expect(mockStore.get(SINCE_KEY)).toBe(at - 1);

        // Hours later it is the clamp, not the held cursor, deciding the window.
        const muchLater = Date.now() + 5 * 60 * 60 * 1000;
        global.fetch.mockClear();
        respond({ tweets: [] });
        await runOnce(client, { now: muchLater, sleep: noWait });

        const since = Number(lastQuery().match(/since_time:(\d+)/)[1]) * 1000;
        expect(since).toBeGreaterThanOrEqual(muchLater - MAX_LOOKBACK_MS - 1000);
    });
});

// ── The cursor ──────────────────────────────────────────────────────────────

describe('the cursor', () => {
    test('never reaches back further than the lookback clamp', async () => {
        // A bot that was down for two days must not return with two days of
        // leaks, nor pay per tweet for them.
        const now = Date.now();
        mockStore.set(SINCE_KEY, now - 3 * 24 * 60 * 60 * 1000);
        respond({ tweets: [] });

        await runOnce(client, { now });

        const since = Number(lastQuery().match(/since_time:(\d+)/)[1]) * 1000;
        expect(since).toBeGreaterThanOrEqual(now - MAX_LOOKBACK_MS - 1000);
    });

    test('the first ever poll looks back minutes, not forever', async () => {
        const now = Date.now();
        respond({ tweets: [] });
        await runOnce(client, { now });

        const since = Number(lastQuery().match(/since_time:(\d+)/)[1]) * 1000;
        expect(now - since).toBeLessThanOrEqual(MAX_LOOKBACK_MS);
        expect(now - since).toBeGreaterThan(0);
    });

    test('advances to the newest tweet seen, including ones it chose not to post', async () => {
        const newest = '2026-08-07T18:00:00.000Z';
        respond({ tweets: [apiTweet('1', { at: '2026-08-07T17:00:00Z' }), apiTweet('2', { at: newest })] });

        await runOnce(client);

        expect(mockStore.get(SINCE_KEY)).toBe(Date.parse(newest));
    });
});

// ── Failure ─────────────────────────────────────────────────────────────────

describe('when the API says no', () => {
    test('a rejected key switches the mirror off instead of retrying every ten minutes', async () => {
        respond({ status: 401, body: '{"error":"Unauthorized"}' });

        const result = await runOnce(client);

        expect(result.skipped).toBe('api key rejected');
        expect(mockStore.get(ENABLED_KEY)).toBe(false);
    });

    test('a rate limit is treated as weather: no disable, no post, try again later', async () => {
        respond({ status: 429, body: 'slow down' });

        const result = await runOnce(client);

        expect(result.skipped).toBe('request failed');
        expect(mockStore.get(ENABLED_KEY)).toBeUndefined();
    });

    test('a network failure does not throw out of the tick', async () => {
        global.fetch.mockRejectedValueOnce(new Error('ECONNRESET'));
        await expect(runOnce(client)).resolves.toMatchObject({ skipped: 'request failed' });
    });

    test('HTML where JSON was promised is a failure, not a crash', async () => {
        respond({ body: '<!DOCTYPE html><html>nope</html>' });
        const result = await runOnce(client);
        expect(result.skipped).toBe('request failed');
    });

    test('a broken channel is reported once, and again only after it recovers', async () => {
        // Something that runs every ten minutes forever cannot log a problem
        // per poll: that is 4,000 identical lines a month, which is the same
        // as having no log at all.
        const logger = require('../src/utils/logger');
        const complaints = () => logger.error.mock.calls.filter(c => /Channel missing/.test(c[0])).length;
        const broken = jest.fn(async () => null);
        const working = jest.fn(async () => ({ isTextBased: () => true, send: jest.fn() }));
        mockStore.set(CHANNEL_KEY, 'chan-flaky');

        client.channels.fetch = broken;
        respond({ tweets: [apiTweet('1')] }); await runOnce(client);
        respond({ tweets: [apiTweet('2')] }); await runOnce(client);
        expect(complaints()).toBe(1);

        client.channels.fetch = working;
        respond({ tweets: [apiTweet('3')] }); await runOnce(client);

        client.channels.fetch = broken;
        respond({ tweets: [apiTweet('4')] }); await runOnce(client);
        expect(complaints()).toBe(2);
    });

    test('a 200 carrying an error body is a failure, not an empty result', async () => {
        // The worst available failure: it would read as "nothing new", so the
        // mirror looks healthy, posts nothing forever, and still pays per poll.
        respond({ body: JSON.stringify({ status: 'error', msg: 'insufficient credits' }) });

        const result = await runOnce(client);

        expect(result.skipped).toBe('request failed');
        expect(result.error).toContain('insufficient credits');
    });

    test('a deleted channel is reported without losing the cursor', async () => {
        client.channels.fetch = jest.fn(async () => null);
        respond({ tweets: [apiTweet('1')] });

        const result = await runOnce(client);

        expect(result.skipped).toBe('channel unreachable');
        // Nothing was mockClaimed, so a fixed channel replays the window.
        expect(mockClaimed.size).toBe(0);
    });
});

// ── The panel ───────────────────────────────────────────────────────────────
//
// /tweets_settings is the only settings panel in the bot whose controls cost
// money, so what it must never do is misreport the spend or offer a button
// that quietly charges you when it cannot possibly work.

const panel = require('../src/commands/tools/tweets_settings');

/** The shape mirrorStatus() hands the renderer. */
function panelState(over = {}) {
    return {
        hasKey: true,
        channelId: 'chan-1',
        enabled: true,
        accounts: ['FNFestival', 'HYPEX', 'ShiinaBR'],
        sinceMs: Date.now() - 60_000,
        budgetUsd: 2,
        style: 'link',
        spend: { month: '2026-08', usd: 0.12, calls: 800, tweets: 40 },
        running: true,
        intervalMs: 10 * 60 * 1000,
        floorUsdPerMonth: 0.65,
        ...over,
    };
}

const buttons = rendered => rendered.rows
    .flatMap(r => r.toJSON().components)
    .filter(c => c.custom_id?.startsWith('tw_'));
const button = (rendered, id) => buttons(rendered).find(c => c.custom_id === id);

describe('reading handles out of the modal', () => {
    test('strips @, splits on commas or spaces, and drops duplicates', () => {
        expect(panel.parseAccounts('@HYPEX, ShiinaBR  FNFestival, @hypex, HYPEX'))
            .toEqual(['HYPEX', 'ShiinaBR', 'FNFestival', 'hypex']);
    });

    test('rejects anything X could not be a handle', () => {
        // Over 15 characters, or containing punctuation, is not a handle. A
        // bad one would silently return nothing forever rather than erroring.
        expect(panel.parseAccounts('way_too_long_to_be_a_handle, bad-dash, ok_1'))
            .toEqual(['ok_1']);
        expect(panel.parseAccounts('   ,,,  ')).toEqual([]);
    });

    test('caps the list, because every handle widens the query', () => {
        const many = Array.from({ length: 30 }, (_, i) => `user${i}`).join(',');
        expect(panel.parseAccounts(many)).toHaveLength(10);
    });
});

describe('projecting the month', () => {
    test('says nothing on the first day, when the sample proves nothing', () => {
        expect(panel.projectMonth(0.01, new Date('2026-08-01T02:00:00Z'))).toBeNull();
        expect(panel.projectMonth(0, new Date('2026-08-20T00:00:00Z'))).toBeNull();
    });

    test('extrapolates the rest of the month from what has been spent', () => {
        // Half a month gone, $0.50 spent, so about $1 by the end of August.
        const projected = panel.projectMonth(0.5, new Date('2026-08-16T00:00:00Z'));
        expect(projected).toBeGreaterThan(0.9);
        expect(projected).toBeLessThan(1.1);
    });

    // The live panel on 2026-08-11: $0.0996 over 570 checks, a mirror switched
    // on partway through the month. Dividing by days-since-the-1st reported
    // $0.28, which is not just wrong, it is BELOW the $0.66 floor the same
    // panel prints for a month of checks that find nothing. The poll count is
    // the honest clock: 570 checks at ten minutes is four days, not eleven.
    test('a mirror switched on mid-month is not credited with the whole month', () => {
        const spend = { month: '2026-08', usd: 0.0996, calls: 570, tweets: 388 };
        const projected = panel.projectMonth(spend, new Date('2026-08-11T21:20:00Z'));

        expect(projected).toBeGreaterThan(0.7);
        expect(projected).toBeLessThan(0.85);
        // The floor of a month of empty ten-minute checks. A projection under
        // it is arithmetically impossible for a mirror that keeps running.
        expect(projected).toBeGreaterThan(4464 * 0.00015);
    });

    test('the clock never runs faster than the calendar', () => {
        // A "check now" spree cannot invent time the month has not had yet.
        const spend = { month: '2026-08', usd: 0.05, calls: 99_999, tweets: 0 };
        const projected = panel.projectMonth(spend, new Date('2026-08-16T00:00:00Z'));
        expect(projected).toBeGreaterThan(0.09);
        expect(projected).toBeLessThan(0.11);
    });

    test('the runway is the number a yearly top-up is judged in', () => {
        // A million credits is $10. At $0.77 a month it is thirteen months.
        expect(panel.runwayMonths(1_000_000, 0.77)).toBeGreaterThan(12);
        expect(panel.runwayMonths(1_000_000, 0.77)).toBeLessThan(14);
        expect(panel.runwayMonths(0, 0.77)).toBeNull();
        expect(panel.runwayMonths(1_000_000, 0)).toBeNull();
    });
});

describe('what the panel shows', () => {
    test('leads with the missing key, since nothing works without it', () => {
        const { embed } = panel.render(panelState({ hasKey: false }));
        expect(embed.toJSON().description).toMatch(/TWITTERAPI_KEY/);
    });

    test('will not offer "check now" when it would fail or cost for nothing', () => {
        expect(button(panel.render(panelState({ hasKey: false })), 'tw_check').disabled).toBe(true);
        expect(button(panel.render(panelState({ channelId: null })), 'tw_check').disabled).toBe(true);
        expect(button(panel.render(panelState()), 'tw_check').disabled).toBe(false);
    });

    test('cannot be switched on before a channel exists to switch it on for', () => {
        expect(button(panel.render(panelState({ channelId: null })), 'tw_toggle').disabled).toBe(true);
    });

    test('shows spend against the cap, in dollars and in the credits the vendor uses', () => {
        const { embed } = panel.render(panelState({ spend: { month: '2026-08', usd: 0.123, calls: 820, tweets: 41 } }));
        const field = embed.toJSON().fields.find(f => /Spent this month/.test(f.name));
        expect(field.value).toContain('$0.1230');
        expect(field.value).toContain('of $2.00');
        // 100,000 credits to the dollar, which is what the twitterapi.io
        // dashboard displays; showing only dollars means doing the conversion
        // by hand every time the two are compared.
        expect(field.value).toContain('12,300 credits');
    });

    // He has prepaid a year. The question the panel has to answer stopped
    // being "how much this month" and became "does this last until next
    // August", which is a different number entirely.
    test('the prepaid balance carries its own runway', () => {
        const { embed } = panel.render(panelState({
            spend: { month: '2026-08', usd: 0.0996, calls: 570, tweets: 388, posted: 41 },
            balance: { credits: 999_950, meter: 9_960, atMs: Date.now(), billed: 9_960, counted: 9_960 },
        }));
        const field = embed.toJSON().fields.find(f => f.name === 'Prepaid balance');
        expect(field.value).toContain('999,950');
        expect(field.value).toContain('$10.00');
        expect(field.value).toMatch(/about \*\*1[0-9] months\*\*/);
        expect(field.value).toContain('the meter is calibrated');
    });

    test('a meter that has drifted says by how much, in their unit', () => {
        const { embed } = panel.render(panelState({
            balance: { credits: 900_000, meter: 50_000, atMs: Date.now(), billed: 100_000, counted: 50_000 },
        }));
        const field = embed.toJSON().fields.find(f => f.name === 'Prepaid balance');
        expect(field.value).toContain('they are ahead by 50,000');
    });

    test('no balance yet means no block, rather than a block full of nothing', () => {
        const { embed } = panel.render(panelState({ balance: null }));
        expect(embed.toJSON().fields.some(f => f.name === 'Prepaid balance')).toBe(false);
    });

    test('the floor rides beside the projection, since one contradicting the other is the bug', () => {
        const { embed } = panel.render(panelState({
            spend: { month: '2026-08', usd: 0.0996, calls: 570, tweets: 388, posted: 41 },
        }));
        const field = embed.toJSON().fields.find(f => /Spent this month/.test(f.name));
        expect(field.value).toContain('floor is $0.65');
        expect(field.value).toContain('388 fetched · 41 posted');
    });

    test('says plainly when the cap has stopped it', () => {
        const { embed } = panel.render(panelState({ spend: { month: '2026-08', usd: 2, calls: 1, tweets: 0 } }));
        expect(embed.toJSON().description).toMatch(/cap reached/i);
        expect(embed.toJSON().color).toBe(require('../src/utils/constants').EMBED_COLORS.ERROR);
    });

    test('the style button offers the other style, not the current one', () => {
        expect(button(panel.render(panelState({ style: 'link' })), 'tw_style').label).toMatch(/embed/i);
        expect(button(panel.render(panelState({ style: 'embed' })), 'tw_style').label).toMatch(/fxtwitter/i);
    });

    test('stays within Discord\u2019s five rows', () => {
        expect(panel.render(panelState()).rows.length).toBeLessThanOrEqual(5);
    });
});

// ── When the embed service lets us down ─────────────────────────────────────
//
// The one part of this that depends on somebody else's uptime is the link
// unfurl. What matters is that a failure is noticed at all: a bare URL sitting
// in a feed channel with no preview is the visible symptom, and nothing in the
// bot would otherwise ever know.

const { repairEmbed, embedLanded, linkFor, LINK_HOSTS } = mirror;

/** Verification waits several seconds; tests are not going to. */
const noWait = async () => {};

function fakeChannel(embedCountsInOrder) {
    const counts = [...embedCountsInOrder];
    const edits = [];
    return {
        edits,
        messages: {
            fetch: jest.fn(async () => ({ embeds: new Array(counts.shift() ?? 0).fill({}) })),
        },
        message: {
            id: 'msg-1',
            edit: jest.fn(async payload => { edits.push(payload); }),
        },
    };
}

describe('the fallback ladder', () => {
    test('the first fallback is a different project, not another door to the same one', () => {
        // fxtwitter, girlcockx, fixupx and twittpr are all FixTweet: one
        // backend, four domains, verified by identical OG output. Falling from
        // one to another survives a DNS problem and nothing else. vxtwitter is
        // a separate project, so it is the hop that survives an outage.
        expect(LINK_HOSTS[0]).toBe('fxtwitter.com');
        expect(LINK_HOSTS[1]).toBe('vxtwitter.com');
        expect(LINK_HOSTS).toContain('girlcockx.com');
    });

    test('builds the same path against any host', () => {
        expect(linkFor('HYPEX', '9', 'vxtwitter.com')).toBe('https://vxtwitter.com/HYPEX/status/9');
    });

    test('leaves the message alone when the first link renders', async () => {
        const ch = fakeChannel([1]);
        const via = await repairEmbed(ch, normalizeTweet(apiTweet('1')), ch.message, { sleep: noWait });

        expect(via).toBe('fxtwitter.com');
        expect(ch.message.edit).not.toHaveBeenCalled();
    });

    test('rewrites to the next service when nothing rendered', async () => {
        const ch = fakeChannel([0, 1]);   // fxtwitter blank, vxtwitter fine
        const via = await repairEmbed(ch, normalizeTweet(apiTweet('1', { handle: 'HYPEX' })), ch.message, { sleep: noWait });

        expect(via).toBe('vxtwitter.com');
        expect(ch.edits).toEqual([{ content: 'https://vxtwitter.com/HYPEX/status/1' }]);
    });

    test('ends at an embed built here, which needs nobody else to render it', async () => {
        const ch = fakeChannel([0, 0, 0]);
        const via = await repairEmbed(ch, normalizeTweet(apiTweet('1')), ch.message, { sleep: noWait });

        expect(via).toBe('built-in');
        // Content cleared so the dead URL does not sit above the embed.
        const last = ch.edits[ch.edits.length - 1];
        expect(last.content).toBe('');
        expect(last.embeds).toHaveLength(1);
    });

    test('a message it cannot re-read is not treated as a failure', async () => {
        // Churning the link because one fetch failed would rewrite messages
        // that were rendering perfectly well.
        const channel = { messages: { fetch: jest.fn(async () => null) } };
        expect(await embedLanded(channel, 'm', { sleep: noWait })).toBe(true);
    });

    test('forces past the cache, which still holds the pre-unfurl copy', async () => {
        const channel = { messages: { fetch: jest.fn(async () => ({ embeds: [{}] })) } };
        await embedLanded(channel, 'm-7', { sleep: noWait });
        expect(channel.messages.fetch).toHaveBeenCalledWith({ message: 'm-7', force: true });
    });
});

describe('remembering what it posted', () => {
    test('records the message id so a reply to it does not wake the bot', async () => {
        const db = require('../src/utils/db');
        respond({ tweets: [apiTweet('42')] });

        const result = await runOnce(client, { sleep: noWait });
        await result.verification;

        expect(db.recordMirrorMessage).toHaveBeenCalledWith('42', expect.any(String));
    });

    test('posting is not held up by the embed check', async () => {
        // The check waits seconds per message. Doing it inline would stall the
        // next post behind it and put the cursor write on the far side.
        respond({ tweets: [apiTweet('1'), apiTweet('2')] });
        const result = await runOnce(client, { sleep: noWait });

        expect(result.posted).toBe(2);
        expect(result.verification).toBeInstanceOf(Promise);
        await result.verification;
    });
});

// ── Proving it works ────────────────────────────────────────────────────────
//
// "0 posts fetched" is what a healthy mirror looks like on a quiet quarter of
// an hour and what a broken one looks like forever. twitterapi.io's own call
// log does not separate them either: it showed no calls at all for a request
// that had demonstrably been billed. So the bot has to answer the question
// itself, with a window wide enough that silence means something.

describe('the test fetch', () => {
    test('reaches back hours, not minutes, so silence is a real signal', async () => {
        const now = Date.now();
        respond({ tweets: [] });
        await mirror.testFetch({ hoursBack: 6 });

        const since = Number(lastQuery().match(/since_time:(\d+)/)[1]) * 1000;
        expect(now - since).toBeGreaterThan(5.5 * 3600 * 1000);
    });

    test('leaves the cursor exactly where it was', async () => {
        // It must never eat a post the real poller would have delivered.
        mockStore.set(SINCE_KEY, 12345);
        respond({ tweets: [apiTweet('1')] });

        await mirror.testFetch();

        expect(mockStore.get(SINCE_KEY)).toBe(12345);
    });

    test('posts nothing and claims nothing', async () => {
        respond({ tweets: [apiTweet('1'), apiTweet('2')] });
        await mirror.testFetch();

        expect(sent).toHaveLength(0);
        expect(mockClaimed.size).toBe(0);
    });

    test('still pays for itself, because the request is just as real', async () => {
        respond({ tweets: [apiTweet('1'), apiTweet('2'), apiTweet('3')] });
        const r = await mirror.testFetch();

        expect(r.spend.usd).toBeCloseTo(3 * COST_PER_UNIT_USD, 8);
    });

    test('breaks the count down per handle, so one dead account is visible', async () => {
        // Three accounts and twelve results could still be one working handle
        // and two silently misspelled ones.
        respond({
            tweets: [
                apiTweet('1', { handle: 'HYPEX' }),
                apiTweet('2', { handle: 'HYPEX' }),
                apiTweet('3', { handle: 'ShiinaBR' }),
            ],
        });
        const r = await mirror.testFetch();

        expect(r.perAccount).toEqual({ HYPEX: 2, ShiinaBR: 1 });
        expect(r.found).toBe(3);
    });

    test('refuses to run without a key rather than reporting a false negative', async () => {
        delete process.env.TWITTERAPI_KEY;
        const r = await mirror.testFetch();

        expect(r.ok).toBe(false);
        expect(r.reason).toBe('no TWITTERAPI_KEY set');
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe('reading the test out loud', () => {
    const { testReport } = require('../src/commands/tools/tweets_settings');

    test('calls six hours of silence suspicious, and shows the query', () => {
        const text = testReport({
            ok: true, hoursBack: 6, found: 0, perAccount: {}, newest: null,
            query: '(from:HYPEX) -filter:replies since_time:1', silent: ['HYPEX'], callUsd: 0.00015, budgetUsd: 2, spend: { usd: 0.0003 },
        });
        expect(text).toMatch(/Found nothing/);
        expect(text).toMatch(/wrong handle|rejected query/);
        expect(text).toContain('from:HYPEX');
    });

    test('says plainly that a successful test changed nothing', () => {
        const text = testReport({
            ok: true, hoursBack: 6, found: 4,
            perAccount: { HYPEX: 3, ShiinaBR: 1 },
            newest: { atMs: 1754000000000, text: 'a leak https://t.co/abc123', url: 'https://fxtwitter.com/HYPEX/status/1' },
            silent: ['FNFestival'],
            query: 'q', callUsd: 0.0006, budgetUsd: 2, spend: { usd: 0.0009 },
        });
        expect(text).toMatch(/Found 4 posts/);
        expect(text).toContain('@HYPEX 3');
        expect(text).toMatch(/cursor did not move/);
    });

    test('turns a missing key into the instruction that fixes it', () => {
        expect(testReport({ ok: false, reason: 'no TWITTERAPI_KEY set' })).toMatch(/Railway/);
    });
});

describe('the money line in the test report', () => {
    const { testReport } = require('../src/commands/tools/tweets_settings');

    const report = over => testReport({
        ok: true, hoursBack: 6, found: 7,
        perAccount: { HYPEX: 3, ShiinaBR: 4 }, silent: [],
        newest: { atMs: 1754000000000, text: 'x', url: 'https://fxtwitter.com/HYPEX/status/1' },
        query: 'q', callUsd: 0.00105, budgetUsd: 2, spend: { usd: 0.0016 },
        ...over,
    });

    test('separates what this check cost from the running total', () => {
        // These were one number labelled "that check cost", which showed the
        // cumulative figure. On the only feature in the bot that spends real
        // money, that is the wrong number under the wrong name.
        const text = report();
        expect(text).toContain('This check: $0.00105');
        expect(text).toContain('Month so far: $0.0016');
    });

    test('quotes the real cap rather than assuming it is still two dollars', () => {
        expect(report({ budgetUsd: 5 })).toContain('of $5.00');
    });

    test('strips the t.co link X appends, which Discord would unfurl as a second embed', () => {
        const text = report({
            newest: { atMs: 1754000000000, text: 'REGULAR SHOW RETURNS https://t.co/Ig1YIfMGuG', url: 'https://fxtwitter.com/HYPEX/status/1' },
        });
        expect(text).not.toContain('t.co');
        expect(text).toContain('REGULAR SHOW RETURNS');
    });

    test('names the accounts that returned nothing, since a typo looks like a quiet day', () => {
        expect(report({ silent: ['FNFestival'] })).toContain('@FNFestival');
    });
});

describe('spotting a handle that never answers', () => {
    test('reports which watched accounts returned nothing', async () => {
        mockStore.set(ACCOUNTS_KEY, ['FNFestival', 'HYPEX', 'ShiinaBR']);
        respond({ tweets: [apiTweet('1', { handle: 'HYPEX' })] });

        const r = await mirror.testFetch();

        expect(r.perAccount).toEqual({ HYPEX: 1 });
        expect(r.silent.sort()).toEqual(['FNFestival', 'ShiinaBR']);
    });

    test('nothing is silent when everyone answered', async () => {
        mockStore.set(ACCOUNTS_KEY, ['HYPEX']);
        respond({ tweets: [apiTweet('1', { handle: 'HYPEX' })] });

        expect((await mirror.testFetch()).silent).toEqual([]);
    });

    test('the per-check cost is the billed one, not the running total', async () => {
        respond({ tweets: [apiTweet('1'), apiTweet('2'), apiTweet('3')] });
        const r = await mirror.testFetch();

        expect(r.callUsd).toBeCloseTo(3 * COST_PER_UNIT_USD, 8);
        expect(r.spend.usd).toBeCloseTo(3 * COST_PER_UNIT_USD, 8);

        // Second call: the running total moves, the per-call figure does not.
        respond({ tweets: [apiTweet('4')] });
        const r2 = await mirror.testFetch();

        expect(r2.callUsd).toBeCloseTo(COST_PER_UNIT_USD, 8);
        expect(r2.spend.usd).toBeCloseTo(4 * COST_PER_UNIT_USD, 8);
    });
});

// ── The audit round ─────────────────────────────────────────────────────────
//
// Everything below came out of reading the finished feature back rather than
// from building it. These are the failures that survive a green test suite:
// silent losses, misreported state, and inputs nobody types on purpose.

describe('a send that fails must not lose the post', () => {
    /** A channel whose sends always fail, as one without Send Messages does. */
    function brokenChannel() {
        return {
            isTextBased: () => true,
            send: jest.fn(async () => { throw new Error('Missing Permissions'); }),
            messages: { fetch: jest.fn(async () => ({ embeds: [{}] })) },
        };
    }

    test('hands the claim back so the next poll can try again', async () => {
        client.channels.fetch = jest.fn(async () => brokenChannel());
        respond({ tweets: [apiTweet('1')] });

        await runOnce(client, { sleep: noWait });

        // Claimed then released. Left claimed, the retry below would be
        // skipped and the post would be gone for good.
        expect(mockClaimed.has('1')).toBe(false);
    });

    test('holds the cursor short of the failure instead of walking past it', async () => {
        client.channels.fetch = jest.fn(async () => brokenChannel());
        const at = '2026-08-07T12:00:00.000Z';
        respond({ tweets: [apiTweet('1', { at })] });

        await runOnce(client, { sleep: noWait });

        expect(mockStore.get(SINCE_KEY)).toBe(Date.parse(at) - 1);
    });

    test('so fixing the permission actually delivers the held post', async () => {
        client.channels.fetch = jest.fn(async () => brokenChannel());
        respond({ tweets: [apiTweet('1')] });
        await runOnce(client, { sleep: noWait });
        expect(sent).toHaveLength(0);

        // Permission restored; same window, because the cursor never moved.
        client.channels.fetch = jest.fn(async () => ({
            isTextBased: () => true,
            send: jest.fn(async p => { sent.push(p); return { id: 'm1', edit: jest.fn() }; }),
            messages: { fetch: jest.fn(async () => ({ embeds: [{}] })) },
        }));
        respond({ tweets: [apiTweet('1')] });
        const second = await runOnce(client, { sleep: noWait });

        expect(second.posted).toBe(1);
    });

    test('a partial failure still advances past what did post', async () => {
        let calls = 0;
        client.channels.fetch = jest.fn(async () => ({
            isTextBased: () => true,
            send: jest.fn(async p => {
                calls += 1;
                if (calls === 2) throw new Error('nope');
                sent.push(p);
                return { id: `m${calls}`, edit: jest.fn() };
            }),
            messages: { fetch: jest.fn(async () => ({ embeds: [{}] })) },
        }));
        respond({
            tweets: [
                apiTweet('old', { at: '2026-08-07T10:00:00Z' }),
                apiTweet('bad', { at: '2026-08-07T11:00:00Z' }),
                apiTweet('new', { at: '2026-08-07T12:00:00Z' }),
            ],
        });

        const r = await runOnce(client, { sleep: noWait });

        expect(r.posted).toBe(2);
        // Rewound to just before the one that failed, not to the newest.
        expect(mockStore.get(SINCE_KEY)).toBe(Date.parse('2026-08-07T11:00:00Z') - 1);
    });
});

describe('handles that are not handles', () => {
    test('a handle with a bracket cannot reshape the query', () => {
        // A stored value is not a validated value. An unescaped bracket would
        // silently change what was asked for, and be billed as though it had
        // not.
        expect(buildQuery(['HYPEX', 'evil) OR from:everyone'], 1)).toBe(
            '(from:HYPEX) -filter:replies since_time:1'
        );
    });

    test('nothing usable yields no query at all rather than a broken one', () => {
        expect(buildQuery(['', '   ', '@@@'], 1)).toBeNull();
        expect(buildQuery([], 1)).toBeNull();
    });

    test('the poller refuses to spend on a query it could not build', async () => {
        mockStore.set(ACCOUNTS_KEY, ['not a handle!']);
        const r = await runOnce(client);

        expect(r.skipped).toBe('no valid handles');
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe('the silent-account check', () => {
    test('is case-insensitive, since X handles are', async () => {
        // Watching "shiinabr" while the API answers "ShiinaBR" would otherwise
        // report a perfectly healthy account as silent on every single test.
        mockStore.set(ACCOUNTS_KEY, ['shiinabr', 'HyPeX']);
        respond({
            tweets: [apiTweet('1', { handle: 'ShiinaBR' }), apiTweet('2', { handle: 'HYPEX' })],
        });

        expect((await mirror.testFetch()).silent).toEqual([]);
    });
});

describe('the fallback embed is not a dead end', () => {
    test('carries a link through to the post it is standing in for', () => {
        // It only ever renders because no link service did, so if it does not
        // link anywhere, there is no way left to reach the tweet.
        const t = normalizeTweet(apiTweet('123', { handle: 'HYPEX' }));
        expect(renderEmbed(t).toJSON().description).toContain('https://fxtwitter.com/HYPEX/status/123');
    });

    test('and still fits when the text is at maximum length', () => {
        const t = normalizeTweet(apiTweet('1', { text: 'x'.repeat(9000) }));
        expect(renderEmbed(t).toJSON().description.length).toBeLessThanOrEqual(4096);
    });
});

describe('complaints clear when the condition does', () => {
    test('a key rejected, fixed, then rejected again is reported both times', async () => {
        const logger = require('../src/utils/logger');
        const rejections = () => logger.error.mock.calls.filter(c => /key rejected/.test(c[0])).length;

        respond({ status: 401, body: 'no' });
        await runOnce(client);
        expect(rejections()).toBe(1);

        // Fixed: a good poll clears the condition.
        mockStore.set(ENABLED_KEY, true);
        respond({ tweets: [] });
        await runOnce(client);

        mockStore.set(ENABLED_KEY, true);
        respond({ status: 401, body: 'no' });
        await runOnce(client);
        expect(rejections()).toBe(2);
    });
});
