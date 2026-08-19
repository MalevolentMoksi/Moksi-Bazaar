// tests/mediaOnlyPing.test.js
//
// Sending a clip IS saying something.
//
// On 2026-08-11 someone replied to the bot with a two-second video and no
// text. The video was in the chat log; the last line of the user message
// said "(1ShallPlay pinged you without saying anything; react to the chat
// log above)", and the writer believed the instruction over the log: "the
// ping with no follow-up. bold move. waiting on the words, champ."
//
// Two rules come out of that, and both are pinned here:
//
//   1. The bot never tells itself someone said nothing when they attached
//      something. Text-free and empty are different events.
//   2. When it genuinely could not see the file, the metadata it gets is
//      fenced off from description. A filename has been mistaken for content
//      twice in this codebase ("shinada-yakuza-5-knife-gif" invented a scene,
//      "joe-bart-joe-bartolozzi.mp4" produced six wrong names in six tries),
//      so the tag says "contents not seen" first and calls the label a
//      filename, and the prompt forbids naming anyone from one.

const fs = require('fs');
const path = require('path');

const speakSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'commands', 'tools', 'speak.js'), 'utf8');
const dbSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'utils', 'db.js'), 'utf8');

describe('a text-free message with media is not an empty ping', () => {
    test('the media case has its own instruction', () => {
        expect(speakSource).toMatch(/sent you media with no words/);
    });

    test('it is chosen by asking whether the message carried anything', () => {
        expect(speakSource).toMatch(/const sharedMedia = !userRequest && hasVisibleMedia\(interaction\._sourceMessage\)/);
        expect(speakSource).toMatch(/sharedMedia\s*\n?\s*\?/);
    });

    test('the old "said nothing" line survives, for genuinely empty pings', () => {
        expect(speakSource).toMatch(/pinged you without saying anything/);
    });

    test('the media instruction refuses to guess from the filename', () => {
        const line = speakSource.match(/sent you media with no words[^`]*/)[0];
        expect(line).toMatch(/do not guess from the filename/);
        expect(line).toMatch(/contents were not seen/);
    });
});

describe('the summoning message gets a bounded priority slot', () => {
    test('it is bounded by its own constant, not made exempt', () => {
        expect(speakSource).toMatch(/const PRIORITY_MEDIA_GRACE_MS = 4_000;/);
        expect(speakSource).toMatch(/REPLY_MEDIA_BUDGET_MS \+ PRIORITY_MEDIA_GRACE_MS/);
    });

    test('the grace is small enough to keep a reply inside the latency ceiling', () => {
        const budget = Number(speakSource.match(/const REPLY_MEDIA_BUDGET_MS = ([\d_]+);/)[1].replace(/_/g, ''));
        const grace = Number(speakSource.match(/const PRIORITY_MEDIA_GRACE_MS = ([\d_]+);/)[1].replace(/_/g, ''));
        // The reply target is ~6s and the hard ceiling is 20s; media may not
        // eat more than half of the ceiling before a word is written.
        expect(budget + grace).toBeLessThanOrEqual(10_000);
    });

    test('the priority message always gets to pay for a fresh look', () => {
        expect(speakSource).toMatch(/isPriority \|\| freshMediaAllowed\.has\(msg\.id\)/);
    });
});

describe('an unseen tag carries metadata, fenced', () => {
    const { unseen, dims } = (() => {
        // The helper is a closure inside processMediaInMessage; rebuild it
        // from the source so the shape stays pinned to the real one.
        const body = dbSource.match(/const unseen = \(what, meta = null\) => \{[\s\S]*?\n    \};/)[0];
        const make = new Function(`${body} return unseen;`);
        return { unseen: make(), dims: '1280x720' };
    })();

    test('"contents not seen" comes first, before any metadata', () => {
        const tag = unseen('Video', { name: 'shinada-yakuza-5-knife.mp4', dims });
        expect(tag.indexOf('contents not seen')).toBeLessThan(tag.indexOf('filename'));
    });

    test('the filename is labelled as a filename, never presented as a description', () => {
        const tag = unseen('Video', { name: 'joe-bart-joe-bartolozzi.mp4' });
        expect(tag).toContain('filename "joe-bart-joe-bartolozzi.mp4"');
        // The descriptive shape means "you saw this" and must not be produced.
        expect(tag).not.toMatch(/^\[Video: /);
    });

    test('no metadata is still a clean, honest tag', () => {
        expect(unseen('Video')).toBe('[Video shared, contents not seen]');
    });

    test('an absurd filename cannot flood the prompt', () => {
        const tag = unseen('Image', { name: 'x'.repeat(500) });
        expect(tag.length).toBeLessThan(140);
    });
});

describe('the prompt teaches what a filename is worth', () => {
    test('it says metadata, never a description', () => {
        expect(speakSource).toMatch(/those are metadata, never a description/);
    });

    test('it forbids naming anyone or anything from a filename', () => {
        expect(speakSource).toMatch(/NEVER name a person, character, game, show or meme on the strength of a filename/);
    });

    // The other half of the same hazard. The tag deliberately withholds the
    // tenor slug, but the raw URL is in the user's own message and cannot be
    // stripped, so the slug reaches the model regardless. Structure alone
    // could not close this one; the rule has to say it.
    test('a link slug is called a label too, not evidence', () => {
        expect(speakSource).toMatch(/slug someone else typed/);
        expect(speakSource).toMatch(/filename or a link slug/);
    });

    test('the older rule against reacting to file types is still there', () => {
        expect(speakSource).toMatch(/do not comment on the file type/);
    });
});
