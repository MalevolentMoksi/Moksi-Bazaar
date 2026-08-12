// tests/mediaStampede.test.js
//
// Three things the 2026-08-11 telemetry export showed, in one reply:
//
//   joe-bart-joe-bartolozzi.mp4 was downloaded, storyboarded and sent to the
//   vision model SIX times. The media cache is a database round trip and the
//   context builder describes every message in the window concurrently, so all
//   six lookups missed before any of them wrote back.
//
//   The six answers named six different people (Jidion, Cody Ko, Danny
//   Gonzalez, Mikerina, Quackity, Jynxzi), none of them Joe Bartolozzi. The
//   prompt told the model to "name any recognizable public figures", so it did,
//   by guessing. Those names are pasted into the conversation the writers read.
//
//   That reply described eleven items, cost $0.00747 against a $0.005 ceiling,
//   and then answered a question about a broken ffmpeg config without
//   mentioning one of them.

jest.mock('../src/utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const fs = require('fs');
const path = require('path');

const { describeOnce } = require('../src/utils/db');
const { mediaBudget, FRESH_MEDIA_PER_REPLY } = require('../src/commands/tools/speak');

describe('one describe per file, however many messages carry it', () => {
    test('six concurrent lookups become one call', async () => {
        const work = jest.fn(async () => {
            await new Promise(r => setTimeout(r, 10));
            return 'a puppy being poked';
        });

        const all = await Promise.all(
            Array.from({ length: 6 }, () => describeOnce('media-1', work)),
        );

        expect(work).toHaveBeenCalledTimes(1);
        expect(all).toEqual(Array(6).fill('a puppy being poked'));
    });

    test('different files still run in parallel', async () => {
        const work = jest.fn(async () => 'x');
        await Promise.all(['a', 'b', 'c'].map(id => describeOnce(id, work)));
        expect(work).toHaveBeenCalledTimes(3);
    });

    // The window is only open while a describe is in the air; the database
    // cache is the durable one. A second look later must not be blocked by a
    // stale entry from an hour ago.
    test('the slot is released once it settles', async () => {
        const work = jest.fn(async () => 'first');
        await describeOnce('media-2', work);
        await describeOnce('media-2', work);
        expect(work).toHaveBeenCalledTimes(2);
    });

    test('a failed describe does not poison the id', async () => {
        const boom = jest.fn(async () => { throw new Error('ffmpeg died'); });
        await expect(describeOnce('media-3', boom)).rejects.toThrow('ffmpeg died');

        const ok = jest.fn(async () => 'recovered');
        await expect(describeOnce('media-3', ok)).resolves.toBe('recovered');
    });

    test('everyone waiting on a failed describe hears about it', async () => {
        const boom = jest.fn(async () => {
            await new Promise(r => setTimeout(r, 5));
            throw new Error('download timed out');
        });
        const results = await Promise.allSettled([
            describeOnce('media-4', boom),
            describeOnce('media-4', boom),
        ]);
        expect(results.map(r => r.status)).toEqual(['rejected', 'rejected']);
        expect(boom).toHaveBeenCalledTimes(1);
    });

    test('a producer that throws synchronously is still an error, not a crash', async () => {
        await expect(describeOnce('media-5', () => { throw new Error('nope'); }))
            .rejects.toThrow('nope');
    });
});

describe('how much new media one reply will pay to look at', () => {
    const msg = (id, { items = 1, bot = false } = {}) => ({
        id,
        author: { id: bot ? 'bot' : 'user' },
        attachments: { size: items },
        embeds: [],
        stickers: { size: 0 },
    });

    test('a quiet window is entirely within budget', () => {
        const recent = [msg('a'), msg('b'), msg('c')];
        expect(mediaBudget(recent, 'bot').size).toBe(3);
    });

    // The shape of the incident: eleven items, one reply.
    test('a meme stream is cut off at the limit', () => {
        const recent = Array.from({ length: 11 }, (_, i) => msg(`m${i}`));
        const allowed = mediaBudget(recent, 'bot');
        expect(allowed.size).toBe(FRESH_MEDIA_PER_REPLY);
    });

    // Newest first, because the newest thing is what the reply is about. The
    // older ones are usually cached already, and a cached description is
    // always served whatever this says.
    test('the newest media wins the budget', () => {
        const recent = Array.from({ length: 10 }, (_, i) => msg(`m${i}`));
        const allowed = mediaBudget(recent, 'bot');
        expect(allowed.has('m9')).toBe(true);
        expect(allowed.has('m0')).toBe(false);
    });

    test('one message with an album counts as the album, not as one', () => {
        const recent = [msg('old'), msg('album', { items: 6 })];
        const allowed = mediaBudget(recent, 'bot');
        expect(allowed.has('album')).toBe(true);
        expect(allowed.has('old')).toBe(false);
    });

    test('the bot does not spend the budget looking at its own posts', () => {
        const recent = [msg('mine', { bot: true }), msg('theirs')];
        const allowed = mediaBudget(recent, 'bot');
        expect(allowed.has('mine')).toBe(false);
        expect(allowed.has('theirs')).toBe(true);
    });

    test('messages with no media never consume it', () => {
        const recent = [
            { id: 'talk', author: { id: 'user' }, attachments: { size: 0 }, embeds: [], stickers: { size: 0 } },
            msg('pic'),
        ];
        expect([...mediaBudget(recent, 'bot')]).toEqual(['pic']);
    });
});

describe('what the vision model is asked to do', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src/utils/db.js'), 'utf8');

    test('it is no longer ordered to name everyone it sees', () => {
        expect(source).not.toContain('Name any recognizable characters, memes, or public figures.');
    });

    test('and it is told what to do when it does not know', () => {
        expect(source).toMatch(/ONLY when you genuinely recognise them/);
        expect(source).toMatch(/rather than guessing a name/);
    });

    // Naming is still wanted when it is real: Darth Vader, Tony Soprano and
    // Shinada were all correctly identified in the same export.
    test('naming is discouraged when unsure, not forbidden', () => {
        expect(source).toMatch(/Name characters, memes or public figures/);
    });
});
