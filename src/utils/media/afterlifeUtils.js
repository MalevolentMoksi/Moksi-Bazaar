// src/utils/media/afterlifeUtils.js
/**
 * /hell and /heaven: two ends of one joke.
 *
 * Both are presets rather than parameters, which is the whole point. A tint
 * command with sliders makes the user do the work; these two do it for them,
 * and the value is entirely in the recipe. So the recipes live here as data,
 * every graph is built by one function, and the plumbing is linted in tests
 * instead of discovered in a channel.
 *
 * The first version was too polite about it. These commit:
 *
 *   hell    near-monochrome blood red with the blacks crushed out and the
 *           highlights blown, a hard rim, chroma planes pulled apart so edges
 *           fringe, film grain, a per-frame brightness flicker, and fire
 *           licking upward off anything bright. It drags: 14% slower, with a
 *           handheld wobble. It speaks in two voices, five half-steps down
 *           and an octave down at once, into a cave.
 *   heaven  washed to near-white and cooled, with the bloom doubled and light
 *           shafts falling through it, opening on a white flash. It lifts: 6%
 *           faster, drifting. It sings in two voices, five half-steps up and
 *           an octave up at once, into a cathedral.
 *
 * Nothing in a filter argument may contain a comma. The filtergraph parser
 * splits on commas before any filter sees its arguments, so an expression like
 * `if(gt(val,150),val,0)` silently becomes three broken filters. Where a
 * threshold is wanted, `eq` with a hard contrast and a negative brightness
 * does the same job and takes no commas to do it.
 */

const { runFFmpeg, mp4OutputOptions, hasAudio, probeFile, nice, ffmpeg, gifPaletteGen, gifPaletteUse, atempoChain } = require('./ffmpegUtils');
const { createTempPath, cleanup } = require('./tempFiles');
const { isGifInput, staticImageFormatForExt } = require('./formatHelpers');

/**
 * Dimensions divisible by four, which does two jobs.
 *
 * libx264 refuses odd dimensions outright, and the bloom and the shafts are
 * computed on a quarter-size copy: a blur costs per pixel, and there are
 * sixteen times fewer of them down there. That round trip is only exact when
 * the frame divides by four, and blend rejects two inputs whose sizes differ
 * by even one pixel, so this is what makes the optimisation legal rather than
 * a source of "Invalid argument" on odd-sized clips.
 */
const QUARTERABLE = 'scale=ceil(iw/4)*4:ceil(ih/4)*4';

/** How much smaller the blurred branches are computed. */
const BLUR_DIVISOR = 4;

/**
 * A ceiling on one render.
 *
 * These are the heaviest filters in the bot: measured at roughly one second
 * per second of 720x1280 footage, where the filters are 7s of an 8.8s run and
 * the encode is the other 0.8. The input cap is 64MB, which can be several
 * minutes of video, and a media job holds a slot in a shared semaphore while
 * it runs. Three minutes is longer than any clip worth damning and turns an
 * unbounded hold into an error somebody can read.
 */
const RENDER_TIMEOUT_MS = 180_000;

/** Wraps a branch so it runs at quarter size and comes back the size it was. */
function atQuarterSize(filters) {
    return [
        `scale=iw/${BLUR_DIVISOR}:ih/${BLUR_DIVISOR}`,
        ...filters,
        `scale=iw*${BLUR_DIVISOR}:ih*${BLUR_DIVISOR}`,
    ].join(',');
}

/** A blur radius means a distance on the picture, so it shrinks with it. */
const scaled = value => Number((value / BLUR_DIVISOR).toFixed(2));

/**
 * Planar RGB, forced before any blend.
 *
 * blend works plane by plane, and on yuv420p two of those planes are chroma
 * centred on 128. Screening them is arithmetic on a number that is not a
 * brightness: screen(128,128) lands near 191, which is a colour cast applied
 * evenly to the whole frame. It put a magenta wash over hell that the graded
 * frames going into the blend did not have, so it looked like an encoder bug
 * rather than the filter doing exactly what it was asked.
 */
const BLEND_SPACE = 'format=gbrp';

