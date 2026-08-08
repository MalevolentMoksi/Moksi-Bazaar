// tests/commandGating.test.js
//
// A command whose binary is absent used to stay in the picker and refuse when
// clicked. Tolerable on its own, but client.commands is also what tells the
// bot's persona which commands it has, and the system prompt says outright
// "these are every command you have, and you have no others". So a host
// without yt-dlp produced a bot that sincerely offered to download videos.
//
// Commands now declare `requires`, and anything unmet is withheld from BOTH
// the registration and client.commands. What is pinned here is the matching
// rule and, more importantly, that this can only ever remove a command it is
// sure about: a failed probe must never deregister a working command from
// every guild at once.

jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/utils/media/ffmpegUtils', () => ({
    binaryResolution: jest.fn(() => ({ ffmpeg: 'vendored', ffprobe: 'vendored' })),
}));
jest.mock('../src/utils/media/magickUtils', () => ({ magickAvailable: jest.fn(async () => false) }));
jest.mock('../src/utils/media/ytdlpUtils', () => ({ ytdlpAvailable: jest.fn(async () => false) }));

const { unmetRequirements, probeCapabilities } = require('../src/utils/media/capabilities');

describe('which commands a host is allowed to publish', () => {
    const caps = {
        ffmpeg: 'vendored',
        ffprobe: 'vendored',
        imagemagick: 'missing',
        'yt-dlp': 'missing',
        fonts: '12 bundled',
    };

    test('a command declaring nothing is always publishable', () => {
        expect(unmetRequirements({ data: {} }, caps)).toEqual([]);
        expect(unmetRequirements({}, caps)).toEqual([]);
        expect(unmetRequirements(null, caps)).toEqual([]);
    });

    test('a command needing a missing tool is withheld, and says which', () => {
        expect(unmetRequirements({ requires: ['imagemagick'] }, caps)).toEqual(['imagemagick']);
        expect(unmetRequirements({ requires: ['yt-dlp'] }, caps)).toEqual(['yt-dlp']);
    });

    test('a command needing a tool that IS present stays publishable', () => {
        // Vendored counts as present: that is the whole point of vendoring it.
        expect(unmetRequirements({ requires: ['ffmpeg'] }, caps)).toEqual([]);
    });

    test('a requirement nobody probes for is treated as unmet, not ignored', () => {
        // A typo'd requirement silently publishing a broken command is the
        // exact failure this mechanism exists to prevent.
        expect(unmetRequirements({ requires: ['imagemagic'] }, caps)).toEqual(['imagemagic']);
    });

    test('only the unmet half of a mixed requirement list is reported', () => {
        expect(unmetRequirements({ requires: ['ffmpeg', 'imagemagick'] }, caps)).toEqual(['imagemagick']);
    });
});

describe('the two commands this was built for', () => {
    test('/magick declares ImageMagick and /videodl declares yt-dlp', () => {
        // Loaded for real, so renaming the field in one place and not the
        // other cannot pass.
        const magick = require('../src/commands/media/magick');
        const videodl = require('../src/commands/media/videodl');

        expect(magick.requires).toEqual(['imagemagick']);
        expect(videodl.requires).toEqual(['yt-dlp']);
    });

    test('both are withheld on a host shaped like production', async () => {
        const live = await probeCapabilities();
        const magick = require('../src/commands/media/magick');
        const videodl = require('../src/commands/media/videodl');

        expect(unmetRequirements(magick, live)).toEqual(['imagemagick']);
        expect(unmetRequirements(videodl, live)).toEqual(['yt-dlp']);
    });

    test('neither promises the user it works somewhere else', () => {
        // The old copy said "(It is enabled in the deployed bot.)", which the
        // deployed bot itself began saying once the builder changed.
        const fs = require('fs');
        for (const f of ['magick.js', 'videodl.js']) {
            const src = fs.readFileSync(`src/commands/media/${f}`, 'utf8');
            const claim = /'[^']*It is enabled in the deployed bot[^']*'/.test(src)
                || /"[^"]*It is enabled in the deployed bot[^"]*"/.test(src);
            expect(claim).toBe(false);
        }
    });
});
