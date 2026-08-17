// tests/mediaExpressions.test.js
//
// /flip was aimed at a custom emoji somebody had just posted and came back
// with a photo from further up the channel, flipped, with no hint that it had
// missed. The scanner reads attachments and embeds; an emoji lives in the
// message content and a sticker in its own field, so both were invisible and
// the walk simply continued into older messages.
//
// Answering with the wrong picture is worse than answering with none, because
// nothing about the reply says it went looking and lost.

const {
    fetchRecentMedia, stickerUrl, jumboEmojiUrl,
} = require('../src/utils/media/mediaHelpers');

const EMOJI = '<:trustinus:1234567890123456789>';
const ANIMATED = '<a:spin:9876543210987654321>';

const message = over => ({ content: '', attachments: new Map(), embeds: [], ...over });
const interactionWith = messages => ({
    channel: { messages: { fetch: jest.fn().mockResolvedValue(new Map(messages.map((m, i) => [String(i), m]))) } },
});
const attached = url => message({
    attachments: new Map([['1', { url, contentType: 'image/png', proxyURL: null }]]),
});

describe('an emoji posted on its own is a picture', () => {
    test('the newest message wins even when it is only an emoji', async () => {
        // The bug, exactly: newest first, and the emoji must not be skipped in
        // favour of the photo two messages down.
        const info = await fetchRecentMedia(interactionWith([
            message({ content: EMOJI }),
            message({ content: 'He wouldnt have done it if he didnt trust in us' }),
            attached('https://cdn.discordapp.com/attachments/1/2/mug-guy.png'),
        ]), { allowImage: true });

        expect(info?.url).toBe('https://cdn.discordapp.com/emojis/1234567890123456789.png');
    });

    test('an animated one is fetched as a gif, so it stays animated', () => {
        expect(jumboEmojiUrl(ANIMATED)).toBe('https://cdn.discordapp.com/emojis/9876543210987654321.gif');
        expect(jumboEmojiUrl(EMOJI)).toBe('https://cdn.discordapp.com/emojis/1234567890123456789.png');
    });

    test('emoji inside a sentence is punctuation, not media', async () => {
        // The whole reason for the rule. Otherwise every "lol <:kek:1>" in a
        // busy channel steals the target from the image somebody posted.
        expect(jumboEmojiUrl(`lol ${EMOJI}`)).toBeNull();
        expect(jumboEmojiUrl(`${EMOJI} ok`)).toBeNull();

        const info = await fetchRecentMedia(interactionWith([
            message({ content: `lol ${EMOJI}` }),
            attached('https://cdn.discordapp.com/attachments/1/2/mug-guy.png'),
        ]), { allowImage: true });
        expect(info?.url).toContain('mug-guy.png');
    });

    test('emoji beside other emoji is still just emoji', () => {
        // Discord renders these large too, which is the line being copied.
        expect(jumboEmojiUrl(`${EMOJI} ${ANIMATED}`)).toContain('1234567890123456789');
        expect(jumboEmojiUrl(`\u{1F62D} ${EMOJI}`)).toContain('1234567890123456789');
        expect(jumboEmojiUrl(`\u{1F44D}\u{1F3FD} ${EMOJI}`)).toContain('1234567890123456789');
        expect(jumboEmojiUrl(`\u{1F1EB}\u{1F1F7} ${EMOJI}`)).toContain('1234567890123456789');
        // A ZWJ sequence with a variation selector: one glyph, several codepoints.
        expect(jumboEmojiUrl(`\u{1F468}\u200D\u2764\uFE0F\u200D\u{1F468} ${EMOJI}`)).toContain('1234567890123456789');
    });

    test('text without any custom emoji is left alone', () => {
        expect(jumboEmojiUrl('just talking')).toBeNull();
        expect(jumboEmojiUrl('\u{1F62D}')).toBeNull(); // Unicode only: nothing to fetch
        expect(jumboEmojiUrl('')).toBeNull();
        expect(jumboEmojiUrl(null)).toBeNull();
        expect(jumboEmojiUrl(undefined)).toBeNull();
    });

    test('a lookalike token is not an emoji', () => {
        // The id length and name shape are Discord's; anything else is text
        // that happens to have angle brackets in it.
        expect(jumboEmojiUrl('<:x:123>')).toBeNull();
        expect(jumboEmojiUrl('<:name with spaces:1234567890123456789>')).toBeNull();
        expect(jumboEmojiUrl('<:trustinus:>')).toBeNull();
    });
});

describe('a sticker is a picture too', () => {
    test('each format Discord will serve as an image gets a url', () => {
        expect(stickerUrl({ id: '42', format: 1 })).toBe('https://cdn.discordapp.com/stickers/42.png');
        expect(stickerUrl({ id: '42', format: 2 })).toBe('https://cdn.discordapp.com/stickers/42.png');
        expect(stickerUrl({ id: '42', format: 4 })).toBe('https://cdn.discordapp.com/stickers/42.gif');
    });

    test('a Lottie sticker is vector json, so it is skipped rather than fetched', () => {
        expect(stickerUrl({ id: '42', format: 3 })).toBeNull();
        expect(stickerUrl({ id: '42' })).toBeNull();
        expect(stickerUrl(null)).toBeNull();
    });

    test('the scanner finds one, and a Lottie one does not stop the walk', async () => {
        const found = await fetchRecentMedia(interactionWith([
            message({ stickers: new Map([['1', { id: '555', format: 4 }]]) }),
        ]), { allowImage: true });
        expect(found?.url).toBe('https://cdn.discordapp.com/stickers/555.gif');

        const past = await fetchRecentMedia(interactionWith([
            message({ stickers: new Map([['1', { id: '555', format: 3 }]]) }),
            attached('https://cdn.discordapp.com/attachments/1/2/mug-guy.png'),
        ]), { allowImage: true });
        expect(past?.url).toContain('mug-guy.png');
    });
});

describe('the rest of the scan is unchanged', () => {
    test('an attachment on the same message still outranks a sticker', async () => {
        const info = await fetchRecentMedia(interactionWith([
            message({
                attachments: new Map([['1', { url: 'https://example.com/a.png', contentType: 'image/png' }]]),
                stickers: new Map([['1', { id: '555', format: 1 }]]),
            }),
        ]), { allowImage: true });
        expect(info?.url).toBe('https://example.com/a.png');
    });

    test('a command that wants video only walks past both', async () => {
        const info = await fetchRecentMedia(interactionWith([
            message({ content: EMOJI }),
            message({ stickers: new Map([['1', { id: '555', format: 1 }]]) }),
            message({ attachments: new Map([['1', { url: 'https://example.com/a.mp4', contentType: 'video/mp4' }]]) }),
        ]), { allowImage: false, allowVideo: true, allowGifLikeVideo: false });
        expect(info?.ext).toBe('mp4');
    });

    test('a predicate still gets the last word on both', async () => {
        const info = await fetchRecentMedia(interactionWith([
            message({ content: EMOJI }),
            attached('https://cdn.discordapp.com/attachments/1/2/mug-guy.png'),
        ]), { allowImage: true, mediaPredicate: i => !i.url.includes('/emojis/') });
        expect(info?.url).toContain('mug-guy.png');
    });

    test('a forwarded sticker or emoji is seen inside the snapshot', async () => {
        const snapshot = message({ content: EMOJI });
        const info = await fetchRecentMedia(interactionWith([
            message({ messageSnapshots: new Map([['0', snapshot]]) }),
        ]), { allowImage: true });
        expect(info?.url).toContain('/emojis/1234567890123456789.png');
    });
});
