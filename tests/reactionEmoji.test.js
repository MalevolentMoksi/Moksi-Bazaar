// tests/reactionEmoji.test.js
//
// The bug that started this: told to end its reply with a key on its own line,
// the model wrote ":goat_pet:" at the end of a sentence instead, and the
// stripper only accepted a bare token optionally followed by `.!?`. A trailing
// colon defeated it, so the key went out to the channel as literal text:
//
//     gg, barely broke a sweat. 0.26 days old. :goat_pet:
//
// That is not one missed shape, it is a class: the model will write the key in
// any of the forms it has ever seen an emoji written in, and every form that
// is not recognised is sent to everyone as text. So the first block below is a
// table of the shapes rather than a test of the one that was photographed.
//
// The second half is the other side of the same coin. The keys used to be
// `goat_*`, which no sentence ever contains; they are now ordinary English
// words, so an over-eager stripper would start eating replies.

const fs = require('fs');
const path = require('path');

const { extractEmojiKey } = require('../src/commands/tools/speak');
const { REACTION_EMOJI, REACTION_FALLBACK } = require('../src/utils/constants');
const registry = require('../src/utils/emojiRegistry');
const {
    sourceFiles, normalize, plan, apply, parseArgs, duplicateKeys, unknownKeys,
    NAME_RULE, MAX_BYTES, EMOJI_DIR,
} = require('../scripts/syncEmojis');

const KEYS = ['smile', 'sad', 'shock', 'point', 'neutral'];

/** Would this reply put a key in front of the room as text? */
const leaksSyntax = (text) => /<a?:[a-z0-9_]+:\d+>|:(smile|sad|shock|point|neutral):/i.test(text);

describe('a key never reaches the channel as text', () => {
    const SHAPES = [
        ['the documented format', 'yeah that tracks\nsmile'],
        ['the shape that shipped broken', 'yeah that tracks :smile:'],
        ['shortcode on its own line', 'yeah that tracks\n:smile:'],
        ['shortcode with a full stop after it', 'yeah that tracks :smile:.'],
        ['a full emoji mention', 'yeah that tracks <:smile:1273634369445040219>'],
        ['an animated mention, in case one is ever uploaded', 'yeah that tracks <a:smile:1273634369445040219>'],
        ['a mention on its own line', 'yeah that tracks\n<:smile:1273634369445040219>'],
        ['shouted', 'yeah that tracks\nSMILE'],
        ['with trailing punctuation', 'yeah that tracks\nsmile.'],
        ['held on by a dash', 'yeah that tracks - :smile:'],
        ['held on by a comma', 'yeah that tracks, :smile:'],
        ['mid sentence', 'yeah :smile: that tracks'],
        ['trailing blank lines', 'yeah that tracks\nsmile\n\n'],
        ['leading whitespace on the key line', 'yeah that tracks\n   smile   '],
    ];

    test.each(SHAPES)('%s', (_label, raw) => {
        const { replyText, emojiKey } = extractEmojiKey(raw, KEYS);
        expect(emojiKey).toBe('smile');
        expect(leaksSyntax(replyText)).toBe(false);
        expect(replyText).toContain('yeah');
        expect(replyText).toContain('tracks');
    });

    test('the reply keeps its own punctuation when the key is torn off the end', () => {
        // The separator holding the key goes; the question mark is the reply's.
        expect(extractEmojiKey('you serious? :shock:', KEYS).replyText).toBe('you serious?');
        expect(extractEmojiKey('fine - :sad:', KEYS).replyText).toBe('fine');
        expect(extractEmojiKey('sure, :neutral:', KEYS).replyText).toBe('sure');
    });

    test('a hole left mid sentence does not become a double space', () => {
        expect(extractEmojiKey('yeah :smile: that tracks', KEYS).replyText).toBe('yeah that tracks');
    });

    test('"none" is still honoured, and still not eaten out of a sentence', () => {
        expect(extractEmojiKey("that's none of your concern\nnone", KEYS)).toEqual({
            replyText: "that's none of your concern",
            emojiKey: null,
        });
    });

    test('two keys in one reply: the first is used, neither is left behind', () => {
        const { replyText, emojiKey } = extractEmojiKey('well :smile: sure :sad:', KEYS);
        expect(emojiKey).toBe('smile');
        expect(leaksSyntax(replyText)).toBe(false);
    });

    test('a reply that is nothing but a key still sends the reaction', () => {
        // Unambiguous syntax, so there is no reading where ":smile:" was meant
        // as words. The caller supplies the message body.
        expect(extractEmojiKey(':smile:', KEYS)).toEqual({ replyText: '', emojiKey: 'smile' });
    });
});

