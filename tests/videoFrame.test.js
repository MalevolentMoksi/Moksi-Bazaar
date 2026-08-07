// tests/videoFrame.test.js
//
// A video uploaded straight to Discord carries no embed and therefore no
// thumbnail, so the media pipeline had nothing to look at and fell back to the
// filename. The prompt tells the model to trust media tags, so it reacted to
// the filename with total confidence: "mp4 huh. groundbreaking."
//
// These pin the sampling path that replaced that, and in particular the parts
// that must not hang or leak, because a reply is waiting on them.

const mockState = {
    downloaded: [],
    cleaned: [],
    ffmpegCalls: [],
    ffmpegImpl: null,
    probeImpl: null,
    frameBytes: Buffer.from('jpegbytes'),
    downloadImpl: null,
};

jest.mock('../src/utils/media/tempFiles', () => ({
    downloadToTemp: jest.fn(async (url) => {
        if (mockState.downloadImpl) return mockState.downloadImpl(url);
        mockState.downloaded.push(url);
        return '/tmp/video.mp4';
    }),
    createTempPath: jest.fn(() => '/tmp/frame.jpg'),
    cleanup: jest.fn(async (...paths) => { mockState.cleaned.push(...paths); }),
}));

jest.mock('../src/utils/media/ffmpegUtils', () => ({
    runFFmpeg: jest.fn(async (input, output, configure) => {
        mockState.ffmpegCalls.push({ input, output });
        // Exercise the caller's configuration the way fluent-ffmpeg would.
        const seen = { seek: null, frames: null, options: null };
        configure({
            seekInput(s) { seen.seek = s; return this; },
            frames(n) { seen.frames = n; return this; },
            outputOptions(o) { seen.options = o; return this; },
        });
        mockState.ffmpegCalls[mockState.ffmpegCalls.length - 1].seen = seen;
        if (mockState.ffmpegImpl) return mockState.ffmpegImpl();
        return undefined;
    }),
    probeFile: jest.fn(async () => (mockState.probeImpl ? mockState.probeImpl() : { format: { duration: 8 } })),
}));

jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    readFileSync: jest.fn(() => mockState.frameBytes),
}));

const { firstFrameDataUri, pickSeekSeconds, MAX_VIDEO_BYTES } = require('../src/utils/media/videoFrame');
const { cleanup, downloadToTemp } = require('../src/utils/media/tempFiles');
const { runFFmpeg } = require('../src/utils/media/ffmpegUtils');

beforeEach(() => {
    mockState.downloaded = [];
    mockState.cleaned = [];
    mockState.ffmpegCalls = [];
    mockState.ffmpegImpl = null;
    mockState.probeImpl = null;
    mockState.downloadImpl = null;
    mockState.frameBytes = Buffer.from('jpegbytes');
    jest.clearAllMocks();
});

describe('sampling a frame', () => {
    test('returns a jpeg data URI the vision call can take as a url', async () => {
        const uri = await firstFrameDataUri('https://cdn.invalid/clip.mp4');
        expect(uri).toBe(`data:image/jpeg;base64,${Buffer.from('jpegbytes').toString('base64')}`);
        expect(mockState.downloaded).toEqual(['https://cdn.invalid/clip.mp4']);
    });

    test('it seeks past the opening, where clips are black or a logo', async () => {
        await firstFrameDataUri('https://cdn.invalid/clip.mp4');
        const { seen } = mockState.ffmpegCalls[0];
        expect(seen.seek).toBeGreaterThan(0);
        expect(seen.frames).toBe(1);
        expect(seen.options.join(' ')).toContain('scale=512:-2');
    });

    test('a very short clip is sampled from the start rather than past its end', async () => {
        mockState.probeImpl = () => ({ format: { duration: 0.4 } });
        expect(await pickSeekSeconds('/tmp/x.mp4')).toBe(0);

        mockState.probeImpl = () => ({ format: { duration: 4 } });
        expect(await pickSeekSeconds('/tmp/x.mp4')).toBe(1);

        // Long clips stop walking forward; a frame at 1.5s is representative.
        mockState.probeImpl = () => ({ format: { duration: 600 } });
        expect(await pickSeekSeconds('/tmp/x.mp4')).toBe(1.5);
    });

    test('an unreadable duration still samples rather than giving up', async () => {
        mockState.probeImpl = () => { throw new Error('not a video'); };
        expect(await pickSeekSeconds('/tmp/x.mp4')).toBe(0);
    });
});

