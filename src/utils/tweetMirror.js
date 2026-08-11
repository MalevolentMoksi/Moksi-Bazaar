// src/utils/tweetMirror.js
/**
 * Mirrors new posts from a handful of X accounts into a Discord channel.
 *
 * There is no free way to do this any more, and that is a finding rather than
 * an assumption: Nitter was tested across five instances (all dead, walled or
 * demanding a manually whitelisted reader), RSSHub's route is gone, the
 * syndication endpoint behind embedded timelines returns an empty body, and
 * fxtwitter has no timeline route at all. fxtwitter renders a post you already
 * have the id of; it cannot tell you that one exists. Both leakers do hold
 * real Bluesky handles, and both stopped posting to them in late 2024.
 *
 * So this pays twitterapi.io, and the entire design is about paying as little
 * as possible.
 *
 * The lever is Advanced Search. It bills $0.00015 per request as a floor and
 * $0.00015 per tweet returned, so ONE query covering every account at once,
 * with since_time pinned to the last check, costs the bare floor on every poll
 * that finds nothing. Most polls find nothing. Their per-user "last tweets"
 * endpoint bills a full page of 20 whether or not anything is new, which is
 * why their own docs warn you off it: polling that way costs about $78/month
 * for three accounts, against roughly $0.65 for this.
 *
 * The spend cap is enforced, not advisory. It is read before every request and
 * the poller goes quiet for the rest of the month once it is hit.
 */

const { EmbedBuilder } = require('discord.js');
const {
    getSpeakConfigValue,
    setSpeakConfigValue,
    claimTweet,
    releaseTweet,
    recordMirrorMessage,
    pruneMirroredTweets,
} = require('./db');
const logger = require('./logger');
const health = require('./health');

const API_URL = 'https://api.twitterapi.io/twitter/tweet/advanced_search';
const API_TIMEOUT_MS = 20_000;

/** What twitterapi.io charges per billing unit: one request, or one tweet. */
const COST_PER_UNIT_USD = 0.00015;
/** Their own unit. A dollar is 100,000 of them, so a unit is 15. */
const CREDITS_PER_USD = 100_000;
const CREDITS_PER_UNIT = Math.round(COST_PER_UNIT_USD * CREDITS_PER_USD);

/**
 * The vendor's own balance, which is the only exact number in this system.
 *
 * Their usage page says so itself: "Usage shown here is sampled and can
 * significantly undercount actual consumption." It showed 13 calls against the
 * 570 this bot had actually made. The credit balance is the ledger, and this
 * endpoint is how to read it.
 *
 * Whether the call itself costs anything is undocumented. It is only made when
 * the panel is opened, and the reconciliation below would show it as drift if
 * it did, which is a cheaper way to find out than asking.
 */
const ACCOUNT_URL = 'https://api.twitterapi.io/oapi/my/info';
const BALANCE_TTL_MS = 5 * 60 * 1000;

/**
 * Ten minutes. The cost is almost entirely per-request, so the interval is the
 * price dial: five minutes roughly doubles the bill for five minutes less
 * latency on a leak. Ten stays under the ceiling even if these accounts post
 * far more than they currently do.
 */
const POLL_INTERVAL_MS = 10 * 60 * 1000;
/** First poll shortly after boot, not a full interval later. */
const FIRST_POLL_DELAY_MS = 60 * 1000;

/**
 * How far back a poll will ever look. Without this, a bot that was down for
 * two days comes back and floods the channel with two days of leaks, and pays
 * per tweet to do it.
 */
const MAX_LOOKBACK_MS = 2 * 60 * 60 * 1000;
/** On the very first poll, with no stored cursor, reach back only this far. */
const FIRST_RUN_LOOKBACK_MS = 15 * 60 * 1000;
/** Ceiling on messages per poll, so a burst cannot turn into a wall of posts. */
const MAX_POSTS_PER_TICK = 10;

/**
 * How many results Advanced Search puts on one page.
 *
 * Used only to decide whether `has_next_page` is worth believing. That flag
 * comes back true on almost every response this vendor sends, including ones
 * carrying a single tweet, so on its own it means nothing. It is only
 * meaningful when the page came back FULL: results arrive newest first, so a
 * genuine second page holds tweets older than everything on the first, and
 * the cursor is about to move past them. A page that came back short
 * exhausted the window and has nothing behind it.
 *
 * Nothing functional hangs on this number. It decides what gets logged, and
 * posts are delivered or dropped identically either way.
 */
const SEARCH_PAGE_SIZE = 20;

