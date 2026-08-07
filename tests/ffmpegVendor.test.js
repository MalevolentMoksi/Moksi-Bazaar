// tests/ffmpegVendor.test.js
//
// Railway's Express builder skips the Dockerfile, and with it the apt ffmpeg
// that every media command depends on. ffmpegUtils now resolves the binary at
// load: system first (the Docker case, current and distro-patched), vendored
// npm build second (the Express case). What is pinned here is the resolution
// order and, above all, that a vendored package whose download script was
// blocked by pnpm is treated as absent rather than handed to fluent-ffmpeg
// as a path with no file behind it.

const path = require('path');

// A file that certainly exists, standing in for a healthy vendored binary.
const REAL_FILE = path.join(__dirname, '..', 'package.json');
const GHOST_FILE = path.join(__dirname, 'no-such-binary-anywhere');

/**
 * Loads ffmpegUtils in an isolated module registry with every environmental
 * fact under test control. Returns the mocks for inspection.
 */
function load({ system, ffmpegBin = REAL_FILE, ffprobeBin = REAL_FILE, vendorBroken = false } = {}) {
    const fluent = Object.assign(jest.fn(() => ({})), {
        setFfmpegPath: jest.fn(),
        setFfprobePath: jest.fn(),
        ffprobe: jest.fn(),
    });
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

    // The resolution block skips itself under jest to keep other suites
    // fast; these tests are the ones that actually want it to run.
    process.env.FFMPEG_RESOLVE_UNDER_TEST = '1';

    jest.isolateModules(() => {
        jest.doMock('child_process', () => ({
            spawnSync: jest.fn(() => ({ status: system ? 0 : 1 })),
        }));
        jest.doMock('fluent-ffmpeg', () => fluent);
        jest.doMock('../src/utils/logger', () => log);
        if (vendorBroken) {
            jest.doMock('ffmpeg-static', () => { throw new Error('not installed'); });
            jest.doMock('ffprobe-static', () => { throw new Error('not installed'); });
        } else {
            jest.doMock('ffmpeg-static', () => ffmpegBin);
            jest.doMock('ffprobe-static', () => ({ path: ffprobeBin }));
        }
        require('../src/utils/media/ffmpegUtils');
    });
    return { fluent, log };
}

afterEach(() => {
    jest.resetModules();
    delete process.env.FFMPEG_RESOLVE_UNDER_TEST;
});

describe('ffmpeg binary resolution', () => {
    test('a system ffmpeg wins and the vendored one is never consulted', () => {
        const { fluent } = load({ system: true });
        expect(fluent.setFfmpegPath).not.toHaveBeenCalled();
        expect(fluent.setFfprobePath).not.toHaveBeenCalled();
    });

    test('without a system binary, fluent-ffmpeg is pointed at the vendored one', () => {
        const { fluent, log } = load({ system: false });
        expect(fluent.setFfmpegPath).toHaveBeenCalledWith(REAL_FILE);
        expect(fluent.setFfprobePath).toHaveBeenCalledWith(REAL_FILE);
        // Loudly: this state means the builder skipped the Dockerfile.
        expect(log.warn).toHaveBeenCalled();
    });

    test('a vendored path with no file behind it is treated as absent, not used', () => {
        // The pnpm-blocked-postinstall case: the package resolves, its path
        // is a string, and there is nothing there. Handing that to
        // fluent-ffmpeg would recreate "Cannot find ffmpeg" with extra steps.
        const { fluent, log } = load({ system: false, ffmpegBin: GHOST_FILE, ffprobeBin: GHOST_FILE });
        expect(fluent.setFfmpegPath).not.toHaveBeenCalled();
        expect(fluent.setFfprobePath).not.toHaveBeenCalled();
        expect(log.error).toHaveBeenCalled();
    });

    test('the vendored packages being entirely absent cannot crash the module', () => {
        const { fluent, log } = load({ system: false, vendorBroken: true });
        expect(fluent.setFfmpegPath).not.toHaveBeenCalled();
        expect(log.error).toHaveBeenCalled();
    });
});
