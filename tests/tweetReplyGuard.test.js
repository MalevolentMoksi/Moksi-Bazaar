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
 * A message in a guild. `repliesTo` is the message it used Discord's reply
 * function on, `mentionsBot` whether it also pinged.
 */
function message({ repliesTo = null, mentionsBot = false, content = 'no way' } = {}) {
    const cache = new Map();
    if (repliesTo) cache.set(repliesTo.id, repliesTo);
    return {
        content,
        author: { bot: false, id: HUMAN, username: 'someone' },
        member: { displayName: 'someone' },
        guild: { id: 'g1' },
        mentions: { users: { has: id => mentionsBot && id === BOT } },
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
    test('does not wake the bot', async () => {
        isMirrorMessage.mockResolvedValue(true);

        await handler.execute(message({ repliesTo: botMessage('m-tweet') }), client);

        expect(speak.execute).not.toHaveBeenCalled();
    });

    test('still wakes it if they actually @ it, which is unambiguous', async () => {
        isMirrorMessage.mockResolvedValue(true);

        await handler.execute(message({ repliesTo: botMessage('m-tweet'), mentionsBot: true }), client);

        expect(speak.execute).toHaveBeenCalled();
        // The mention path never needs the lookup: it short-circuits before it.
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
        await handler.execute(message({ mentionsBot: true, content: `<@${BOT}> hello there` }), client);
        expect(request()).toBe('hello there');
    });

    test('a mid-sentence ping becomes the bot\'s name, not a hole', async () => {
        await handler.execute(
            message({ mentionsBot: true, content: `as in when <@${BOT}> types in it` }), client);
        expect(request()).toBe('as in when @Cooler Moksi types in it');
    });

    test('the nickname mention form gets the same treatment', async () => {
        await handler.execute(
            message({ mentionsBot: true, content: `ping me when <@!${BOT}> posts` }), client);
        expect(request()).toBe('ping me when @Cooler Moksi posts');
    });

    test('a bare ping still reads as an empty request', async () => {
        await handler.execute(message({ mentionsBot: true, content: `<@${BOT}>` }), client);
        expect(request()).toBeNull();
    });
});