describe('and an ordinary word is never mistaken for one', () => {
    test('a sentence ending in a key word keeps it', () => {
        expect(extractEmojiKey("that's genuinely sad", KEYS)).toEqual({
            replyText: "that's genuinely sad",
            emojiKey: null,
        });
    });

    test('a one word reply is a reply, not a stray key', () => {
        // The whole message being "sad" reads as an answer. Consuming it would
        // send an emoji and nothing else, which is strictly worse than a
        // reaction that did not fire.
        expect(extractEmojiKey('sad', KEYS)).toEqual({ replyText: 'sad', emojiKey: null });
        expect(extractEmojiKey('bored', KEYS)).toEqual({ replyText: 'bored', emojiKey: null });
    });

    test('a key word ending a multi-line reply is left alone unless it is alone on its line', () => {
        const raw = 'i looked at it\nhonestly that made me sad';
        expect(extractEmojiKey(raw, KEYS)).toEqual({ replyText: raw, emojiKey: null });
    });

    test("somebody else's emoji is not ours to remove", () => {
        const raw = 'that <:pepega:123456789012345678> again';
        expect(extractEmojiKey(raw, KEYS)).toEqual({ replyText: raw, emojiKey: null });
    });

    test('a timestamp is not a shortcode', () => {
        const raw = 'it went out at 12:30:45 and nobody noticed';
        expect(extractEmojiKey(raw, KEYS)).toEqual({ replyText: raw, emojiKey: null });
    });

    test('an unknown key on its own line stays in the message rather than vanishing', () => {
        // A hallucinated key is visible nonsense either way; deleting the line
        // would also delete a real one-line reply that happened to look like one.
        const raw = 'sure\ngoat_boogie';
        expect(extractEmojiKey(raw, KEYS).replyText).toBe(raw);
    });

    test('empty input does not throw', () => {
        expect(extractEmojiKey('', KEYS)).toEqual({ replyText: '', emojiKey: null });
        expect(extractEmojiKey(null, KEYS)).toEqual({ replyText: '', emojiKey: null });
    });
});

