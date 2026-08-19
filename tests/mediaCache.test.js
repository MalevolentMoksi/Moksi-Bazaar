// tests/mediaCache.test.js
//
// The vision-and-cache audit found the system quietly degrading in ways no
// error ever surfaced: the fallback vision model had been DELISTED from
// OpenRouter (every fallback call 404ed into "contents not seen"), the
// primary rode a -preview id, and every pasted Discord CDN link was being
// storyboarded through ffmpeg as a "GIF" because the CDN host was listed as
// an animated host. These pin the fixes, and the cache-key property the
// whole cache stands on.

const fs = require('fs');
const path = require('path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// db.js constructs a pg Pool at import, but pg pools are lazy: nothing
// connects until a query runs, and these tests only touch pure functions.
const { normalizeMediaUrl, generateMediaId, isAnimatedEmbedCandidate } = require('../src/utils/db.js');

describe('the cache key survives Discord re-signing its URLs', () => {
    const signedA = 'https://cdn.discordapp.com/attachments/123/456/meme.png?ex=aaa&is=bbb&hm=ccc';
    const signedB = 'https://cdn.discordapp.com/attachments/123/456/meme.png?ex=xxx&is=yyy&hm=zzz';

    test('two signatures of the same attachment normalise identically', () => {
        expect(normalizeMediaUrl(signedA)).toBe(normalizeMediaUrl(signedB));
        expect(normalizeMediaUrl(signedA)).toBe('https://cdn.discordapp.com/attachments/123/456/meme.png');
    });

    test('and therefore produce the same cache id: one analysis per image, ever', () => {
        expect(generateMediaId(signedA, null, 'meme.png')).toBe(generateMediaId(signedB, null, 'meme.png'));
    });

    test('different attachments stay different', () => {
        expect(generateMediaId(signedA, null, 'meme.png'))
            .not.toBe(generateMediaId('https://cdn.discordapp.com/attachments/123/457/other.png', null, 'other.png'));
    });

    test('non-Discord hosts keep their query strings: elsewhere they select the image', () => {
        const tenor = 'https://media.tenor.com/abc/tenor.gif?itemid=555';
        expect(normalizeMediaUrl(tenor)).toBe(tenor);
    });

    test('data URIs and garbage pass through without throwing', () => {
        expect(normalizeMediaUrl('data:image/jpeg;base64,abc')).toBe('data:image/jpeg;base64,abc');
        expect(normalizeMediaUrl('http://%%%')).toBe('http://%%%');
        expect(normalizeMediaUrl(null)).toBe('');
    });
});

describe('what counts as animated', () => {
    test('a pasted Discord CDN image link is NOT a GIF', () => {
        // The old host list included cdn.discordapp.com, so every pasted
        // image link was downloaded, storyboarded and labeled "Embedded GIF".
        expect(isAnimatedEmbedCandidate({
            type: 'image',
            url: 'https://cdn.discordapp.com/attachments/1/2/photo.png',
            image: { url: 'https://cdn.discordapp.com/attachments/1/2/photo.png' },
        })).toBe(false);
    });

    test('a real .gif on any host still is', () => {
        expect(isAnimatedEmbedCandidate({
            type: 'image',
            image: { url: 'https://cdn.discordapp.com/attachments/1/2/reaction.gif' },
        })).toBe(true);
    });

    test('tenor and gifv survive as animated', () => {
        expect(isAnimatedEmbedCandidate({ type: 'gifv', url: 'https://tenor.com/view/thing' })).toBe(true);
        expect(isAnimatedEmbedCandidate({ type: 'image', url: 'https://tenor.com/view/thing' })).toBe(true);
    });

    test('an ordinary external link preview is not', () => {
        expect(isAnimatedEmbedCandidate({
            type: 'link',
            url: 'https://example.com/article',
            thumbnail: { url: 'https://example.com/cover.jpg' },
        })).toBe(false);
    });
});

// Source-level guards for what cannot be exercised without a live database.
// The ids themselves moved to constants.js when a boot-time check was added,
// so that something enumerates every model the bot is configured to call.
describe('the vision chain points at models that exist', () => {
    const { SPEAK_MODELS } = require('../src/utils/constants');

    test('the primary is the stable Gemini id, not the preview', () => {
        expect(SPEAK_MODELS.VISION).toBe('google/gemini-3.1-flash-lite');
        expect(SPEAK_MODELS.VISION).not.toContain('preview');
    });

    test('the fallback is the living Qwen3 VL, not the delisted 2.5', () => {
        expect(SPEAK_MODELS.VISION_FALLBACK).toBe('qwen/qwen3-vl-8b-instruct');
        expect(SPEAK_MODELS.VISION_FALLBACK).not.toContain('qwen-2.5-vl-7b-instruct');
    });

    test('db.js reads them from there rather than carrying its own copies', () => {
        const db = read('src/utils/db.js');
        expect(db).toContain('SPEAK_MODELS.VISION');
        expect(db).toContain('SPEAK_MODELS.VISION_FALLBACK');
    });
});

describe('the media stage respects the reply deadline', () => {
    test('fresh analysis checks the budget; cached lookups never do', () => {
        const db = read('src/utils/db.js');
        expect(db).toContain('outOfTime');
        // The deadline check must come AFTER the cache check in both
        // describers: a cached description costs nothing and always renders.
        const describeUrlBody = db.slice(db.indexOf('const describeUrl'), db.indexOf('const describeVideo'));
        expect(describeUrlBody.indexOf('getCachedMediaDescription')).toBeLessThan(describeUrlBody.indexOf('outOfTime()'));
    });

    test('speak.js actually passes the budget down', () => {
        const speak = read('src/commands/tools/speak.js');
        expect(speak).toContain('MEDIA_STAGE_BUDGET_MS');
        expect(speak).toContain('deadlineAt:');
        expect(speak).toContain('mediaDeadlineAt');
        // The summoning message gets a longer leash, and the two deadlines are
        // combined with Math.max so that path can only ever EXTEND the budget.
        // A priority slot that could shorten it would be a way to make the one
        // clip that matters most the first one given up on.
        expect(speak).toContain('Math.max(priorityDeadlineAt, mediaDeadlineAt)');
    });
});

describe('GIF storyboards carry the same armour as video frames', () => {
    test('capped, deadlined, and queued through the shared gate', () => {
        const db = read('src/utils/db.js');
        const body = db.slice(db.indexOf('async function buildGifStoryboard'), db.indexOf('async function analyzeGifWithOpenRouter'));
        expect(body).toContain('withSampleSlot');
        expect(body).toContain('maxBytes: MAX_VIDEO_BYTES');
        expect(body).toContain('timeoutMs');
    });

    test('the video thumbnail shortcut is gone: it could only match an unrelated embed', () => {
        const db = read('src/utils/db.js');
        expect(db).not.toContain('videoThumbnail');
    });
});
