// tests/afterlife.test.js
//
// /hell and /heaven are presets, so almost everything that can go wrong with
// them is in the recipe rather than in the code around it. These pin the three
// things a recipe cannot be trusted with:
//
//   the plumbing   both graphs read the graded frame three times, for the
//                  picture, the bloom and the fire. A filtergraph link feeds
//                  exactly ONE consumer; that is the fault that took
//                  /speechbubble down on every animated GIF, and it is the
//                  same linter pointed at these graphs.
//   the arithmetic each treatment now moves BOTH the pitch and the speed, in
//                  two voices at once, and every one of those has to land on
//                  the same duration as the picture or the file ends up longer
//                  than either stream in it.
//   the spaces     blend works plane by plane. On yuv420p two of those planes
//                  are chroma centred on 128, so screening them lays an even
//                  colour cast over the frame; it put a magenta wash over hell
//                  that looked exactly like an encoder bug.
//
// The grade itself is taste and is not pinned. Its bounds are: a vignette has
// to stay a rim, and the frame has to stay divisible by four.

const { lintFiltergraph } = require('./support/filtergraph');
const {
    videoChain, audioChain, complexChain, tempoFor, speedOf, TREATMENTS, KINDS,
} = require('../src/utils/media/afterlifeUtils');
const commands = require('../src/commands/media/afterlife');

describe('both graphs are plumbed correctly', () => {
    test.each(KINDS)('%s: the video half is sound', (kind) => {
        expect(lintFiltergraph(videoChain(kind), { inputs: 1 })).toEqual([]);
    });

    test.each(KINDS)('%s: video and audio together are sound', (kind) => {
        expect(lintFiltergraph(complexChain(kind, { withAudio: true }), { inputs: 1 })).toEqual([]);
    });

    test.each(KINDS)('%s: every variant is sound, not just the default one', (kind) => {
        for (const opts of [{ grain: false }, { motion: false }, { grain: false, motion: false }]) {
            expect(lintFiltergraph(videoChain(kind, opts), { inputs: 1 })).toEqual([]);
        }
    });

    // The bug class borrowed from /speechbubble: a link feeds one consumer, and
    // a bloom is by definition the graded frame read more than once.
    test.each(KINDS)('%s: the three readers go through a split', (kind) => {
        expect(videoChain(kind)).toContain('split=3');

        // The obvious way to write it, which is the shape /speechbubble
        // shipped: blur the graded frame and composite it back onto itself.
        const unsplit = `[0:v]${TREATMENTS[kind].grade.join(',')}[g];`
            + '[g]gblur=sigma=10[bloom];'
            + '[g][bloom]blend=all_mode=screen[v]';
        expect(lintFiltergraph(unsplit, { inputs: 1 }))
            .toEqual([expect.stringContaining('[g] is read 2 times')]);
    });

    test.each(KINDS)('%s: the blend happens in RGB, not on chroma planes', (kind) => {
        const chain = videoChain(kind);
        expect(chain.indexOf('format=gbrp')).toBeGreaterThan(-1);
        expect(chain.indexOf('format=gbrp')).toBeLessThan(chain.indexOf('blend='));
    });

    // blend rejects two inputs whose sizes differ by a single pixel, and the
    // blurred branches go down to a quarter and come back. That round trip is
    // only exact when the frame divides by four, which is why the frame is
    // forced to a multiple of four rather than merely to even.
    test.each(KINDS)('%s: the quarter-size round trip can be exact', (kind) => {
        const chain = videoChain(kind);
        expect(chain).toContain('scale=ceil(iw/4)*4:ceil(ih/4)*4');
        expect(chain.match(/scale=iw\/4:ih\/4/g)).toHaveLength(2);
        expect(chain.match(/scale=iw\*4:ih\*4/g)).toHaveLength(2);
        // And the forcing happens before the split, so all three agree.
        expect(chain.indexOf('ceil(iw/4)')).toBeLessThan(chain.indexOf('split=3'));
    });

    test('the labels are namespaced, so two graphs could be built into one', () => {
        const combined = `${videoChain('hell', { output: 'a' })};${videoChain('heaven', { input: 'a', output: 'b' })}`;
        expect(lintFiltergraph(combined, { inputs: 1 })).toEqual([]);
    });

    test('an unknown treatment is refused rather than silently rendered', () => {
        expect(() => videoChain('purgatory')).toThrow(/purgatory/);
        expect(() => audioChain('purgatory')).toThrow(/purgatory/);
    });

    // The filtergraph parser splits on commas before any filter sees its
    // arguments, so `if(gt(val,150),val,0)` silently becomes three broken
    // filters. Every threshold here is an eq instead, for that reason.
    test.each(KINDS)('%s: no filter argument hides a comma', (kind) => {
        for (const segment of videoChain(kind).split(';')) {
            const body = segment.replace(/^(\[[^\]]+\])+/, '').replace(/(\[[^\]]+\])+$/, '');
            for (const filter of body.split(',')) {
                expect(filter).not.toMatch(/^\s*[a-z]*\(/);
            }
        }
    });
});