describe('the registry, which is the only place an id exists', () => {
    afterEach(() => registry._reset());

    const clientWith = (names) => ({
        application: {
            emojis: {
                fetch: async () => new Map(names.map((name, i) => [
                    String(i),
                    { name, toString: () => `<:${name}:10000000000000000${i}>` },
                ])),
            },
        },
    });

    test('a key with no uploaded image resolves to nothing, never to a broken mention', () => {
        registry._setLive([['smile', '<:smile:1>']]);
        expect(registry.emojiFor('smile')).toBe('<:smile:1>');
        expect(registry.emojiFor('sad')).toBe('');
        expect(registry.emojiFor(null)).toBe('');
        expect(registry.emojiFor('nonsense')).toBe('');
    });

    test('the model is only ever offered keys that exist AND are described', () => {
        registry._setLive([['smile', '<:smile:1>'], ['sad', '<:sad:2>'], ['mystery', '<:mystery:3>']]);
        expect(registry.emojiKeys()).toEqual(['sad', 'smile']);
        expect(registry.emojiHints()).toContain(`sad (${REACTION_EMOJI.sad})`);
        expect(registry.emojiHints()).not.toContain('mystery');
    });

    test('the offered list is sorted, because the prompt prefix has to be byte stable to cache', () => {
        registry._setLive([['yell', '<:yell:1>'], ['angry', '<:angry:2>'], ['sad', '<:sad:3>']]);
        expect(registry.emojiKeys()).toEqual(['angry', 'sad', 'yell']);
    });

    test('boot loads whatever the application owns', async () => {
        const result = await registry.loadEmojis(clientWith(['smile', 'sad']));
        expect(result.total).toBe(2);
        expect(result.usable).toBe(2);
        expect(registry.emojiFor('smile')).toMatch(/^<:smile:\d+>$/);
    });

    test('an application with no emojis is a bot without faces, not a broken one', async () => {
        const result = await registry.loadEmojis(clientWith([]));
        expect(result.total).toBe(0);
        expect(registry.emojisReady()).toBe(false);
        expect(registry.emojiKeys()).toEqual([]);
        expect(registry.emojiHints()).toBe('');
    });

    test('names are matched case insensitively, since Discord does not promise the case', async () => {
        await registry.loadEmojis(clientWith(['Smile']));
        expect(registry.emojiFor('smile')).toBeTruthy();
        expect(registry.emojiFor('SMILE')).toBeTruthy();
    });

    test('an API failure propagates, so the boot report says the faces are missing', async () => {
        const client = { application: { emojis: { fetch: async () => { throw new Error('401'); } } } };
        await expect(registry.loadEmojis(client)).rejects.toThrow('401');
    });

    test('both halves of a mismatch are reported', async () => {
        const result = await registry.loadEmojis(clientWith(['smile', 'leftover']));
        expect(result.undescribed).toContain('leftover');
        expect(result.missing).toContain('sad');
    });
});

describe('the folder, the descriptions and the fallbacks agree', () => {
    const sources = sourceFiles();
    const keys = sources.map(s => s.key);

    test('there are actually source images', () => {
        expect(sources.length).toBeGreaterThan(0);
    });

    test.each(sources.map(s => [s.key, s.file]))('%s is a legal Discord emoji name', (key) => {
        expect(key).toMatch(NAME_RULE);
    });

    test('every image has a description, or the model is never offered it', () => {
        const undescribed = keys.filter(key => !REACTION_EMOJI[key]);
        expect(undescribed).toEqual([]);
    });

    test('every description has an image, or the model can pick a key that resolves to nothing', () => {
        const imageless = Object.keys(REACTION_EMOJI).filter(key => !keys.includes(key));
        expect(imageless).toEqual([]);
    });

    test('every fallback points at a key that exists', () => {
        // The old mapping fell back to goat_small_bleat long after anyone had
        // read that line; a fallback to a missing key silently produces no
        // reaction at all, which looks exactly like the model declining one.
        for (const [reason, key] of Object.entries(REACTION_FALLBACK)) {
            expect({ reason, key }).toEqual({ reason, key: expect.stringMatching(NAME_RULE) });
            expect(REACTION_EMOJI[key]).toBeDefined();
            expect(keys).toContain(key);
        }
    });

    test('no two descriptions are the same, since identical hints make the choice a coin flip', () => {
        const hints = Object.values(REACTION_EMOJI);
        expect(new Set(hints).size).toBe(hints.length);
    });
});

describe('every source image is one Discord will accept', () => {
    const sources = sourceFiles();

    test.each(sources.map(s => [s.key, s.file]))('%s normalizes under the 256KB limit', async (_key, file) => {
        const { buffer } = await normalize(file);
        expect(buffer.length).toBeLessThan(MAX_BYTES);
    }, 20_000);

    test('the folder holds nothing but images', () => {
        const strays = fs.readdirSync(EMOJI_DIR).filter(name => !/\.(png|jpe?g|webp|gif)$/i.test(name));
        expect(strays).toEqual([]);
    });

    test('no name differs from another only by case, which collides on upload', () => {
        const lower = sources.map(s => s.key);
        expect(new Set(lower).size).toBe(lower.length);
    });
});

