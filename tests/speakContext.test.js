// tests/speakContext.test.js
//
// The chat log is the only account the model gets of who said what, so its
// one job is unambiguous attribution. The bug these pin: the reply note used
// to sit between a speaker and their own words, so
//   Moksi [replying to Cooler Moksi: "..."]: FUCK OFF
// put the bot's name directly against words the bot never said, and the bot
// answered "cooler moksi already told me that" about a line it had just been
// sworn at with.

const { buildReplyMarker, describeNonTextPayload } = require('../src/commands/tools/speak');

const BOT = 'bot-1';

const message = ({ id = 'm1', authorId = 'u1', name = 'Moksi', content = '', reference = null }) => ({
    id,
    author: { id: authorId, username: name, bot: authorId === BOT },
    member: { displayName: name },
    content,
    reference,
    embeds: [],
    attachments: new Map(),
});

describe('reply markers', () => {
    test('the bot is "you", so it cannot read its own line as a stranger', () => {
        const target = message({ id: 'm0', authorId: BOT, name: 'Cooler Moksi', content: 'you are broke' });
        const reply = message({ id: 'm1', content: 'FUCK OFF', reference: { messageId: 'm0' } });
        const marker = buildReplyMarker(reply, new Map([['m0', target]]), BOT);

        expect(marker).toContain('in reply to you');
        expect(marker).toContain('you are broke');
        expect(marker).not.toContain('Cooler Moksi');
    });

    test('another bot is not "you": Dyno keeps its own words', () => {
        const dyno = message({ id: 'm0', authorId: 'dyno', name: 'Dyno', content: 'user was warned' });
        const reply = message({ id: 'm1', content: 'good', reference: { messageId: 'm0' } });
        const marker = buildReplyMarker(reply, new Map([['m0', dyno]]), BOT);

        expect(marker).toContain('in reply to Dyno');
        expect(marker).not.toContain('you');
    });

    test('a message with no reply gets no marker at all', () => {
        expect(buildReplyMarker(message({}), new Map(), BOT)).toBe('');
    });

    test('a reply to something outside the window says so without inventing a quote', () => {
        const reply = message({ reference: { messageId: 'gone' } });
        expect(buildReplyMarker(reply, new Map(), BOT)).toBe(' (in reply to an earlier message)');
    });

    test('the quote is a parenthetical, never a "Name:" that could pass for a speaker', () => {
        const target = message({ id: 'm0', authorId: 'u2', name: 'Ada', content: 'i won' });
        const reply = message({ id: 'm1', content: 'no you did not', reference: { messageId: 'm0' } });
        const marker = buildReplyMarker(reply, new Map([['m0', target]]), BOT);

        // The old format opened with "[replying to Ada:" which, once the line
        // was assembled, sat immediately before the replier's own words.
        expect(marker).not.toContain('[replying to');
        expect(marker.startsWith(' (in reply to Ada:')).toBe(true);
    });

    test('a blackjack hand is legible to the model, not just to a human', () => {
        // The bot's own game output carries no message content at all; it is
        // entirely embed. If this stops rendering, the bot reacts to a hand it
        // cannot actually see, which reads as it being obtuse rather than blind.
        const hand = {
            embeds: [{
                title: 'Blackjack',
                description: '**-$120,000** on this hand.',
                fields: [
                    { name: 'Dealer (9)', value: '5S 4D' },
                    { name: 'Your hand (23)', value: '5D 6D 2D JC\nBust' },
                    { name: 'Balance', value: '$566' },
                ],
                footer: { text: 'This session: -$30,000' },
            }],
            attachments: new Map(),
        };
        const seen = describeNonTextPayload(hand, 600);

        for (const fact of ['-$120,000', 'Bust', 'Balance: $566', 'This session: -$30,000']) {
            expect(seen).toContain(fact);
        }
    });

    test('a long quote is truncated rather than swallowing the line', () => {
        const target = message({ id: 'm0', authorId: 'u2', name: 'Ada', content: 'x'.repeat(400) });
        const reply = message({ id: 'm1', content: 'sure', reference: { messageId: 'm0' } });
        const marker = buildReplyMarker(reply, new Map([['m0', target]]), BOT);

        expect(marker).toContain('...');
        expect(marker.length).toBeLessThan(220);
    });
});