describe('what leaves is as long as the picture', () => {
    /** Every pitched branch in a chain, with what it does to duration. */
    const voices = (chain, rate) => chain.split(';')
        .filter(segment => segment.includes('asetrate='))
        .map((segment) => {
            const asetrate = Number(segment.match(/asetrate=r=(\d+)/)[1]);
            const tempo = [...segment.matchAll(/atempo=([\d.]+)/g)]
                .reduce((product, m) => product * Number(m[1]), 1);
            // asetrate=X on a stream recorded at `rate` plays it X/rate faster;
            // atempo divides the duration again.
            return { asetrate, tempo, duration: (rate / asetrate) / tempo };
        });

    test.each(KINDS)('%s: both voices land on the length the picture will be', (kind) => {
        const speed = speedOf(kind);
        for (const voice of voices(audioChain(kind, 48000, { speed }), 48000)) {
            expect(voice.duration).toBeCloseTo(speed, 2);
        }
    });

    test.each(KINDS)('%s: at speed 1 they land on the original length', (kind) => {
        for (const voice of voices(audioChain(kind, 48000), 48000)) {
            expect(voice.duration).toBeCloseTo(1, 2);
        }
    });

    test('the picture and the sound are asked for the same speed', () => {
        for (const kind of KINDS) {
            const speed = speedOf(kind);
            expect(videoChain(kind)).toContain(`setpts=${speed}*PTS`);
        }
    });

    test('tempoFor is the arithmetic, stated once', () => {
        // Down five half-steps stretches a clip by 2^(5/12); to come out 14%
        // longer overall, atempo has to give back all but that 14%.
        expect(tempoFor(-5, 1)).toBeCloseTo(2 ** (5 / 12), 4);
        expect(tempoFor(-5, 1.14)).toBeCloseTo(2 ** (5 / 12) / 1.14, 4);
        expect(tempoFor(0, 1)).toBe(1);
    });

    test.each(KINDS)('%s: the stream comes back at the rate it went in', (kind) => {
        expect(audioChain(kind, 48000)).toContain('aresample=48000');
        expect(audioChain(kind, 22050)).toContain('aresample=22050');
    });

    test('a nonsense sample rate falls back rather than producing asetrate=r=0', () => {
        for (const bad of [0, -1, NaN, null, undefined]) {
            expect(audioChain('hell', bad)).toContain('aresample=44100');
        }
    });
});

describe('two voices, not one', () => {
    test.each(KINDS)('%s: the track is split, shifted twice, and mixed', (kind) => {
        const chain = audioChain(kind, 44100);
        expect(chain).toContain('asplit=2');
        expect(chain.match(/asetrate=/g)).toHaveLength(2);
        expect(chain).toContain('amix=inputs=2');
    });

    test.each(KINDS)('%s: the second voice is an octave from the first', (kind) => {
        const t = TREATMENTS[kind];
        expect(Math.abs(t.layer.semitones)).toBe(12);
        // And on the same side, or it is a chord rather than a doubling.
        expect(Math.sign(t.layer.semitones)).toBe(Math.sign(t.semitones));
    });

    test.each(KINDS)('%s: the mix adds rather than halves, and is limited', (kind) => {
        // amix normalises by default, which would make adding a second voice
        // quieter than not adding one. Unnormalised it can clip, so it is
        // limited rather than left to the encoder.
        const chain = audioChain(kind, 44100);
        expect(chain).toContain('normalize=0');
        expect(chain).toContain('alimiter=');
        expect(chain.indexOf('amix')).toBeLessThan(chain.indexOf('alimiter'));
    });

    test.each(KINDS)('%s: the second voice sits under the first', (kind) => {
        expect(TREATMENTS[kind].layer.volume).toBeLessThan(1);
        expect(audioChain(kind, 44100)).toContain(`volume=${TREATMENTS[kind].layer.volume}`);
    });
});

describe('the echo does not outlive the picture', () => {
    // Measured before this existed: a 3.00s clip came back at 4.06s, because
    // heaven's longest echo tap is 1050ms and it rang on past the last frame.
    test.each(KINDS)('%s: given a length, the tail is trimmed to it', (kind) => {
        const chain = audioChain(kind, 44100, { trimTo: 3 });
        expect(chain).toContain('atrim=end=3.000');
        expect(chain).toMatch(/afade=t=out:st=2\.800:d=0\.200/);
    });

    test('the fade never starts before the clip does', () => {
        const chain = audioChain('heaven', 44100, { trimTo: 0.2 });
        const start = Number(chain.match(/afade=t=out:st=([\d.]+)/)[1]);
        expect(start).toBeGreaterThanOrEqual(0);
    });

    test('with no length to trim to, nothing is trimmed', () => {
        // The audio-only path, where there is no picture to stay in step with
        // and the tail ringing out is the effect working.
        const chain = audioChain('hell', 44100);
        expect(chain).not.toContain('atrim');
        expect(chain).not.toContain('afade');
    });

    test('trimming is skipped for a duration that makes no sense', () => {
        for (const bad of [0, -3, NaN, null]) {
            expect(audioChain('hell', 44100, { trimTo: bad })).not.toContain('atrim');
        }
    });

    test('the trim happens after the mix, so it catches both voices', () => {
        const chain = audioChain('heaven', 44100, { trimTo: 3 });
        expect(chain.indexOf('amix')).toBeLessThan(chain.indexOf('atrim'));
    });
});