const TREATMENTS = {
    hell: {
        // Luminance first, then multiply toward the target colour, which is
        // what /tint does and the only model that survives arbitrary input.
        // Two earlier recipes failed here: pushing red into a picture that
        // still held its own greens left a green bar standing in the
        // underworld, and darkening before the mapping turned it orange-brown.
        grade: [
            'hue=s=0.04',
            'eq=contrast=1.55:brightness=-0.02:gamma=0.82',
            'lutrgb=r=val*1.45:g=val*0.11:b=val*0.07',
            // A rim, not a grade. At PI/3.2 this took a mid-tone from 149 down
            // to 99 by itself and made the whole picture brown.
            'vignette=angle=PI/4.4',
            'chromashift=cbh=-5:crh=5',
            // No commas: the expression is one term on purpose.
            "eq=brightness='0.05*sin(t*17)':eval=frame",
        ],
        grain: 'noise=alls=22:allf=t+u',
        motion: {
            // It drags. Anything past about 1.2 stops reading as menace and
            // starts reading as a broken download.
            speed: 1.14,
            wobble: 'crop=iw-10:ih-10:5+4*sin(t*9):5+4*cos(t*7)',
            fade: null,
        },
        bloom: { mode: 'screen', sigma: 14, sigmaV: 14, opacity: 0.40 },
        // Fire: crush everything but the highlights, smear what is left
        // upward, push it red, and screen it back on.
        rays: {
            crush: 'eq=contrast=2.2:brightness=-0.38',
            sigma: 5,
            sigmaV: 34,
            tint: 'lutrgb=r=val*1.30:g=val*0.14:b=val*0.04',
            mode: 'screen',
            opacity: 0.45,
        },
        semitones: -5,
        audio: [
            'bass=g=9:f=110',
            'aecho=0.85:0.75:70|150:0.5|0.3',
            'lowpass=f=7200',
        ],
        // The second voice. Memes do this and it is most of why they land: a
        // single pitched-down track sounds slowed, two at once sound possessed.
        layer: { semitones: -12, volume: 0.60, chain: 'lowpass=f=2600' },
    },
    heaven: {
        grade: [
            'hue=s=0.04',
            'eq=contrast=0.86:brightness=0.24:gamma=1.32',
            'lutrgb=r=val*0.80:g=val*0.92:b=val*1.30',
            'deband=1thr=0.02:2thr=0.02:3thr=0.02',
        ],
        grain: null,
        motion: {
            speed: 0.94,
            wobble: 'crop=iw-6:ih-6:3+2*sin(t*0.7):3+2*cos(t*0.5)',
            fade: 'fade=t=in:st=0:d=0.35:color=white',
        },
        // Doubled from the version that was too polite. This is the effect;
        // without it heaven is just a cold picture.
        bloom: { mode: 'screen', sigma: 26, sigmaV: 26, opacity: 0.70 },
        // Light shafts: the same trick as the fire, smeared vertically and
        // left its own colour.
        rays: {
            crush: 'eq=contrast=2.4:brightness=-0.42',
            sigma: 6,
            sigmaV: 64,
            tint: null,
            mode: 'screen',
            opacity: 0.50,
        },
        semitones: 5,
        audio: [
            'highpass=f=150',
            'aecho=0.8:0.88:420|700|1050:0.30|0.22|0.15',
            'treble=g=6',
        ],
        layer: { semitones: 12, volume: 0.40, chain: 'highpass=f=900' },
    },
};

const KINDS = Object.keys(TREATMENTS);

/**
 * The video half of the graph, ending in [v].
 *
 * Three branches off one split: the picture, a blurred copy for the bloom, and
 * a crushed copy for the fire or the shafts. A filtergraph link feeds exactly
 * ONE consumer, so reading the graded frame three times without a split
 * rejects the entire graph with "Error binding filtergraph inputs/outputs",
 * naming nothing. That is what took /speechbubble down on every animated GIF.
 *
 * @param {'hell'|'heaven'} kind
 * @param {{input?: string, output?: string, grain?: boolean, motion?: boolean}} opts
 *   grain comes off for GIFs, motion for stills; both default on.
 */
function videoChain(kind, { input = '0:v', output = 'v', grain = true, motion = true } = {}) {
    const treatment = TREATMENTS[kind];
    if (!treatment) throw new Error(`Unknown treatment "${kind}"`);

    const pre = [];
    // Before the grade so the crop cannot leave odd dimensions behind, and
    // before the split so every branch is the same size. blend demands it.
    if (motion && treatment.motion.wobble) pre.push(treatment.motion.wobble);
    if (motion && treatment.motion.speed !== 1) pre.push(`setpts=${treatment.motion.speed}*PTS`);

    const filters = [...pre, ...treatment.grade];
    if (grain && treatment.grain) filters.push(treatment.grain);

    const tag = output;
    const { mode, sigma, sigmaV, opacity } = treatment.bloom;
    const rays = treatment.rays;
    const fade = motion && treatment.motion.fade ? `,${treatment.motion.fade}` : '';

    const bloomBranch = atQuarterSize([`gblur=sigma=${scaled(sigma)}:sigmaV=${scaled(sigmaV)}`]);
    const rayBranch = atQuarterSize([
        rays.crush,
        `gblur=sigma=${scaled(rays.sigma)}:sigmaV=${scaled(rays.sigmaV)}`,
        ...(rays.tint ? [rays.tint] : []),
    ]);

    return `[${input}]${filters.join(',')},${QUARTERABLE},${BLEND_SPACE},split=3[base_${tag}][soft_${tag}][ray_${tag}];`
        + `[soft_${tag}]${bloomBranch}[bloom_${tag}];`
        + `[ray_${tag}]${rayBranch}[rays_${tag}];`
        + `[base_${tag}][bloom_${tag}]blend=all_mode=${mode}:all_opacity=${opacity}[lit_${tag}];`
        + `[lit_${tag}][rays_${tag}]blend=all_mode=${rays.mode}:all_opacity=${rays.opacity}${fade}[${tag}]`;
}