const CHANNEL_KEY = 'tweet_mirror_channel_id';
const ENABLED_KEY = 'tweet_mirror_enabled';
const ACCOUNTS_KEY = 'tweet_mirror_accounts';
const SINCE_KEY = 'tweet_mirror_since_ms';
const SPEND_KEY = 'tweet_mirror_spend';
const BALANCE_KEY = 'tweet_mirror_balance';
const BUDGET_KEY = 'tweet_mirror_budget_usd';
const STYLE_KEY = 'tweet_mirror_style';

const DEFAULT_ACCOUNTS = ['FNFestival', 'HYPEX', 'ShiinaBR'];
const DEFAULT_BUDGET_USD = 2.0;
/** 'link' lets FixTweet render it (video plays); 'embed' builds our own. */
const DEFAULT_STYLE = 'link';

const X_BLUE = 0x1D9BF0;

/**
 * Where a link goes when Discord refuses to unfurl the one before it.
 *
 * The order is deliberate and the reason is not obvious. fxtwitter.com,
 * girlcockx.com, fixupx.com and twittpr.com are all FixTweet: same backend,
 * four doorways, verified by them returning byte-identical OG tags. Falling
 * from one to another only survives a DNS or per-domain problem, not the
 * service being down, which is the failure people actually notice.
 *
 * vxtwitter.com is a different project with different infrastructure, so it
 * is the first hop worth making. The second FixTweet domain sits after it as
 * cheap insurance against the per-domain case.
 *
 * Whatever survives all of them falls through to an embed built from data we
 * already hold, which cannot fail because nothing external renders it.
 */
const LINK_HOSTS = ['fxtwitter.com', 'vxtwitter.com', 'girlcockx.com'];

/**
 * How long Discord gets to attach an embed before it is called a failure.
 * Unfurling is usually well under a second; this is slack, not an estimate,
 * and it is spent after the message is already visible.
 */
const EMBED_GRACE_MS = 5_000;

let timer = null;
let firstTimer = null;
/**
 * Conditions already reported. A poller that runs every ten minutes forever
 * will say the same thing 4,000 times a month otherwise, and a log nobody can
 * skim is a log nobody reads. Each condition is announced once and stays quiet
 * until it actually clears.
 */
const complained = new Set();

// ── Query ───────────────────────────────────────────────────────────────────

/**
 * Builds the search query covering every account in one request.
 *
 * The parentheses are load-bearing. X's search grammar binds AND tighter than
 * OR, so `from:a OR from:b OR from:c since_time:N` parses as
 * "a, or b, or (c since N)": the time filter would attach to the last account
 * only, and the other two would return their entire recent history on every
 * single poll. That is both wrong and the expensive kind of wrong, since every
 * tweet returned is billed.
 *
 * @param {string[]} accounts bare handles, no leading @
 * @param {number} sinceSeconds unix seconds
 */
function buildQuery(accounts, sinceSeconds) {
    // Sanitised here rather than trusted from storage. The panel validates
    // what it writes, but this reads a config row, and a handle carrying a
    // space or a bracket would not fail loudly: it would quietly reshape the
    // query, and a reshaped query is billed exactly like a correct one.
    const clean = accounts
        .map(a => String(a).trim().replace(/^@/, ''))
        .filter(a => /^[A-Za-z0-9_]{1,15}$/.test(a));
    if (clean.length === 0) return null;

    const who = clean.map(a => `from:${a}`).join(' OR ');
    return `(${who}) -filter:replies since_time:${Math.floor(sinceSeconds)}`;
}

// ── Response handling ───────────────────────────────────────────────────────

/**
 * Pulls the few fields worth having out of a tweet, tolerating the shape
 * drifting underneath us. This is a scraped API standing in front of someone
 * else's private one, so field names are not a contract; anything missing
 * degrades the post rather than throwing.
 *
 * @returns {object|null} null when there is not enough to post
 */
function normalizeTweet(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const id = raw.id ?? raw.id_str ?? raw.tweet_id;
    if (!id) return null;

    const author = raw.author ?? raw.user ?? {};
    const handle = author.userName ?? author.screen_name ?? author.username ?? null;
    if (!handle) return null;

    // Twitter's own format ("Tue Dec 10 07:00:30 +0000 2024") and ISO both
    // parse; anything else is treated as "just now" rather than dropped, since
    // an unparseable date is not a reason to lose the post.
    const parsed = Date.parse(raw.createdAt ?? raw.created_at ?? '');
    const atMs = Number.isFinite(parsed) ? parsed : Date.now();

    const media = raw.extendedEntities?.media ?? raw.entities?.media ?? [];
    const photo = Array.isArray(media)
        ? media.find(m => (m?.type ?? 'photo') === 'photo')?.media_url_https ?? null
        : null;
    const hasVideo = Array.isArray(media) && media.some(m => m?.type === 'video' || m?.type === 'animated_gif');

    return {
        id: String(id),
        handle: String(handle),
        name: author.name ?? String(handle),
        avatar: author.profilePicture ?? author.profile_image_url_https ?? null,
        text: typeof raw.text === 'string' ? raw.text : '',
        atMs,
        photo,
        hasVideo,
        likes: Number(raw.likeCount ?? raw.favorite_count ?? 0) || 0,
        retweets: Number(raw.retweetCount ?? raw.retweet_count ?? 0) || 0,
        // The link that embeds properly. Kept as the default host; linkFor()
        // produces the same URL against any of the fallbacks.
        url: linkFor(handle, id, LINK_HOSTS[0]),
    };
}