describe('motion belongs to things that move', () => {
    test.each(KINDS)('%s: a still gets no wobble, no drift, no re-timing', (kind) => {
        const still = videoChain(kind, { motion: false });
        expect(still).not.toContain('setpts');
        expect(still).not.toContain('crop=');
        expect(still).not.toContain('fade=t=in');
    });

    test.each(KINDS)('%s: a video gets all three', (kind) => {
        const moving = videoChain(kind);
        expect(moving).toContain('setpts=');
        expect(moving).toContain('crop=');
    });

    test('only heaven opens on a flash, because only heaven should', () => {
        expect(videoChain('heaven')).toContain('fade=t=in');
        expect(videoChain('hell')).not.toContain('fade=t=in');
    });

    test('the crop happens before the split, so every branch is one size', () => {
        for (const kind of KINDS) {
            const chain = videoChain(kind);
            expect(chain.indexOf('crop=')).toBeLessThan(chain.indexOf('split=3'));
        }
    });

    test('a still is not re-timed, so its speed is 1', () => {
        for (const kind of KINDS) {
            expect(speedOf(kind, false)).toBe(1);
            expect(speedOf(kind)).toBe(TREATMENTS[kind].motion.speed);
        }
    });

    test('neither treatment moves the length by more than a fifth', () => {
        // The limit agreed for this: a clip may come back noticeably longer or
        // shorter, but not so much that it stops being the clip.
        for (const kind of KINDS) {
            expect(Math.abs(1 - speedOf(kind))).toBeLessThanOrEqual(0.2);
        }
    });
});

describe('the recipes stay opposites', () => {
    test('every treatment is complete', () => {
        for (const kind of KINDS) {
            const t = TREATMENTS[kind];
            expect(t.grade.length).toBeGreaterThan(0);
            expect(t.audio.length).toBeGreaterThan(0);
            expect(t.bloom).toMatchObject({ mode: expect.any(String), sigma: expect.any(Number) });
            expect(t.rays).toMatchObject({ crush: expect.any(String), sigma: expect.any(Number) });
            expect(t.layer).toMatchObject({ semitones: expect.any(Number), volume: expect.any(Number) });
            expect(t.motion).toMatchObject({ speed: expect.any(Number) });
        }
    });

    test('hell darkens and drags; heaven brightens and lifts', () => {
        const brightness = kind => Number(TREATMENTS[kind].grade.join(',').match(/brightness=(-?[\d.]+)/)[1]);
        expect(brightness('hell')).toBeLessThan(brightness('heaven'));
        expect(speedOf('hell')).toBeGreaterThan(1);
        expect(speedOf('heaven')).toBeLessThan(1);
    });

    // A vignette at PI/3.2 took a mid-tone from 149 to 99 by itself and turned
    // the whole picture brown. It is a rim, not a grade.
    test('the vignette stays a rim', () => {
        const vignette = TREATMENTS.hell.grade.find(f => f.startsWith('vignette'));
        expect(vignette).toMatch(/PI\/(4\.[2-9]|[5-9]|\d{2,})/);
    });

    test('the grain comes off for GIFs and stays on everywhere else', () => {
        expect(videoChain('hell')).toContain('noise=');
        expect(videoChain('hell', { grain: false })).not.toContain('noise=');
    });

    test('a treatment with no grain is unaffected by the switch', () => {
        expect(videoChain('heaven')).toBe(videoChain('heaven', { grain: false }));
    });
});

describe('the commands', () => {
    test('there are two, named after the places', () => {
        expect(commands.map(c => c.data.name).sort()).toEqual(['heaven', 'hell']);
    });

    test('neither asks for anything, which is the point of a preset', () => {
        for (const command of commands) {
            const options = command.data.toJSON().options ?? [];
            expect(options.map(o => o.name)).toEqual(['media']);
            expect(options[0].required).toBeFalsy();
        }
    });

    test('both accept everything the effect can actually treat', () => {
        for (const command of commands) {
            expect(typeof command.execute).toBe('function');
        }
        expect(require('fs').readFileSync(require.resolve('../src/commands/media/afterlife'), 'utf8'))
            .toContain('allowAudio: true');
    });

    test('a description says what it does to sound as well as to pictures', () => {
        for (const command of commands) {
            expect(command.data.description).toMatch(/sound|audio/i);
            expect(command.data.description.length).toBeLessThanOrEqual(100);
        }
    });
});