describe('refusing to be a liability', () => {
    test('an oversized attachment is skipped before it is ever downloaded', async () => {
        const uri = await firstFrameDataUri('https://cdn.invalid/huge.mp4', {
            sizeBytes: MAX_VIDEO_BYTES + 1,
        });
        expect(uri).toBeNull();
        expect(downloadToTemp).not.toHaveBeenCalled();
    });

    test('a failed download is null, not a throw: the reply still has to go out', async () => {
        mockState.downloadImpl = () => { throw new Error('403'); };
        await expect(firstFrameDataUri('https://cdn.invalid/gone.mp4')).resolves.toBeNull();
    });

    test('a failed encode is null too', async () => {
        mockState.ffmpegImpl = () => { throw new Error('FFmpeg error: bad codec'); };
        await expect(firstFrameDataUri('https://cdn.invalid/weird.mkv')).resolves.toBeNull();
    });

    test('an empty frame counts as nothing seen', async () => {
        mockState.frameBytes = Buffer.alloc(0);
        await expect(firstFrameDataUri('https://cdn.invalid/clip.mp4')).resolves.toBeNull();
    });

    // Temp files land in the container's filesystem, and the janitor is not a
    // reason to leak one per video.
    test('temp files are cleaned up on success and on failure alike', async () => {
        await firstFrameDataUri('https://cdn.invalid/clip.mp4');
        expect(cleanup).toHaveBeenCalled();

        jest.clearAllMocks();
        mockState.ffmpegImpl = () => { throw new Error('boom'); };
        await firstFrameDataUri('https://cdn.invalid/clip.mp4');
        expect(cleanup).toHaveBeenCalled();
    });

    // Rejecting a promise stops nothing: the download and the encode need
    // their own deadlines and the cap has to travel with the request, or a
    // lying server streams past 40 MB while the outer timeout politely waits.
    test('the cap and the deadlines ride along with the download and the encode', async () => {
        await firstFrameDataUri('https://cdn.invalid/clip.mp4');

        const downloadOpts = downloadToTemp.mock.calls[0][2];
        expect(downloadOpts.maxBytes).toBe(MAX_VIDEO_BYTES);
        expect(downloadOpts.timeoutMs).toBeGreaterThan(0);

        const ffmpegOpts = runFFmpeg.mock.calls[0][3];
        expect(ffmpegOpts.timeoutMs).toBeGreaterThan(0);
    });

    // The context builder fires every message's media at once. Five fresh
    // videos must not mean five simultaneous downloads and five ffmpeg
    // processes on a small container.
    test('a channel full of fresh videos is sampled two at a time', async () => {
        let inFlight = 0;
        let peak = 0;
        const gates = [];
        mockState.downloadImpl = () => new Promise(resolve => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            gates.push(() => { inFlight -= 1; resolve('/tmp/video.mp4'); });
        });
        const tick = () => new Promise(resolve => setImmediate(resolve));
        const settle = async () => { for (let i = 0; i < 10; i += 1) await tick(); };

        const jobs = Promise.all([1, 2, 3, 4, 5].map(
            n => firstFrameDataUri(`https://cdn.invalid/${n}.mp4`)
        ));

        await settle();
        expect(gates.length).toBe(2);

        // Finishing one admits exactly one more.
        gates.shift()();
        await settle();
        expect(gates.length).toBe(2);
        expect(peak).toBe(2);

        // Drain the rest so the gate is left clean for the other tests.
        let done = false;
        jobs.then(() => { done = true; });
        while (!done) {
            while (gates.length) gates.shift()();
            await tick();
        }
        expect(peak).toBe(2);
        expect(inFlight).toBe(0);
    });
});
