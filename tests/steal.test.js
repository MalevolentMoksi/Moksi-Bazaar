// tests/steal.test.js
//
// /steal and its right-click twin exist because the Vencord plugin that did
// this broke in a way worth not repeating: it derived each server's emoji
// capacity locally, the derivation silently returned undefined, and every
// `count < undefined` came back false. The result was not an error. It was an
// empty picker, which the user read as a missing button.
//
// So what is pinned here is mostly the reading and naming of expressions,
// where a wrong answer is quiet rather than loud. Nothing in this command
// predicts a limit, and there is a test below that says so, because the day
// somebody "optimises" it by pre-checking slots is the day it can rot the same
// way.

jest.mock('../src/utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { StickerFormatType, ApplicationCommandType } = require('discord.js');
const steal = require('../src/commands/media/steal');
const {
    collectExpressions, parseEmojiInput, sanitizeEmojiName,
    sanitizeStickerName, cdnUrlFor, describeFailure,
} = steal;

/** A message shaped the way discord.js hands one over. */
function messageLike({ content = '', reactions = [], stickers = [] } = {}) {
    return {
        content,
        reactions: { cache: new Map(reactions.map((r, i) => [String(i), r])) },
        stickers: new Map(stickers.map(s => [s.id, s])),
    };
}

const reaction = emoji => ({ emoji });

describe('what it finds on a message', () => {
    test('custom emoji typed into the text, static and animated', () => {
        const found = collectExpressions(messageLike({
            content: 'hello <:pepega:123456789012345678> and <a:kekw:876543210987654321>',
        }));

        expect(found).toEqual([
            { kind: 'emoji', id: '123456789012345678', name: 'pepega', animated: false },
            { kind: 'emoji', id: '876543210987654321', name: 'kekw', animated: true },
        ]);
    });

    test('emoji that only ever appear as reactions', () => {
        // The whole reason this scope was chosen: the interesting emoji is
        // often the one somebody reacted with, never typed.
        const found = collectExpressions(messageLike({
            content: 'no emoji here at all',
            reactions: [reaction({ id: '111111111111111111', name: 'monkaS', animated: false })],
        }));

        expect(found).toEqual([
            { kind: 'emoji', id: '111111111111111111', name: 'monkaS', animated: false },
        ]);
    });

    test('unicode reactions are passed over rather than failed', () => {
        // They have no id because there is nothing to clone: they already work
        // in every server on Discord. Listing them as failures would be noise.
        const found = collectExpressions(messageLike({
            reactions: [
                reaction({ id: null, name: '👍', animated: false }),
                reaction({ id: '222222222222222222', name: 'real', animated: true }),
            ],
        }));

        expect(found).toEqual([
            { kind: 'emoji', id: '222222222222222222', name: 'real', animated: true },
        ]);
    });

    test('stickers come with the fields Discord demands back', () => {
        const found = collectExpressions(messageLike({
            stickers: [{
                id: '333333333333333333', name: 'wave', format: StickerFormatType.PNG,
                tags: 'waving', description: 'a wave',
            }],
        }));

        expect(found).toEqual([{
            kind: 'sticker', id: '333333333333333333', name: 'wave',
            format: StickerFormatType.PNG, tags: 'waving', description: 'a wave',
        }]);
    });

    test('the same emoji typed and reacted with is taken once', () => {
        const found = collectExpressions(messageLike({
            content: '<:dupe:444444444444444444>',
            reactions: [reaction({ id: '444444444444444444', name: 'dupe', animated: false })],
        }));

        expect(found).toHaveLength(1);
    });

    test('all three sources at once', () => {
        const found = collectExpressions(messageLike({
            content: '<:a_one:100000000000000001>',
            reactions: [reaction({ id: '100000000000000002', name: 'two', animated: true })],
            stickers: [{ id: '100000000000000003', name: 'three', format: StickerFormatType.GIF }],
        }));

        expect(found.map(e => e.id)).toEqual([
            '100000000000000001', '100000000000000002', '100000000000000003',
        ]);
    });

    test('reading the same message twice gives the same answer', () => {
        // collectExpressions walks a module-level /g regex. matchAll is
        // specified to work on a copy, but a lastIndex that leaked between
        // calls would show up here as a second read finding nothing, and that
        // failure would be maddening to chase from a bug report.
        const message = messageLike({ content: '<:sticky:555555555555555555>' });
        expect(collectExpressions(message)).toEqual(collectExpressions(message));
        expect(collectExpressions(message)).toHaveLength(1);
    });

    test('an empty or malformed message is empty, not a throw', () => {
        for (const message of [messageLike(), {}, null, undefined, { content: 'plain text 🙂' }]) {
            expect(collectExpressions(message)).toEqual([]);
        }
    });
});

describe('naming the copy', () => {
    test('ordinary names survive intact', () => {
        expect(sanitizeEmojiName('pepega')).toBe('pepega');
        expect(sanitizeEmojiName('Bonk_2')).toBe('Bonk_2');
    });

    test("FakeNitro's bookkeeping suffix is dropped", () => {
        // FakeNitro appends ~1 so it can tell its own copies apart. Carrying
        // that into a real server would be inheriting somebody else's notes.
        expect(sanitizeEmojiName('pepega~1')).toBe('pepega');
    });

    test('characters Discord refuses are stripped', () => {
        expect(sanitizeEmojiName('hello world!')).toBe('helloworld');
        expect(sanitizeEmojiName('a-b-c')).toBe('abc');
    });

    test('a name too short to be legal is padded rather than rejected', () => {
        // Discord's floor is 2 characters. Failing the upload over this would
        // be a silly way to lose an emoji.
        expect(sanitizeEmojiName('x').length).toBeGreaterThanOrEqual(2);
        expect(sanitizeEmojiName('')).toMatch(/^\w{2,32}$/);
        expect(sanitizeEmojiName('!!!')).toMatch(/^\w{2,32}$/);
        expect(sanitizeEmojiName(null)).toMatch(/^\w{2,32}$/);
    });

    test('a name too long is cut to the ceiling', () => {
        expect(sanitizeEmojiName('z'.repeat(80))).toHaveLength(32);
    });

    test('sticker names keep what emoji names may not', () => {
        expect(sanitizeStickerName('a wave!')).toBe('a wave!');
        expect(sanitizeStickerName('')).toBe('stolen_sticker');
        expect(sanitizeStickerName('z'.repeat(60))).toHaveLength(30);
    });
});

describe('what /steal will accept typed in', () => {
    test('a pasted emoji, animated or not', () => {
        expect(parseEmojiInput('<:pepega:123456789012345678>')).toEqual({
            kind: 'emoji', id: '123456789012345678', name: 'pepega', animated: false,
        });
        expect(parseEmojiInput('<a:kekw:876543210987654321>')).toEqual({
            kind: 'emoji', id: '876543210987654321', name: 'kekw', animated: true,
        });
    });

    test('a CDN link, with the extension deciding animated', () => {
        expect(parseEmojiInput('https://cdn.discordapp.com/emojis/123456789012345678.gif'))
            .toEqual({ kind: 'emoji', id: '123456789012345678', name: null, animated: true });
        expect(parseEmojiInput('https://media.discordapp.net/emojis/123456789012345678.png'))
            .toEqual({ kind: 'emoji', id: '123456789012345678', name: null, animated: false });
    });

    test('a link carries no name, and says so instead of inventing one', () => {
        // Deriving a name from the snowflake would produce something nobody
        // wants to type. Asking is better.
        expect(parseEmojiInput('https://cdn.discordapp.com/emojis/123456789012345678.png').name)
            .toBeNull();
    });

    test('anything else is refused rather than half-parsed', () => {
        for (const input of ['', '   ', 'pepega', '😀', '123', 'https://example.com/x.png', null]) {
            expect(parseEmojiInput(input)).toBeNull();
        }
    });
});

describe('where the bytes come from', () => {
    const emoji = { kind: 'emoji', id: '123456789012345678', name: 'x', animated: false };

    test('static and animated emoji ask for different formats', () => {
        expect(cdnUrlFor(emoji, null)).toBe('https://cdn.discordapp.com/emojis/123456789012345678.png');
        expect(cdnUrlFor({ ...emoji, animated: true }, null))
            .toBe('https://cdn.discordapp.com/emojis/123456789012345678.gif');
    });

    test('the size ladder is a query param, not a different asset', () => {
        expect(cdnUrlFor(emoji, 128)).toBe('https://cdn.discordapp.com/emojis/123456789012345678.png?size=128');
    });

    test('sticker formats map to the extension Discord serves', () => {
        const base = { kind: 'sticker', id: '999999999999999999' };
        expect(cdnUrlFor({ ...base, format: StickerFormatType.PNG })).toMatch(/\.png$/);
        expect(cdnUrlFor({ ...base, format: StickerFormatType.APNG })).toMatch(/\.png$/);
        expect(cdnUrlFor({ ...base, format: StickerFormatType.GIF })).toMatch(/\.gif$/);
    });

    test('Lottie has no downloadable image at all', () => {
        // Nobody can clone these, the plugin included. Returning null here is
        // what lets the command say why rather than fail obscurely.
        expect(cdnUrlFor({ kind: 'sticker', id: '1', format: StickerFormatType.Lottie })).toBeNull();
    });

    test('an uploaded file is used as given', () => {
        expect(cdnUrlFor({ kind: 'emoji', url: 'https://cdn.discordapp.com/attachments/1/2/pic.png' }, 64))
            .toBe('https://cdn.discordapp.com/attachments/1/2/pic.png');
    });
});

describe('what the user is told when it fails', () => {
    test("Discord's limit codes become sentences", () => {
        expect(describeFailure({ code: 30008 })).toMatch(/out of emoji slots/);
        expect(describeFailure({ code: 30018 })).toMatch(/animated/);
        expect(describeFailure({ code: 30039 })).toMatch(/sticker/);
        expect(describeFailure({ code: 50013 })).toMatch(/Manage Expressions/);
    });

    test('an unmapped code still says something true', () => {
        // The point of the fallback: a code we have never seen must not turn
        // into "unknown error" when Discord already explained itself.
        expect(describeFailure({ code: 99999, message: 'Sticker frame rate is too high' }))
            .toBe('Sticker frame rate is too high');
    });

    test('a thrown non-error does not produce "undefined"', () => {
        expect(describeFailure(null)).toBe('unknown error');
        expect(describeFailure({})).toBe('unknown error');
    });
});

describe('the two surfaces', () => {
    test('both are registered, and the right-click one targets messages', () => {
        const [slash, contextMenu] = steal;
        expect(slash.data.name).toBe('steal');
        expect(contextMenu.data.name).toBe('Steal expressions');
        expect(contextMenu.data.type).toBe(ApplicationCommandType.Message);
        expect(typeof slash.execute).toBe('function');
        expect(typeof contextMenu.execute).toBe('function');
    });

    test('both are gated on Manage Expressions, not Create Expressions', () => {
        // Manage is bit 30, Create is bit 43, and they are genuinely separate:
        // holding Manage does not set Create. The plugin this replaces tested
        // for Create with a raw bitwise compare, which also meant Administrator
        // did not satisfy it, so it hid itself from server admins. Letting
        // Discord evaluate a default permission fixes both halves of that.
        const manage = String(1n << 30n);
        for (const cmd of steal) {
            expect(cmd.data.default_member_permissions).toBe(manage);
        }
    });

    test('neither declares a binary requirement', () => {
        // This is pure REST and CDN work. If it ever grows a `requires`, the
        // boot probe will start withholding it, and on a host without ffmpeg
        // that would silently remove emoji cloning for no reason.
        for (const cmd of steal) {
            expect(cmd.requires).toBeUndefined();
        }
    });
});

describe('it does not predict what Discord will allow', () => {
    test('no slot arithmetic anywhere in the source', () => {
        // The plugin broke by deriving capacity locally from a value that went
        // undefined. Nothing here should compute a slot count, a premium tier
        // limit, or an emoji budget: it asks and reports. This is a guard on
        // the design, not on behaviour.
        const fs = require('fs');
        // Comments are stripped first, because the file explains the bug it
        // was written to avoid and names the offending lookup while doing so.
        // Only whole-line comments are removed, so the `https://` inside the
        // CDN strings survives to be scanned like any other code.
        const code = fs.readFileSync('src/commands/media/steal.js', 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');

        expect(code).not.toMatch(/additionalEmojiSlots/);
        expect(code).not.toMatch(/premiumTier/);
        expect(code).not.toMatch(/maxEmojiSlots|emojiSlots|stickerSlots/i);
    });
});
