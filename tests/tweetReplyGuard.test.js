// tests/tweetReplyGuard.test.js
//
// Replying to one of the bot's messages is how you talk to it without pinging.
// That rule was written for conversation, and the tweet mirror broke its
// assumption: it posts unprompted into a feed channel, so a reply to one of
// those is somebody reacting to a leak, not addressing the bot. Answering is
// butting into a conversation it was never part of.
//
// The fix has to be narrow. Muting the whole channel would also kill the case
// where somebody genuinely does want the bot, so what is pinned here is that
// exactly one path goes quiet and the others still work.

jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/utils/joinGate/enforcement', () => ({ handleWatchedMessage: jest.fn(async () => {}) }));
jest.mock('../src/utils/joinGate/activity', () => ({ noteMessage: jest.fn() }));
jest.mock('../src/utils/interjections', () => ({ shouldInterject: jest.fn(async () => ({ ok: false, scout: null })) }));
jest.mock('../src/utils/db', () => ({ isMirrorMessage: jest.fn(async () => false) }));

const { isMirrorMessage } = require('../src/utils/db');
const { shouldInterject } = require('../src/utils/interjections');
const handler = require('../src/events/client/messageCreate');

const BOT = 'bot-1';
const HUMAN = 'human-1';

let speak;
let client;

beforeEach(() => {
    jest.clearAllMocks();
    speak = { execute: jest.fn(async () => {}) };
    client = { user: { id: BOT }, commands: new Map([['speak', speak]]) };
});

/**
 * A message in a guild, modelling one detail Discord gets right and this
 * codebase once got wrong: replying to somebody with the ping left on (the
 * DEFAULT) puts them in `mentions.users` without a single character of the
 * mention appearing in the content.
 *
 * So `repliesTo` alone already implies a pinged mention in the collection.
 * `replyPing: false` is the user having toggled the ping off, and a typed
 * mention is what it is in real life: the token, in the text.
 */
function message({ repliesTo = null, replyPing = true, content = 'no way' } = {}) {
    const cache = new Map();
    if (repliesTo) cache.set(repliesTo.id, repliesTo);

    const pinged = new Set();
    if (repliesTo && replyPing) pinged.add(repliesTo.author.id);
    for (const [, id] of String(content).matchAll(/<@!?([^>]+)>/g)) pinged.add(id);

    return {
        content,
        author: { bot: false, id: HUMAN, username: 'someone' },
        member: { displayName: 'someone' },
        guild: { id: 'g1' },
        mentions: { users: { has: id => pinged.has(id) } },
        reference: repliesTo ? { messageId: repliesTo.id } : null,
        channel: {
            id: 'c1',
            messages: { cache, fetch: jest.fn(async () => null) },
            sendTyping: jest.fn(async () => {}),
            send: jest.fn(async () => ({ id: 'sent' })),
        },
    };
}

const botMessage = (id, content = 'something conversational') => ({ id, author: { id: BOT }, content });

describe('replying to a mirrored tweet', () => {
    test('does not wake the bot, with the reply ping left on as Discord defaults it', async () => {
        // The regression that reached production: the ping put the bot in
        // mentions.users, that read as "they @ed me", and the guard below was
        // skipped entirely. Someone said "thats cool" to a leak embed and the
        // bot answered them.
        isMirrorMessage.mockResolvedValue(true);

        await handler.execute(message({ repliesTo: botMessage('m-tweet'), replyPing: true }), client);

        expect(speak.execute).not.toHaveBeenCalled();
    });

    test('does not wake the bot with the ping toggled off either', async () => {
        isMirrorMessage.mockResolvedValue(true);

        await handler.execute(message({ repliesTo: botMessage('m-tweet'), replyPing: false }), client);

        expect(speak.execute).not.toHaveBeenCalled();
    });

    test('still wakes it if they actually type its name, which is unambiguous', async () => {
        isMirrorMessage.mockResolvedValue(true);

        await handler.execute(
            message({ repliesTo: botMessage('m-tweet'), content: `<@${BOT}> thoughts` }), client);

        expect(speak.execute).toHaveBeenCalled();
        // A typed mention short-circuits before the lookup is needed.
        expect(isMirrorMessage).not.toHaveBeenCalled();
    });
});

describe('what must keep working', () => {
    test('replying to an ordinary bot message still starts a conversation', async () => {
        isMirrorMessage.mockResolvedValue(false);

        await handler.execute(message({ repliesTo: botMessage('m-chat') }), client);

        expect(speak.execute).toHaveBeenCalled();
    });

    test('replying to another human is still none of the bot’s business', async () => {
        const human = { id: 'm-human', author: { id: 'someone-else' } };
        await handler.execute(message({ repliesTo: human }), client);

        expect(speak.execute).not.toHaveBeenCalled();
        // Not the bot's message, so there is nothing to look up.
        expect(isMirrorMessage).not.toHaveBeenCalled();
    });

    test('a database failure leaves conversation working rather than breaking it', async () => {
        // Defaulting to silence would make every reply stop working the moment
        // Postgres blinked, which is far worse than one unwanted answer.
        isMirrorMessage.mockRejectedValue(new Error('connection terminated'));

        await handler.execute(message({ repliesTo: botMessage('m-chat') }), client);

        expect(speak.execute).toHaveBeenCalled();
    });

    test('an interjection can still fire, since that gate is configured separately', async () => {
        isMirrorMessage.mockResolvedValue(true);
        shouldInterject.mockResolvedValue({ ok: true, scout: { worth: 9 } });

        await handler.execute(message({ repliesTo: botMessage('m-tweet') }), client);

        // Interjections only run in channels explicitly listed by the owner,
        // so reaching this point is a choice that was already made.
        expect(speak.execute).toHaveBeenCalled();
    });
});

describe('the request text the bot actually reads', () => {
    // The ping at the head of a message is scaffolding; a ping in the middle
    // is a word in the sentence. Deleting the latter left "as in when types
    // in it": a hole where the subject was, and the model's reasoning on one
    // traced reply literally pointed at the gap. The name goes there instead.
    const request = () => speak.execute.mock.calls[0][0].options.getString('request');

    test('a leading summon ping is stripped clean', async () => {
        await handler.execute(message({ content: `<@${BOT}> hello there` }), client);
        expect(request()).toBe('hello there');
    });

    test('a mid-sentence ping becomes the bot\'s name, not a hole', async () => {
        await handler.execute(
            message({ content: `as in when <@${BOT}> types in it` }), client);
        expect(request()).toBe('as in when @Cooler Moksi types in it');
    });

    test('the nickname mention form gets the same treatment', async () => {
        await handler.execute(
            message({ content: `ping me when <@!${BOT}> posts` }), client);
        expect(request()).toBe('ping me when @Cooler Moksi posts');
    });

    test('a bare ping still reads as an empty request', async () => {
        await handler.execute(message({ content: `<@${BOT}>` }), client);
        expect(request()).toBeNull();
    });

    test('replying to the bot conversationally still reaches speak, with no text mention', async () => {
        // The path the ping-based check used to serve for free. It now costs
        // one cache lookup and must still work: this is how most people talk
        // to the bot.
        isMirrorMessage.mockResolvedValue(false);

        await handler.execute(
            message({ repliesTo: botMessage('m-chat'), content: 'and what about tuesday' }), client);

        expect(speak.execute).toHaveBeenCalled();
        expect(request()).toBe('and what about tuesday');
    });
});
