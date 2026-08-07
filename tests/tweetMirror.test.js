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
    pruneMirroredTweets: jest.fn(async () => 0),
}));
jest.mock('../src/utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const mirror = require('../src/utils/tweetMirror');
const {
    buildQuery, normalizeTweet, renderEmbed, runOnce, readSpend, recordSpend, monthKey,
    CHANNEL_KEY, ENABLED_KEY, ACCOUNTS_KEY, SINCE_KEY, SPEND_KEY, BUDGET_KEY, STYLE_KEY,
    MAX_POSTS_PER_TICK, MAX_LOOKBACK_MS, COST_PER_UNIT_USD,
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
                send: jest.fn(async payload => { sent.push(payload); }),
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

    test('a send that Discord rejects does not un-claim, so it cannot loop', async () => {
        client.channels.fetch = jest.fn(async () => ({
            isTextBased: () => true,
            send: jest.fn(async () => { throw new Error('Missing Permissions'); }),
        }));
        respond({ tweets: [apiTweet('1')] });

        const result = await runOnce(client);

        expect(result.posted).toBe(0);
        expect(mockClaimed.has('1')).toBe(true);
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