/**
 * How much to slow the audio so it lands the same length as the picture.
 *
 * asetrate moves pitch and speed together: shifting down by five half-steps
 * makes the clip 33% longer on its own. atempo has to put back exactly that
 * much, minus whatever slowdown the picture is taking, or the two streams
 * drift apart and the file is longer than either of them.
 */
function tempoFor(semitones, speed = 1) {
    return 2 ** (-semitones / 12) / speed;
}

/** One voice: pitched, sped to match the picture, then coloured. */
function voice(semitones, rate, speed, filters, { input, output, volume = null }) {
    const shifted = Math.max(1, Math.round(rate * 2 ** (semitones / 12)));
    const parts = [
        `asetrate=r=${shifted}`,
        atempoChain(tempoFor(semitones, speed)),
        `aresample=${rate}`,
        ...filters,
    ];
    if (volume != null) parts.push(`volume=${volume}`);
    return `[${input}]${parts.join(',')}[${output}]`;
}

/**
 * The audio half, ending in [a]. Two voices at once, mixed and limited.
 *
 * The mix is unnormalised so the second voice adds to the first rather than
 * halving it, which means it can clip; alimiter catches that instead of
 * leaving it to the encoder.
 */
function audioChain(kind, sampleRate = 44100, { input = '0:a', output = 'a', trimTo = null, speed = 1 } = {}) {
    const treatment = TREATMENTS[kind];
    if (!treatment) throw new Error(`Unknown treatment "${kind}"`);

    const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : 44100;
    const tag = output;

    // The echo runs on after the source ends: heaven's longest tap is 1050ms,
    // so a three second clip came out at 4.06 with a second of picture-less
    // audio on the end. Cut to the length the picture will be, and fade the
    // last fifth of a second so the reverb stops instead of being severed.
    const tail = [];
    if (Number.isFinite(trimTo) && trimTo > 0) {
        const fade = Math.min(0.2, trimTo / 2);
        tail.push(`atrim=end=${trimTo.toFixed(3)}`);
        tail.push(`afade=t=out:st=${(trimTo - fade).toFixed(3)}:d=${fade.toFixed(3)}`);
    }

    const layer = treatment.layer;
    if (!layer) {
        const single = voice(treatment.semitones, rate, speed, [...treatment.audio, ...tail], {
            input, output: tag,
        });
        return single;
    }

    const mix = [
        `[main_${tag}][sub_${tag}]amix=inputs=2:weights=1 ${layer.volume}:normalize=0`,
        'alimiter=limit=0.95',
        ...tail,
    ].join(',');

    return `[${input}]asplit=2[dry_${tag}][wet_${tag}];`
        + `${voice(treatment.semitones, rate, speed, treatment.audio, { input: `dry_${tag}`, output: `main_${tag}` })};`
        + `${voice(layer.semitones, rate, speed, [layer.chain], { input: `wet_${tag}`, output: `sub_${tag}`, volume: layer.volume })};`
        + `${mix}[${tag}]`;
}

/** Both halves, or just the picture when there is no sound to work with. */
function complexChain(kind, { withAudio = false, sampleRate = 44100, trimTo = null, speed = 1 } = {}) {
    const video = videoChain(kind);
    return withAudio ? `${video};${audioChain(kind, sampleRate, { trimTo, speed })}` : video;
}

/** How much longer or shorter this treatment makes a clip. */
function speedOf(kind, motion = true) {
    return motion ? TREATMENTS[kind].motion.speed : 1;
}

/**
 * The sample rate to work at, and the length to trim the echo back to.
 *
 * The length is the whole file's, not the audio stream's: trimming to the
 * audio's own length would cut the picture short on a clip whose sound stops
 * early, which is an ordinary thing for a clip to do.
 */
async function sourceShape(inputPath) {
    try {
        const data = await probeFile(inputPath);
        const stream = data.streams?.find(s => s.codec_type === 'audio');
        const duration = Number(data.format?.duration);
        return {
            sampleRate: parseInt(stream?.sample_rate, 10) || 44100,
            duration: Number.isFinite(duration) && duration > 0 ? duration : null,
        };
    } catch {
        return { sampleRate: 44100, duration: null };
    }
}

