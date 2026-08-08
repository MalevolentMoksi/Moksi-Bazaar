// tests/capabilities.test.js
//
// The bot's media commands lean on binaries the app does not install, and on
// 2026-08-08 the platform swapped builders and took ffmpeg, imagemagick,
// yt-dlp and the fonts away in one go. Every one of them was found the same
// way: a user ran a command, days later, and got an error.
//
// This report is the countermeasure, so what matters about it is that it can
// never be the thing that breaks a boot, and that a missing tool is named
// together with what it costs. "imagemagick=missing" means nothing to anyone
// who has not read magickUtils.

jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/utils/media/ffmpegUtils', () => ({
    binaryResolution: jest.fn(() => ({ ffmpeg: 'system', ffprobe: 'system' })),
}));
jest.mock('../src/utils/media/magickUtils', () => ({ magickAvailable: jest.fn(async () => true) }));
jest.mock('../src/utils/media/ytdlpUtils', () => ({ ytdlpAvailable: jest.fn(async () => true) }));

const logger = require('../src/utils/logger');
const { binaryResolution } = require('../src/utils/media/ffmpegUtils');
const { magickAvailable } = require('../src/utils/media/magickUtils');
const { ytdlpAvailable } = require('../src/utils/media/ytdlpUtils');
const { probeCapabilities, reportCapabilities, COST_OF_ABSENCE } = require('../src/utils/media/capabilities');

beforeEach(() => {
    jest.clearAllMocks();
    binaryResolution.mockReturnValue({ ffmpeg: 'system', ffprobe: 'system' });
    magickAvailable.mockResolvedValue(true);
    ytdlpAvailable.mockResolvedValue(true);
});

describe('what the report says', () => {
    test('a fully equipped container reports everything present', async () => {
        const caps = await probeCapabilities();

        expect(caps.ffmpeg).toBe('system');
        expect(caps.imagemagick).toBe('system');
        expect(caps['yt-dlp']).toBe('system');
        // The fonts are in the repo, so this is true on every host.
        expect(caps.fonts).toMatch(/bundled/);
    });

    test('the Express-shaped container is described accurately', async () => {
        // Exactly the state production was in when this was written.
        binaryResolution.mockReturnValue({ ffmpeg: 'vendored', ffprobe: 'vendored' });
        magickAvailable.mockResolvedValue(false);
        ytdlpAvailable.mockResolvedValue(false);

        const caps = await probeCapabilities();

        expect(caps).toMatchObject({
            ffmpeg: 'vendored',
            ffprobe: 'vendored',
            imagemagick: 'missing',
            'yt-dlp': 'missing',
        });
    });

    test('missing tools are logged with the commands they cost', async () => {
        magickAvailable.mockResolvedValue(false);

        await reportCapabilities();

        const warn = logger.warn.mock.calls.find(c => /Missing tools/.test(c[0]));
        expect(warn).toBeTruthy();
        expect(warn[1].lost.join(' ')).toContain('/magick');
    });

    test('nothing missing means no warning at all', async () => {
        await reportCapabilities();

        expect(logger.info).toHaveBeenCalledWith('[MEDIA] Capabilities', expect.any(Object));
        expect(logger.warn.mock.calls.filter(c => /Missing tools/.test(c[0]))).toHaveLength(0);
    });

    test('every capability it can report has a stated cost', async () => {
        // A status nobody can interpret is the failure mode this replaces.
        const caps = await probeCapabilities();
        for (const name of Object.keys(caps)) {
            expect(COST_OF_ABSENCE[name]).toBeTruthy();
        }
    });
});

describe('it cannot break a boot', () => {
    test('a probe that throws is swallowed and reported as no report', async () => {
        magickAvailable.mockRejectedValue(new Error('spawn EACCES'));
        ytdlpAvailable.mockRejectedValue(new Error('spawn EACCES'));

        // Rejections are absorbed per-probe, so the report still forms and
        // simply calls those tools missing.
        const caps = await probeCapabilities();
        expect(caps.imagemagick).toBe('missing');
        expect(caps['yt-dlp']).toBe('missing');
    });

    test('a total failure returns null instead of rejecting', async () => {
        binaryResolution.mockImplementation(() => { throw new Error('module went missing'); });

        await expect(reportCapabilities()).resolves.toBeNull();
        expect(logger.warn).toHaveBeenCalledWith('[MEDIA] Capability probe failed', expect.any(Object));
    });
});