/** The same post, addressed to whichever embed service is being tried. */
function linkFor(handle, id, host) {
    return `https://${host}/${handle}/status/${id}`;
}

/**
 * Our own embed, for when FixTweet is not doing the rendering.
 * Kept deliberately close to what the link unfurl produces.
 */
function renderEmbed(tweet) {
    const embed = new EmbedBuilder()
        .setColor(X_BLUE)
        .setAuthor({
            name: `${tweet.name} (@${tweet.handle})`.slice(0, 256),
            url: `https://fxtwitter.com/${tweet.handle}`,
            ...(tweet.avatar ? { iconURL: tweet.avatar } : {}),
        })
        // The link matters more here than anywhere else: this embed exists
        // because no link service rendered one, so without it the message is
        // a dead end with no way through to the actual post.
        .setDescription(`${(tweet.text || '[no text]').slice(0, 3900)}\n\n[Open on X](${tweet.url})`)
        .setTimestamp(new Date(tweet.atMs));

    if (tweet.photo) embed.setImage(tweet.photo);

    const stats = [];
    // Locale pinned so the footer reads the same wherever the bot happens
    // to be running; bare toLocaleString() follows the host's locale.
    if (tweet.likes) stats.push(`${tweet.likes.toLocaleString('en-US')} likes`);
    if (tweet.retweets) stats.push(`${tweet.retweets.toLocaleString('en-US')} reposts`);
    if (tweet.hasVideo) stats.push('has video');
    embed.setFooter({ text: stats.length ? `X • ${stats.join(' • ')}` : 'X' });

    return embed;
}

// ── Getting one post onto the screen ────────────────────────────────────────

/**
 * Did Discord attach an embed to this message?
 *
 * Discord unfurls a link server-side after the message is already delivered,
 * so the object returned by send() never has the embed yet. The only way to
 * know is to wait and look again, forcing past the cache, because the cached
 * copy is the one from before the unfurl.
 */
async function embedLanded(channel, messageId, { waitMs = EMBED_GRACE_MS, sleep } = {}) {
    // unref'd: shutdown has an eight second budget and must not spend it
    // waiting to re-check a link that is almost certainly fine.
    const wait = sleep ?? (ms => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); }));
    await wait(waitMs);
    const fresh = await channel.messages.fetch({ message: messageId, force: true }).catch(() => null);
    // A message we cannot re-read is not evidence of a failed embed, and
    // replacing a link on that basis would be churn for nothing.
    if (!fresh) return true;
    return (fresh.embeds?.length ?? 0) > 0;
}

/**
 * Checks that a posted link actually rendered, and rewrites it until one does.
 *
 * A bare link is the best possible result: FixTweet shows the author, the
 * text, the images, and a video that plays inline. It is also the only part
 * of this that depends on somebody else's uptime, so when it produces nothing
 * the message is edited to the next service, and finally to an embed built
 * here from data already in hand.
 *
 * Runs after the message is on screen, never before, so a slow check delays
 * nothing. In the good case it is one background fetch and no edit at all.
 *
 * @returns {Promise<string>} what ended up rendering it
 */
async function repairEmbed(channel, tweet, message, { hosts = LINK_HOSTS, sleep } = {}) {
    for (let i = 0; i < hosts.length; i += 1) {
        if (await embedLanded(channel, message.id, { sleep })) {
            if (i > 0) {
                logger.info('[TWEETS] Fell back to another embed service', { host: hosts[i], tweetId: tweet.id });
            }
            return hosts[i];
        }
        const next = hosts[i + 1];
        if (!next) break;
        await message.edit({ content: linkFor(tweet.handle, tweet.id, next) }).catch(() => {});
    }

    // Every link service declined. Our own embed needs nobody else to render
    // it, so this is a floor rather than one more thing that can fail.
    logger.warn('[TWEETS] No link service produced an embed, using the built-in one', {
        tweetId: tweet.id, tried: hosts,
    });
    await message.edit({ content: '', embeds: [renderEmbed(tweet)] }).catch(() => {});
    return 'built-in';
}