describe('the sync script decides before it sends', () => {
    const src = (...keys) => keys.map(key => ({ key, file: `${key}.png` }));
    const owned = (...names) => new Map(names.map((name, i) => [name, { id: `${i}`, name }]));

    test('a first run creates everything and deletes nothing', () => {
        const steps = plan(src('smile', 'sad'), owned(), {});
        expect(steps.create.map(s => s.key)).toEqual(['smile', 'sad']);
        expect(steps.replace).toEqual([]);
        expect(steps.prune).toEqual([]);
    });

    test('a second run is a no-op, so it is safe to leave in a deploy', () => {
        const steps = plan(src('smile', 'sad'), owned('smile', 'sad'), {});
        expect(steps.create).toEqual([]);
        expect(steps.replace).toEqual([]);
    });

    test('a changed image needs --replace, since Discord offers no checksum to notice with', () => {
        expect(plan(src('smile'), owned('smile'), {}).replace).toEqual([]);
        expect(plan(src('smile'), owned('smile'), { replace: true }).replace).toHaveLength(1);
    });

    test('an emoji with no source file is reported but never deleted without --prune', () => {
        const steps = plan(src('smile'), owned('smile', 'goat_pet'), {});
        expect(steps.orphans.map(e => e.name)).toEqual(['goat_pet']);
        expect(steps.prune).toEqual([]);
        expect(plan(src('smile'), owned('smile', 'goat_pet'), { prune: true }).prune).toHaveLength(1);
    });

    test('nothing at all happens without --yes', () => {
        expect(parseArgs([]).yes).toBe(false);
        expect(parseArgs(['--yes']).yes).toBe(true);
    });

    // This one happened. bored.jpg and bored.webp both claimed the name
    // `bored`; Discord took the jpg and rejected the webp as ALREADY_TAKEN,
    // so the emoji called `bored` ended up holding the other picture entirely.
    // One FAILED line in a run that also said "20 uploaded" is not a signal
    // anybody catches, so the clash is now found before anything is sent.
    test('two files claiming one name are caught before a single upload', () => {
        const clashes = duplicateKeys([
            { key: 'bored', file: 'emojis/bored.jpg' },
            { key: 'bored', file: 'emojis/bored.webp' },
            { key: 'sad', file: 'emojis/sad.webp' },
        ]);
        expect(clashes).toEqual([{ key: 'bored', files: ['bored.jpg', 'bored.webp'] }]);
    });

    test('the folder as it stands has no clash', () => {
        expect(duplicateKeys(sourceFiles())).toEqual([]);
    });

    test('--only narrows the work to the keys named', () => {
        const sources = src('bored', 'sad', 'yell');
        const live = owned('bored', 'sad');
        const steps = plan(sources, live, { replace: true, only: new Set(['bored']) });

        expect(steps.replace.map(s => s.key)).toEqual(['bored']);
        expect(steps.create).toEqual([]);
    });

    test('--only still creates a named key that does not exist yet', () => {
        const steps = plan(src('bored', 'sigh'), owned('bored'), { only: new Set(['bored', 'sigh']) });
        expect(steps.create.map(s => s.key)).toEqual(['sigh']);
    });

    test('--only never prunes, since it names what to touch', () => {
        const steps = plan(src('bored'), owned('bored', 'goat_pet'), { prune: true, only: new Set(['bored']) });
        expect(steps.prune).toEqual([]);
        // Still reported, so the orphan does not become invisible.
        expect(steps.orphans.map(e => e.name)).toEqual(['goat_pet']);
    });

    test('--only is parsed from a comma list, case and spacing forgiven', () => {
        expect([...parseArgs(['--only', 'Bored, sigh']).only]).toEqual(['bored', 'sigh']);
        expect(parseArgs(['--yes']).only).toBeNull();
    });

    // `railway run node scripts/syncEmojis.js --only bored,sigh` delivers
    // `["--only", "bored sigh"]`: the Railway CLI rewrites the comma as a
    // space before the script sees a thing. The first version of this flag
    // then matched no key at all and reported "nothing to do", which reads
    // exactly like the work already being done.
    test('a comma the CLI turned into a space still names two keys', () => {
        expect([...parseArgs(['--only', 'bored sigh']).only]).toEqual(['bored', 'sigh']);
    });

    test('and every other spelling of the flag works too', () => {
        expect([...parseArgs(['--only=bored,sigh']).only]).toEqual(['bored', 'sigh']);
        expect([...parseArgs(['--only', 'bored', '--only', 'sigh']).only]).toEqual(['bored', 'sigh']);
        // Bare spaces, which is what a person types when the comma version
        // has just been mangled once already.
        expect([...parseArgs(['--only', 'bored', 'sigh', 'laughing']).only])
            .toEqual(['bored', 'sigh', 'laughing']);
    });

    test('the flags after a key list are still flags, not keys', () => {
        const parsed = parseArgs(['--only', 'bored', 'sigh', '--yes', '--replace']);
        expect([...parsed.only]).toEqual(['bored', 'sigh']);
        expect(parsed.yes).toBe(true);
        expect(parsed.replace).toBe(true);
    });

    test('a key with no source file is named as such, not silently skipped', () => {
        const sources = src('bored', 'sigh');
        expect(unknownKeys(sources, new Set(['bored']))).toEqual([]);
        expect(unknownKeys(sources, new Set(['bored sigh']))).toEqual(['bored sigh']);
        expect(unknownKeys(sources, new Set(['bore', 'sigh']))).toEqual(['bore']);
        expect(unknownKeys(sources, null)).toEqual([]);
    });

    test('a flag with no value at all is empty rather than absent, which is not the same thing', () => {
        // An empty Set is truthy, so this filtered out every source and did
        // nothing quietly. main() now refuses to run on it.
        const parsed = parseArgs(['--only']);
        expect(parsed.only).not.toBeNull();
        expect(parsed.only.size).toBe(0);
    });

    test('replacing deletes the old emoji before creating the new one', async () => {
        const calls = [];
        const rest = {
            delete: async (route) => { calls.push(['delete', route]); },
            post: async (route, { body }) => { calls.push(['post', body.name]); return { name: body.name, id: '99' }; },
        };
        const sources = sourceFiles().slice(0, 1);
        const live = new Map([[sources[0].key, { id: '5', name: sources[0].key }]]);
        const result = await apply(rest, 'app', plan(sources, live, { replace: true }), live, () => {});

        expect(result).toEqual({ created: 1, deleted: 1, failed: 0 });
        expect(calls[0][0]).toBe('delete');
        expect(calls[1]).toEqual(['post', sources[0].key]);
    }, 20_000);

    test('one rejected image does not strand the rest', async () => {
        const rest = {
            delete: async () => {},
            post: async (route, { body }) => {
                if (body.name === sourceFiles()[0].key) throw new Error('50035: invalid image');
                return { name: body.name, id: '1' };
            },
        };
        const sources = sourceFiles().slice(0, 3);
        const result = await apply(rest, 'app', plan(sources, new Map(), {}), new Map(), () => {});

        expect(result.failed).toBe(1);
        expect(result.created).toBe(2);
    }, 20_000);
});

// The class of bug the whole migration exists to remove: an emoji id written
// into a source file cannot be told apart from a working one once it stops
// resolving, because the string still looks like a mention right up until
// Discord renders it as text in front of everyone.
describe('no emoji id is written down anywhere in the source', () => {
    const walk = (dir, out = []) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (['node_modules', '.git', 'assets'].includes(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full, out);
            else if (entry.name.endsWith('.js')) out.push(full);
        }
        return out;
    };

    test('src/ contains no hardcoded custom emoji mention', () => {
        const root = path.join(__dirname, '..', 'src');
        const offenders = [];
        for (const file of walk(root)) {
            fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
                const code = line.trim();
                // Comments are allowed to quote the shape; this is about code.
                if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
                if (/<a?:[a-z0-9_]+:\d{15,}>/i.test(line)) {
                    offenders.push(`${path.relative(root, file)}:${i + 1}`);
                }
            });
        }
        expect(offenders).toEqual([]);
    });
});
