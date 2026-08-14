// tests/afterlife.test.js
//
// /hell and /heaven are presets, so almost everything that can go wrong with
// them is in the recipe rather than in the code around it. These pin the two
// things a recipe cannot be trusted with:
//
//   the plumbing   both graphs read the source twice for their bloom, which is
//                  the exact fault that took /speechbubble down on every
//                  animated GIF. Same linter, pointed at these graphs.
//   the arithmetic the pitch shift is three filters that have to agree with
//                  each other, and if they do not the clip changes length
//                  instead of changing key.
//
// The grade itself is a matter of taste and is not pinned here. What IS pinned
// is that the blend happens in RGB: blend works plane by plane, and on yuv420p
// two of those planes are chroma centred on 128, so screening them applies an
// even colour cast to the whole frame. That put a magenta wash over hell which
// looked exactly like an encoder bug, and cost an afternoon to find.

const { lintFiltergraph } = require('./support/filtergraph');
const {
    videoChain, audioChain, complexChain, TREATMENTS, KINDS,
} = require('../src/utils/media/afterlifeUtils');
const commands = require('../src/commands/media/afterlife');

describe('both graphs are plumbed correctly', () => {
    test.each(KINDS)('%s: the video half is sound', (kind) => {
        expect(lintFiltergraph(videoChain(kind), { inputs: 1 })).toEqual([]);
    });

    test.each(KINDS)('%s: video and audio together are sound', (kind) => {
        expect(lintFiltergraph(complexChain(kind, { withAudio: true }), { inputs: 1 })).toEqual([]);
    });

    // The bug class this borrows from /speechbubble: a link feeds exactly one
    // consumer, and a bloom is by definition the source read twice.
    test.each(KINDS)('%s: the doubled read goes through a split', (kind) => {
        expect(videoChain(kind)).toContain('split=2');

        // The obvious way to write a bloom, which is the shape /speechbubble
        // shipped: blur the graded frame, composite it back onto the graded
        // frame, and read that label twice. ffmpeg rejects the whole graph.
        const unsplit = `[0:v]${TREATMENTS[kind].video.join(',')}[g];`
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

    // A 90KB GIF came back at 954KB with the grain on: GIF compresses by not
    // repeating what did not change, and grain changes every pixel of every
    // frame. The size guard would then claw it back by degrading the picture,
    // so the picture pays twice for a texture nobody can see at 12fps.
    test('the grain comes off for GIFs and stays on everywhere else', () => {
        expect(videoChain('hell')).toContain('noise=');
        expect(videoChain('hell', { grain: false })).not.toContain('noise=');
        expect(lintFiltergraph(videoChain('hell', { grain: false }), { inputs: 1 })).toEqual([]);
    });

    test('a treatment with no grain is unaffected by the switch', () => {
        expect(videoChain('heaven')).toBe(videoChain('heaven', { grain: false }));
    });

    test('the labels are namespaced, so two graphs could be built into one', () => {
        const combined = `${videoChain('hell', { output: 'a' })};${videoChain('heaven', { input: 'a', output: 'b' })}`;
        expect(lintFiltergraph(combined, { inputs: 1 })).toEqual([]);
    });

    test('an unknown treatment is refused rather than silently rendered', () => {
        expect(() => videoChain('purgatory')).toThrow(/purgatory/);
        expect(() => audioChain('purgatory')).toThrow(/purgatory/);
    });
});

describe('the pitch shift keeps the clip the length it was', () => {
    // asetrate moves pitch and speed together; atempo has to put back exactly
    // the speed asetrate took, or the clip silently changes duration.
    const rateOf = chain => Number(chain.match(/asetrate=r=(\d+)/)[1]);
    const temposOf = chain => [...chain.matchAll(/atempo=([\d.]+)/g)].map(m => Number(m[1]));

    test.each(KINDS)('%s: asetrate and atempo cancel out', (kind) => {
        const chain = audioChain(kind, 48000);
        const shift = rateOf(chain) / 48000;
        const tempo = temposOf(chain).reduce((a, b) => a * b, 1);
        expect(shift * tempo).toBeCloseTo(1, 3);
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

    test('hell goes down and heaven goes up, by the same interval', () => {
        expect(TREATMENTS.hell.semitones).toBe(-TREATMENTS.heaven.semitones);
        expect(rateOf(audioChain('hell', 48000))).toBeLessThan(48000);
        expect(rateOf(audioChain('heaven', 48000))).toBeGreaterThan(48000);
    });
});

describe('the echo does not outlive the picture', () => {
    // Measured, before this existed: a 3.00s clip came back at 4.06s, because
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
});

describe('the recipes stay opposites', () => {
    test('every treatment has both halves and a bloom', () => {
        for (const kind of KINDS) {
            const t = TREATMENTS[kind];
            expect(t.video.length).toBeGreaterThan(0);
            expect(t.audio.length).toBeGreaterThan(0);
            expect(t.bloom).toMatchObject({
                mode: expect.any(String), sigma: expect.any(Number), opacity: expect.any(Number),
            });
        }
    });

    test('hell darkens and heaven brightens', () => {
        const brightness = kind => Number(TREATMENTS[kind].video.join(',').match(/brightness=(-?[\d.]+)/)[1]);
        expect(brightness('hell')).toBeLessThan(brightness('heaven'));
    });

    // A vignette at PI/3.2 took a mid-tone from 149 to 99 by itself and turned
    // the whole picture brown. It is a rim, not a grade.
    test('the vignette stays a rim', () => {
        const angle = TREATMENTS.hell.video.find(f => f.startsWith('vignette'));
        expect(angle).toMatch(/PI\/([6-9]|\d{2,})/);
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
        // Including audio: the grade is half the joke and the pitch is the
        // other half, so an mp3 is a legitimate thing to damn.
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