// ── Spend ───────────────────────────────────────────────────────────────────

function monthKey(at = new Date()) {
    return at.toISOString().slice(0, 7);
}

/**
 * Current month's spend, resetting itself when the month turns over.
 *
 * Two containers overlapping during a deploy can each read-modify-write this
 * and lose a fraction of a cent of accounting. That is tolerable: this is a
 * brake, not a ledger, and the real invoice lives at twitterapi.io.
 *
 * `lifetime` is the exception and does NOT reset with the month. It is the
 * only thing the vendor's balance can be reconciled against, and a counter
 * that restarts every month can only be compared for four weeks at a time.
 */
async function readSpend() {
    const stored = await getSpeakConfigValue(SPEND_KEY, null);
    const month = monthKey();
    const lifetime = {
        credits: Number(stored?.lifetime?.credits) || 0,
        sinceMs: Number(stored?.lifetime?.sinceMs) || 0,
    };
    if (!stored || stored.month !== month) {
        return { month, usd: 0, calls: 0, tweets: 0, posted: 0, lifetime };
    }
    return {
        month,
        usd: Number(stored.usd) || 0,
        calls: Number(stored.calls) || 0,
        tweets: Number(stored.tweets) || 0,
        posted: Number(stored.posted) || 0,
        lifetime,
    };
}

async function recordSpend(tweetsReturned, { now = Date.now() } = {}) {
    const spend = await readSpend();
    // A request that returns nothing still bills the floor, and a request that
    // returns tweets bills per tweet rather than both.
    const units = Math.max(1, tweetsReturned);
    const next = {
        month: spend.month,
        usd: Number((spend.usd + units * COST_PER_UNIT_USD).toFixed(6)),
        calls: spend.calls + 1,
        tweets: spend.tweets + Math.max(0, tweetsReturned),
        posted: spend.posted,
        lifetime: {
            credits: spend.lifetime.credits + units * CREDITS_PER_UNIT,
            sinceMs: spend.lifetime.sinceMs || now,
        },
    };
    await setSpeakConfigValue(SPEND_KEY, next);
    return next;
}

/**
 * How many of the tweets paid for actually reached the channel.
 *
 * Billing is per tweet returned, and the query returns things that get
 * dropped: a burst over the per-tick ceiling, a duplicate another container
 * already claimed. Without this the panel could say what was bought and never
 * what was used, which is the half that tells you a filter is wrong.
 */
async function recordPosted(count) {
    if (!(count > 0)) return null;
    const spend = await readSpend();
    const next = { ...spend, posted: (spend.posted || 0) + count };
    await setSpeakConfigValue(SPEND_KEY, next);
    return next;
}

/** The vendor's balance, as a number of credits, or null if unreachable. */
async function fetchBalance(apiKey) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
        const res = await fetch(ACCOUNT_URL, {
            headers: { 'X-API-Key': apiKey },
            signal: controller.signal,
        });
        if (!res.ok) return null;
        const data = await res.json().catch(() => null);
        // Documented flat, but every other endpoint on this host wraps its
        // payload in {status, data, msg}, so read both.
        const credits = Number(data?.recharge_credits ?? data?.data?.recharge_credits);
        return Number.isFinite(credits) ? { credits } : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * The balance, plus whether this bot's own meter agrees with it.
 *
 * The reference point is the last time the balance went UP, which is a top-up.
 * From there both numbers only fall, so "they billed X, we counted Y" is a
 * real audit rather than a snapshot: it answers, permanently and without
 * anybody doing arithmetic, whether the panel can be trusted for a year.
 */
async function accountBalance(apiKey, { now = Date.now(), force = false } = {}) {
    if (!apiKey) return null;
    const stored = await getSpeakConfigValue(BALANCE_KEY, null);
    if (!force && stored && now - Number(stored.atMs || 0) < BALANCE_TTL_MS) return stored;

    const fresh = await fetchBalance(apiKey);
    // Keep the last known reading rather than blanking the panel over a blip.
    if (!fresh) return stored;

    const spend = await readSpend();
    const meter = spend.lifetime.credits;
    const toppedUp = stored?.ref && fresh.credits > Number(stored.ref.credits);
    const ref = (!stored?.ref || toppedUp)
        ? { credits: fresh.credits, meter, atMs: now }
        : stored.ref;

    const next = {
        credits: fresh.credits,
        meter,
        atMs: now,
        ref,
        billed: Math.max(0, ref.credits - fresh.credits),
        counted: Math.max(0, meter - ref.meter),
    };
    await setSpeakConfigValue(BALANCE_KEY, next);
    return next;
}