/**
 * A still: one frame through the same grade, so all three paths agree.
 * Motion is off, since a wobble and a flash need frames to happen over.
 */
async function stillAfterlife(inputPath, kind, ext) {
    const format = staticImageFormatForExt(ext);
    const outputPath = createTempPath(format.ext);
    await runFFmpeg(inputPath, outputPath, cmd => {
        cmd
            .complexFilter(videoChain(kind, { motion: false }))
            .outputOptions(['-map [v]', '-frames:v 1']);
    });
    return outputPath;
}

/**
 * A GIF, which has no sound and cannot keep 24-bit colour. Two passes so the
 * palette is built from the graded frames rather than the original ones: a
 * palette generated before the grade has no reds in it to give hell.
 */
async function gifAfterlife(inputPath, kind) {
    // Without the grain. GIF compresses by not repeating what did not change,
    // and film grain changes every pixel of every frame: a 90KB source came
    // back at 954KB, a ten-fold blowup that the size guard then has to claw
    // back by degrading the picture. A still keeps its grain, since there are
    // no other frames for it to fight with.
    const chain = videoChain(kind, { grain: false });
    const palettePath = createTempPath('png');
    const outputPath = createTempPath('gif');
    try {
        await runFFmpeg(inputPath, palettePath, cmd => {
            cmd.complexFilter(`${chain};[v]${gifPaletteGen()}[p]`).outputOptions(['-map [p]']);
        });
        await new Promise((resolve, reject) => {
            nice(ffmpeg(inputPath))
                .input(palettePath)
                .complexFilter(`${chain};[v][1:v]${gifPaletteUse()}[out]`)
                .outputOptions(['-map [out]', '-an', '-loop 0', '-gifflags -offsetting'])
                .on('end', resolve)
                .on('error', err => reject(new Error(`FFmpeg GIF error: ${err.message}`)))
                .save(outputPath);
        });
        return outputPath;
    } catch (err) {
        await cleanup(outputPath);
        throw err;
    } finally {
        await cleanup(palettePath);
    }
}

/**
 * A video, or an audio file with no picture at all.
 *
 * A video with no audio track is ordinary and must not be treated as an error:
 * asking ffmpeg to filter [0:a] when there is no [0:a] fails the whole run with
 * a message about stream specifiers, so the audio half is only built when there
 * is something to build it from.
 */
async function videoAfterlife(inputPath, kind, { audioOnly = false } = {}) {
    const withAudio = audioOnly || await hasAudio(inputPath);
    const { sampleRate, duration } = withAudio
        ? await sourceShape(inputPath)
        : { sampleRate: 44100, duration: null };
    const speed = speedOf(kind);

    if (audioOnly) {
        const outputPath = createTempPath('m4a');
        await runFFmpeg(inputPath, outputPath, cmd => {
            // No picture to stay in step with, so it neither speeds up nor
            // gets its tail cut: the reverb ringing out is the effect working.
            cmd
                .complexFilter(audioChain(kind, sampleRate))
                .outputOptions(['-map [a]', '-vn', '-c:a aac', '-b:a 192k']);
        });
        return outputPath;
    }

    const outputPath = createTempPath('mp4');
    const outputOptions = await mp4OutputOptions(inputPath, {
        targetBytes: 16 * 1024 * 1024,
        qualityMultiplier: 1.55,
        maxVideoKbps: 2200,
        maxAudioKbps: 96,
        includeAudio: withAudio,
        // The clip is going to be longer or shorter than it was, and the
        // bitrate budget is worked out from its length.
        durationMultiplier: speed,
    });

    await runFFmpeg(inputPath, outputPath, cmd => {
        cmd
            .complexFilter(complexChain(kind, {
                withAudio,
                sampleRate,
                speed,
                trimTo: duration == null ? null : duration * speed,
            }))
            .outputOptions([
                '-map [v]',
                ...(withAudio ? ['-map [a]'] : ['-an']),
                ...outputOptions,
            ]);
    }, { timeoutMs: RENDER_TIMEOUT_MS });
    return outputPath;
}

/** The one entry point the commands use. */
async function afterlife(inputPath, kind, ext = '', mediaContext = {}) {
    if (!TREATMENTS[kind]) throw new Error(`Unknown treatment "${kind}"`);
    if (mediaContext?.isAudio) return videoAfterlife(inputPath, kind, { audioOnly: true });
    if (await isGifInput(inputPath, ext, mediaContext)) return gifAfterlife(inputPath, kind);
    if (mediaContext?.isVideo) return videoAfterlife(inputPath, kind);
    return stillAfterlife(inputPath, kind, ext);
}

module.exports = {
    afterlife,
    // Pure, and exported so the graphs can be linted without ffmpeg or a video.
    videoChain,
    audioChain,
    complexChain,
    tempoFor,
    speedOf,
    TREATMENTS,
    KINDS,
};
