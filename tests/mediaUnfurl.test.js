// tests/mediaUnfurl.test.js
//
// A user posted a tenor link in reply to a mod panel; the bot answered
// "shinada using a knife as a screwdriver", a scene that exists nowhere in
// the GIF or the game. It had never seen the GIF. Discord unfurls links
// asynchronously, so a message read within a second or two of posting has no
// embed yet, the media pipeline finds nothing to describe, and the only
// "description" left in the writer's context is the URL slug
// "shinada-yakuza-5-knife-gif". One trace later the embed existed and vision
// described the real thing. Same GIF, one hallucination and one honest
// answer, minutes apart.
//
// Two layers pinned here: waitForUnfurl turns the race into a short,
// event-driven wait for exactly the messages that need it, and
// unresolvedGifTag tags a still-bare GIF link "contents not seen", which is
// the phrase the persona prompt already forbids inventing around.

const { EventEmitter } = require('events');
const { waitForUnfurl, unresolvedGifTag, hasVisibleMedia } = require('../src/commands/tools/speak');

/** A message as the unfurl race sees it: fresh, bare, link in hand. */
function bareLinkMessage(overrides = {}) {
    return {
        id: 'm1',
        content: 'https://tenor.com/view/shinada-yakuza-5-knife-gif-4650389813023754164',
        createdTimestamp: Date.now(),
        embeds: [],
        attachments: new Map(),
        stickers: new Map(),
        client: new EventEmitter(),
        ...overrides,
    };
}

describe('when the wait happens at all', () => {
    test('a message that already has its embed is returned untouched, instantly', async () => {
        const msg = bareLinkMessage({ embeds: [{ video: { url: 'x' } }] });
        await expect(waitForUnfurl(msg)).resolves.toBe(msg);
    });

    test('a message with no link has nothing to unfurl', async () => {
        const msg = bareLinkMessage({ content: 'just words' });
        await expect(waitForUnfurl(msg)).resolves.toBe(msg);
    });

    test('an old bare link is a link that will never unfurl; no wait', async () => {
        // If the embed has not arrived in 15 seconds it is not coming, and
        // spending the cap on every old link in a reply chain would tax every
        // reply for nothing.
        const msg = bareLinkMessage({ createdTimestamp: Date.now() - 60_000 });
        await expect(waitForUnfurl(msg)).resolves.toBe(msg);
    });

    test('something message-shaped but clientless cannot hang the pipeline', async () => {
        const msg = bareLinkMessage({ client: null });
        await expect(waitForUnfurl(msg)).resolves.toBe(msg);
    });
});

describe('the race itself', () => {
    test('resolves with the patched message the moment the unfurl lands', async () => {
        const msg = bareLinkMessage();
        const patched = { ...msg, embeds: [{ video: { url: 'https://media.tenor.com/x.mp4' } }] };

        const race = waitForUnfurl(msg, { capMs: 5_000 });
        msg.client.emit('messageUpdate', msg, patched);

        await expect(race).resolves.toBe(patched);
        // The listener must not outlive the wait: leak one per reply and the
        // emitter warning fires within an evening of chat.
        expect(msg.client.listenerCount('messageUpdate')).toBe(0);
    });

    test('an update for a different message is not the unfurl', async () => {
        const msg = bareLinkMessage();
        const other = bareLinkMessage({ id: 'someone-else', embeds: [{ image: { url: 'x' } }] });

        const race = waitForUnfurl(msg, { capMs: 40 });
        msg.client.emit('messageUpdate', other, other);

        // The wrong-id update is ignored; the cap returns the original.
        await expect(race).resolves.toBe(msg);
        expect(msg.client.listenerCount('messageUpdate')).toBe(0);
    });

    test('an update that still carries no media keeps the wait alive', async () => {
        // Edits to the text of the message arrive down the same event; only
        // the patch that actually brings an embed ends the wait early.
        const msg = bareLinkMessage();
        const textEdit = { ...msg, embeds: [] };
        const withEmbed = { ...msg, embeds: [{ image: { url: 'x' } }] };

        const race = waitForUnfurl(msg, { capMs: 5_000 });
        msg.client.emit('messageUpdate', msg, textEdit);
        msg.client.emit('messageUpdate', msg, withEmbed);

        await expect(race).resolves.toBe(withEmbed);
    });

    test('the cap gives the original back rather than waiting forever', async () => {
        const msg = bareLinkMessage();
        await expect(waitForUnfurl(msg, { capMs: 30 })).resolves.toBe(msg);
        expect(msg.client.listenerCount('messageUpdate')).toBe(0);
    });
});

describe('the honest tag for what never unfurled', () => {
    test('the exact production case: a bare tenor view link', () => {
        expect(unresolvedGifTag(bareLinkMessage()))
            .toBe(' [GIF link shared, contents not seen]');
    });

    test('giphy and klipy links get the same honesty', () => {
        expect(unresolvedGifTag(bareLinkMessage({ content: 'https://giphy.com/gifs/cat-spin-abc123' }))).not.toBe('');
        expect(unresolvedGifTag(bareLinkMessage({ content: 'https://klipy.com/gifs/ahh-noo' })))
            .not.toBe('');
    });

    test('once the embed exists the tag stays out of the way', () => {
        // The media pipeline owns described GIFs; a second tag saying "not
        // seen" under a real description would be the new lie.
        const msg = bareLinkMessage({ embeds: [{ video: { url: 'x' } }] });
        expect(unresolvedGifTag(msg)).toBe('');
    });

    test('ordinary links are not GIFs and get no tag', () => {
        for (const content of [
            'https://example.com/article',
            'https://youtube.com/watch?v=abc',
            'check https://discord.gg/xyz out',
            'no link at all',
            '',
        ]) {
            expect(unresolvedGifTag(bareLinkMessage({ content }))).toBe('');
        }
    });

    test('hasVisibleMedia sees all three media surfaces', () => {
        expect(hasVisibleMedia(bareLinkMessage())).toBe(false);
        expect(hasVisibleMedia(bareLinkMessage({ embeds: [{}] }))).toBe(true);
        expect(hasVisibleMedia(bareLinkMessage({ attachments: new Map([['a', {}]]) }))).toBe(true);
        expect(hasVisibleMedia(bareLinkMessage({ stickers: new Map([['s', {}]]) }))).toBe(true);
        expect(hasVisibleMedia(null)).toBe(false);
    });
});