// ── The call ────────────────────────────────────────────────────────────────

async function searchTweets({ apiKey, query }) {
    const url = `${API_URL}?queryType=Latest&query=${encodeURIComponent(query)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
        const res = await fetch(url, {
            headers: { 'X-API-Key': apiKey },
            signal: controller.signal,
        });
        const body = await res.text();

        if (!res.ok) return { ok: false, status: res.status, error: body.slice(0, 300) };

        let data;
        try {
            data = JSON.parse(body);
        } catch {
            return { ok: false, status: res.status, error: 'response was not JSON' };
        }

        // A 200 carrying an error body. Left unhandled this is the worst
        // failure available: it reads as "nothing new", so the mirror looks
        // healthy, posts nothing forever, and still pays for every poll.
        if (data?.status === 'error' || data?.error) {
            return {
                ok: false,
                status: res.status,
                error: String(data.msg ?? data.message ?? data.error ?? 'API reported an error').slice(0, 300),
            };
        }

        // Advanced Search puts `tweets` at the root, confirmed against
        // twitterapi.io's own reference script. Other endpoints on the same
        // host wrap the payload in {status, data, msg} instead: /twitter/user/
        // info does exactly that. Reading both shapes costs one line and
        // covers them ever making the two consistent.
        const payload = Array.isArray(data?.tweets) ? data
            : Array.isArray(data?.data?.tweets) ? data.data
                : data;

        return {
            ok: true,
            status: res.status,
            tweets: Array.isArray(payload?.tweets) ? payload.tweets : [],
            hasNextPage: Boolean(payload?.has_next_page),
        };
    } catch (error) {
        const reason = error.name === 'AbortError' ? `timed out after ${API_TIMEOUT_MS}ms` : error.message;
        return { ok: false, status: 0, error: reason };
    } finally {
        clearTimeout(timeout);
    }
}

/** One line per distinct problem, rather than one per poll. */
function complainOnce(key, level, message, meta) {
    // The same two calls are the mirror's health signal, because they already
    // are its record of what is wrong. Reported on every poll rather than only
    // on the first, so the "since" clock keeps running: a key rejected forty
    // minutes ago should say so, not read as if it just happened.
    //
    // Never 'down', however bad it is. A mirror that has stopped is a feature
    // the server is missing, not a bot that cannot work, and if everything can
    // turn the dot red then red stops meaning anything.
    health.report('tweets', 'degraded', message.replace(/^\[TWEETS\]\s*/, ''));

    if (complained.has(key)) return;
    complained.add(key);
    logger[level](message, meta);
}

/**
 * Marks a class of problem as over, so that if it ever comes back it is
 * announced again. Scoped by prefix because the key carries the detail (which
 * status code, which channel) and any of them clearing means the same thing.
 */
function resolved(prefix) {
    for (const key of complained) {
        if (key.startsWith(prefix)) complained.delete(key);
    }
    // Only when the last complaint is gone: one fixed problem out of two is
    // not a working mirror.
    if (complained.size === 0) health.report('tweets', 'ok');
}

// ── The tick ────────────────────────────────────────────────────────────────

/**
 * One poll: read the cursor, ask for anything newer, post what nobody else
 * has posted, move the cursor.
 *
 * Never throws. Returns a summary so the command and the tests can see what
 * happened without reading the log.
 */
async function runOnce(client, { now = Date.now(), sleep } = {}) {
    const apiKey = process.env.TWITTERAPI_KEY;
    if (!apiKey) return { skipped: 'no TWITTERAPI_KEY set' };

    const channelId = await getSpeakConfigValue(CHANNEL_KEY, null);
    if (!channelId) return { skipped: 'no channel set' };
    if ((await getSpeakConfigValue(ENABLED_KEY, true)) === false) return { skipped: 'disabled' };

    const accounts = await getSpeakConfigValue(ACCOUNTS_KEY, DEFAULT_ACCOUNTS);
    if (!Array.isArray(accounts) || accounts.length === 0) return { skipped: 'no accounts set' };

    const budget = Number(await getSpeakConfigValue(BUDGET_KEY, DEFAULT_BUDGET_USD)) || DEFAULT_BUDGET_USD;
    const spend = await readSpend();
    if (spend.usd >= budget) {
        complainOnce(`budget:${spend.month}`, 'warn', '[TWEETS] Monthly budget reached, polling paused', {
            month: spend.month, spentUsd: spend.usd, budgetUsd: budget,
        });
        return { skipped: 'budget reached', spend, budget };
    }
    resolved('budget:');

    // The cursor, clamped so a long outage cannot turn into a flood or a bill.
    const stored = Number(await getSpeakConfigValue(SINCE_KEY, 0)) || 0;
    const sinceMs = Math.max(stored || (now - FIRST_RUN_LOOKBACK_MS), now - MAX_LOOKBACK_MS);

    const query = buildQuery(accounts, sinceMs / 1000);
    if (!query) {
        complainOnce('handles', 'error', '[TWEETS] No usable handles configured', { accounts });
        return { skipped: 'no valid handles' };
    }
    resolved('handles');

    const result = await searchTweets({ apiKey, query });

    if (!result.ok) {
        // A rejected key is the one failure that never fixes itself, so it
        // stops the poller instead of burning a request every ten minutes.
        if (result.status === 401 || result.status === 403) {
            await setSpeakConfigValue(ENABLED_KEY, false);
            complainOnce('auth', 'error', '[TWEETS] API key rejected, mirror disabled', {
                status: result.status, error: result.error,
            });
            return { skipped: 'api key rejected', status: result.status };
        }
        // Everything else is weather: rate limits, blips, timeouts.
        complainOnce(`http:${result.status}`, 'warn', '[TWEETS] Poll failed', {
            status: result.status, error: result.error,
        });
        return { skipped: 'request failed', status: result.status, error: result.error };
    }

    // 'auth' too: a key that was rejected, fixed, and then rejected again
    // would otherwise stay silent the second time, which is exactly when
    // being told matters.
    resolved('http:');
    resolved('auth');
    const newSpend = await recordSpend(result.tweets.length);

    const found = result.tweets
        .map(normalizeTweet)
        .filter(Boolean)
        .sort((a, b) => a.atMs - b.atMs);

    if (found.length === 0) {
        await setSpeakConfigValue(SINCE_KEY, now);
        return { posted: 0, found: 0, spend: newSpend };
    }

    // Keep the newest when a burst overflows, but deliver oldest first so the
    // channel reads in the order things happened.
    const selected = found.slice(-MAX_POSTS_PER_TICK);
    const dropped = found.length - selected.length;

    // Believed only on a full page: see SEARCH_PAGE_SIZE. Taking the flag at
    // face value made this warn on every poll that found a single post, and
    // it announced "older ones skipped" while reporting that it had skipped
    // none, which is the sort of line that teaches you to stop reading logs.
    const trulyMorePages = result.hasNextPage && result.tweets.length >= SEARCH_PAGE_SIZE;

    if (dropped > 0 || trulyMorePages) {
        logger.warn('[TWEETS] Some posts in this window will not be delivered', {
            found: found.length, posting: selected.length, dropped,
            returned: result.tweets.length, morePages: trulyMorePages,
        });
    }

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) {
        complainOnce(`channel:${channelId}`, 'error', '[TWEETS] Channel missing or not a text channel', { channelId });
        return { skipped: 'channel unreachable', channelId, spend: newSpend };
    }
    resolved('channel:');

    const style = await getSpeakConfigValue(STYLE_KEY, DEFAULT_STYLE);
    let posted = 0;
    /** Exposed so callers that care (the tests) can wait for the repair pass. */
    let verification = null;

    const delivered = [];
    const failed = [];
    for (const tweet of selected) {
        // The claim is what makes two overlapping containers safe, and it has
        // to happen before the send: claiming after would let both post first.
        if (!(await claimTweet(tweet.id))) continue;
        try {
            const message = await channel.send(style === 'embed'
                ? { embeds: [renderEmbed(tweet)] }
                : { content: linkFor(tweet.handle, tweet.id, LINK_HOSTS[0]) });
            posted += 1;
            // Guarded rather than assumed: it is already on screen by now, so
            // anything odd about the returned object is a bookkeeping problem,
            // and letting it throw would log a successful post as a failure.
            if (message?.id) {
                delivered.push({ tweet, message });
                // So that replying to this post does not wake the bot up.
                recordMirrorMessage(tweet.id, message.id)
                    .catch(e => logger.warn('[TWEETS] Could not record message id', { error: e.message }));
            }
        } catch (error) {
            // Hand the claim back and hold the cursor short of this post, so
            // the next poll gets to try again. Without that pair, the single
            // most likely failure here (pointed at a channel the bot cannot
            // type in) silently drops every post while the panel keeps
            // reporting a healthy, spending mirror.
            failed.push(tweet);
            await releaseTweet(tweet.id).catch(() => {});
            logger.error('[TWEETS] Could not post', { tweetId: tweet.id, error: error.message });
        }
    }

    // After everything is on screen, and deliberately not awaited: this is
    // seconds of waiting per message, and none of it should hold up the next
    // post or the cursor write below. Losing it to a shutdown costs nothing,
    // because the un-repaired state is the one that works nearly always.
    if (style !== 'embed' && delivered.length) {
        verification = Promise.all(delivered.map(d =>
            repairEmbed(channel, d.tweet, d.message, { sleep }).catch(e =>
                logger.warn('[TWEETS] Embed check failed', { tweetId: d.tweet.id, error: e.message }))
        ));
    }

    // Normally to the newest thing seen: anything older was delivered,
    // deliberately dropped, or claimed by the other container, and none of
    // those wants looking at again.
    //
    // When a send failed, the cursor stops just short of the oldest failure
    // instead, so the next poll refetches it. That window cannot grow without
    // bound because the lookback clamp above outruns it after two hours, which
    // is what keeps a permanently unpostable tweet from wedging the mirror
    // forever while still giving a transient failure several chances.
    const oldestFailure = failed.length
        ? failed.reduce((a, b) => (a.atMs <= b.atMs ? a : b))
        : null;
    if (oldestFailure) {
        complainOnce(`send:${channelId}`, 'error', '[TWEETS] Posting failed; holding the cursor so nothing is lost', {
            channelId, failed: failed.length, posted,
        });
    } else {
        resolved('send:');
    }
    await setSpeakConfigValue(
        SINCE_KEY,
        oldestFailure ? oldestFailure.atMs - 1 : found[found.length - 1].atMs
    );

    if (posted > 0) {
        logger.info('[TWEETS] Posted', { posted, found: found.length, spentUsd: newSpend.usd });
        await recordPosted(posted).catch(() => { /* bookkeeping, never the tick */ });
        pruneMirroredTweets().catch(e => logger.warn('[TWEETS] Prune failed', { error: e.message }));
    }

    return { posted, found: found.length, dropped, spend: newSpend, verification };
}

// ── Proving it works ────────────────────────────────────────────────────────

/**
 * Fetches a deliberately wide window so there is certainly something to find,
 * and reports what came back.
 *
 * This exists because "0 posts fetched" is both what a working mirror looks
 * like on a quiet quarter hour and what a broken one looks like forever, and
 * twitterapi.io's own call log does not distinguish them either: it showed no
 * calls at all for a request that had demonstrably been billed.
 *
 * Deliberately does not move the cursor and does not claim anything, so it
 * cannot eat a post the real poller would have made. It does record the
 * spend, because the money is just as real as any other request.
 *
 * @returns {Promise<object>} what it found, or why it could not look
 */
async function testFetch({ hoursBack = 6 } = {}) {
    const apiKey = process.env.TWITTERAPI_KEY;
    if (!apiKey) return { ok: false, reason: 'no TWITTERAPI_KEY set' };

    const accounts = await getSpeakConfigValue(ACCOUNTS_KEY, DEFAULT_ACCOUNTS);
    if (!Array.isArray(accounts) || accounts.length === 0) return { ok: false, reason: 'no accounts set' };

    const budget = Number(await getSpeakConfigValue(BUDGET_KEY, DEFAULT_BUDGET_USD)) || DEFAULT_BUDGET_USD;
    const spend = await readSpend();
    if (spend.usd >= budget) return { ok: false, reason: 'budget reached' };

    const sinceMs = Date.now() - hoursBack * 60 * 60 * 1000;
    const query = buildQuery(accounts, sinceMs / 1000);
    if (!query) return { ok: false, reason: 'no usable handles (letters, numbers and _ only, max 15)' };

    const result = await searchTweets({ apiKey, query });

    if (!result.ok) {
        return { ok: false, reason: `request failed (${result.status})`, error: result.error, query };
    }

    const newSpend = await recordSpend(result.tweets.length);
    const found = result.tweets.map(normalizeTweet).filter(Boolean).sort((a, b) => b.atMs - a.atMs);

    // Per handle, because "12 tweets" could still be one account working and
    // two silently misspelled.
    const perAccount = {};
    for (const t of found) perAccount[t.handle] = (perAccount[t.handle] ?? 0) + 1;

    // X handles are case-insensitive and the API answers in the account's own
    // casing, so a watch list entry of "shiinabr" would never match the
    // "ShiinaBR" that comes back, and a perfectly healthy account would be
    // reported as silent every single time.
    const answered = new Set(Object.keys(perAccount).map(h => h.toLowerCase()));

    return {
        ok: true,
        hoursBack,
        query,
        raw: result.tweets.length,
        found: found.length,
        perAccount,
        // Which of the watched handles returned nothing. A silent account is
        // usually just quiet, but it is also what a typo looks like, and the
        // caller cannot tell the two apart without knowing who was asked.
        silent: accounts
            .map(a => String(a).trim().replace(/^@/, ''))
            .filter(a => a && !answered.has(a.toLowerCase())),
        // Saying "found 20" without saying there were more turns a truncated
        // sample into a wrong answer. Saying "found 7+" when seven is the
        // whole truth is the same disease pointing the other way, which is
        // what a bare has_next_page produced: the panel put a "+" on every
        // check it ever ran. Only a full page can have more behind it.
        more: Boolean(result.hasNextPage) && result.tweets.length >= SEARCH_PAGE_SIZE,
        newest: found[0] ?? null,
        // What THIS request cost, kept separate from the running total. The
        // two are trivially confusable and one of them is the number that
        // answers "should I be worried".
        callUsd: Math.max(1, result.tweets.length) * COST_PER_UNIT_USD,
        budgetUsd: budget,
        spend: newSpend,
    };
}

// ── Scheduling ──────────────────────────────────────────────────────────────

function startTweetMirror(client) {
    if (timer) return;

    const tick = () => {
        runOnce(client).catch(e => logger.error('[TWEETS] Poll threw', { error: e.message }));
    };

    timer = setInterval(tick, POLL_INTERVAL_MS);
    timer.unref();
    firstTimer = setTimeout(tick, FIRST_POLL_DELAY_MS);
    firstTimer.unref();

    logger.info('[TWEETS] Mirror scheduled', { everyMinutes: POLL_INTERVAL_MS / 60000 });
}

function stopTweetMirror() {
    if (timer) { clearInterval(timer); timer = null; }
    if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
}

/** Everything the /tweets_settings panel needs, in one read. */
async function mirrorStatus({ refreshBalance = false } = {}) {
    const [channelId, enabled, accounts, since, budget, style] = await Promise.all([
        getSpeakConfigValue(CHANNEL_KEY, null),
        getSpeakConfigValue(ENABLED_KEY, true),
        getSpeakConfigValue(ACCOUNTS_KEY, DEFAULT_ACCOUNTS),
        getSpeakConfigValue(SINCE_KEY, 0),
        getSpeakConfigValue(BUDGET_KEY, DEFAULT_BUDGET_USD),
        getSpeakConfigValue(STYLE_KEY, DEFAULT_STYLE),
    ]);
    const spend = await readSpend();

    // What a full month at the current interval costs if nothing is ever
    // found, which is the floor the bill cannot go below.
    const pollsPerMonth = (30 * 24 * 60 * 60 * 1000) / POLL_INTERVAL_MS;

    // One call, only when somebody is looking at the panel, and cached for
    // five minutes so the Refresh button cannot turn into a poller.
    const balance = await accountBalance(process.env.TWITTERAPI_KEY, { force: refreshBalance })
        .catch(() => null);

    return {
        hasKey: Boolean(process.env.TWITTERAPI_KEY),
        channelId: channelId || null,
        enabled: enabled !== false,
        accounts: Array.isArray(accounts) ? accounts : DEFAULT_ACCOUNTS,
        sinceMs: Number(since) || 0,
        budgetUsd: Number(budget) || DEFAULT_BUDGET_USD,
        style: style === 'embed' ? 'embed' : 'link',
        spend,
        balance,
        running: Boolean(timer),
        intervalMs: POLL_INTERVAL_MS,
        floorUsdPerMonth: Number((pollsPerMonth * COST_PER_UNIT_USD).toFixed(2)),
    };
}

module.exports = {
    startTweetMirror,
    stopTweetMirror,
    runOnce,
    testFetch,
    mirrorStatus,
    buildQuery,
    normalizeTweet,
    renderEmbed,
    repairEmbed,
    embedLanded,
    linkFor,
    LINK_HOSTS,
    EMBED_GRACE_MS,
    readSpend,
    recordSpend,
    recordPosted,
    accountBalance,
    monthKey,
    BALANCE_KEY,
    CHANNEL_KEY,
    ENABLED_KEY,
    ACCOUNTS_KEY,
    SINCE_KEY,
    SPEND_KEY,
    BUDGET_KEY,
    STYLE_KEY,
    DEFAULT_ACCOUNTS,
    DEFAULT_BUDGET_USD,
    POLL_INTERVAL_MS,
    MAX_POSTS_PER_TICK,
    SEARCH_PAGE_SIZE,
    MAX_LOOKBACK_MS,
    COST_PER_UNIT_USD,
    CREDITS_PER_USD,
    CREDITS_PER_UNIT,
};
