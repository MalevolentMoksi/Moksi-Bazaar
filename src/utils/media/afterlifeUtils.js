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
 * What each one does to a picture:
 *
 *   hell    crushed toward red, contrast up, shadows dug out, a hard vignette
 *           and film grain over the top, with the chroma planes pulled apart
 *           so edges fringe. Reads as a bad VHS of something you should not
 *           be watching.
 *   heaven  overexposed and cooled toward blue, saturation pulled down, and a
 *           blurred copy screened back over itself so every bright thing
 *           blooms. Reads as a memory, or an advert for yoghurt.
 *
 * And to sound: pitch down five half-steps into a cave, or up five into a
 * cathedral. The pitch shift keeps the original duration (asetrate moves pitch
 * and speed together, atempo puts the speed back), because a joke command that
 * silently makes a clip 25% longer is a different command.
 */

const { runFFmpeg, mp4OutputOptions, hasAudio, probeFile, nice, ffmpeg, gifPaletteGen, gifPaletteUse, atempoChain } = require('./ffmpegUtils');
const { createTempPath, cleanup } = require('./tempFiles');
const { isGifInput, staticImageFormatForExt } = require('./formatHelpers');

/** Even dimensions, or libx264 refuses the frame outright. */
const EVEN = 'scale=ceil(iw/2)*2:ceil(ih/2)*2';

/**
 * Planar RGB, forced before the bloom.
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
        // exactly what /tint does and the only model that survives arbitrary
        // input. Two earlier recipes failed here: pushing red into a picture
        // that still held its own greens left a green bar standing in the
        // underworld, and darkening before the mapping turned the whole thing
        // orange-brown. A little saturation is kept so faces still read.
        video: [
            'hue=s=0.10',
            'eq=contrast=1.18:brightness=0.05',
            'lutrgb=r=val*1.10:g=val*0.20:b=val*0.14',
            // PI/6 and not the default-looking PI/3.2, which took a mid-tone
            // from 149 down to 99 on its own and made the whole thing brown.
            'vignette=angle=PI/6',
            'chromashift=cbh=-3:crh=3',
        ],
        grain: 'noise=alls=11:allf=t+u',
        // Screened rather than multiplied. A multiplied blur darkens what is
        // already dark, and stacked on the vignette it took the picture to
        // nearly black; screened, the bright areas bleed like something hot.
        bloom: { mode: 'screen', sigma: 10, opacity: 0.22 },
        semitones: -5,
        audio: [
            'bass=g=7:f=110',
            'aecho=0.85:0.75:70|150:0.5|0.3',
            'lowpass=f=7200',
        ],
    },
    heaven: {
        // Same model in the other direction. The first attempt kept the reds
        // and screened a bloom over them, which is not heaven, it is a
        // nightclub; s=0.26 sounds like "almost grey" and is nothing of the
        // kind, since a pure red still lands a third of the way back.
        video: [
            'hue=s=0.06',
            'eq=contrast=0.95:brightness=0.10:gamma=1.10',
            'lutrgb=r=val*0.86:g=val*0.95:b=val*1.12',
            'deband=1thr=0.02:2thr=0.02:3thr=0.02',
        ],
        // Screened, so bright areas blow out into each other. This is the whole
        // effect; without it heaven is just a cold picture. At 0.55 it washed
        // everything to the same pastel and the picture stopped being legible.
        bloom: { mode: 'screen', sigma: 18, opacity: 0.38 },
        semitones: 5,
        audio: [
            'highpass=f=150',
            'aecho=0.8:0.88:420|700|1050:0.30|0.22|0.15',
            'treble=g=6',
        ],
    },
};

const KINDS = Object.keys(TREATMENTS);

/**
 * The video half of the graph, ending in [v].
 *
 * The bloom is why this is a complex filter and not a `-vf` string: the source
 * has to be read twice, once to blur and once to composite the blur back onto,
 * and a filtergraph link feeds exactly one consumer. split is what makes that
 * legal. Getting it wrong rejects the whole graph with "Error binding
 * filtergraph inputs/outputs", naming nothing.
 */
function videoChain(kind, { input = '0:v', output = 'v', grain = true } = {}) {
    const treatment = TREATMENTS[kind];
    if (!treatment) throw new Error(`Unknown treatment "${kind}"`);

    const filters = [...treatment.video];
    if (grain && treatment.grain) filters.push(treatment.grain);

    const graded = `[${input}]${filters.join(',')},${EVEN},${BLEND_SPACE}`;
    const { mode, sigma, opacity } = treatment.bloom;

    return `${graded},split=2[base_${output}][soft_${output}];`
        + `[soft_${output}]gblur=sigma=${sigma}[bloom_${output}];`
        + `[base_${output}][bloom_${output}]blend=all_mode=${mode}:all_opacity=${opacity}[${output}]`;
}

/**
 * The audio half, ending in [a].
 *
 * asetrate moves pitch and speed together and atempo puts the speed back, which
 * is the same trick /pitch uses; aresample returns the stream to the rate the
 * rest of the pipeline expects.
 */
function audioChain(kind, sampleRate = 44100, { input = '0:a', output = 'a', trimTo = null } = {}) {
    const treatment = TREATMENTS[kind];
    if (!treatment) throw new Error(`Unknown treatment "${kind}"`);

    const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : 44100;
    const shifted = Math.max(1, Math.round(rate * 2 ** (treatment.semitones / 12)));
    const tempo = 2 ** (-treatment.semitones / 12);

    // The echo runs on after the source ends: heaven's longest tap is 1050ms,
    // so a three second clip came out at 4.06 with a second of picture-less
    // audio on the end. Cut to the length of the file it came from, and fade
    // the last fifth of a second so the reverb stops instead of being severed.
    const tail = [];
    if (Number.isFinite(trimTo) && trimTo > 0) {
        const fade = Math.min(0.2, trimTo / 2);
        tail.push(`atrim=end=${trimTo.toFixed(3)}`);
        tail.push(`afade=t=out:st=${(trimTo - fade).toFixed(3)}:d=${fade.toFixed(3)}`);
    }

    return `[${input}]asetrate=r=${shifted},${atempoChain(tempo)},aresample=${rate},`
        + [...treatment.audio, ...tail].join(',')
        + `[${output}]`;
}

/** Both halves, or just the picture when there is no sound to work with. */
function complexChain(kind, { withAudio = false, sampleRate = 44100, trimTo = null } = {}) {
    const video = videoChain(kind);
    return withAudio ? `${video};${audioChain(kind, sampleRate, { trimTo })}` : video;
}

/**
 * The sample rate to work at, and the length to trim the echo back to.
 *
 * The length is the whole file's, not the audio stream's: trimming to the
 * audio's own length would cut the picture short on a clip whose sound stops
 * early, which is an ordinary thing for a clip to do.
 */
async function sourceAudioShape(inputPath) {
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

/** A still: one frame through the same grade, so all three paths agree. */
async function stillAfterlife(inputPath, kind, ext) {
    const format = staticImageFormatForExt(ext);
    const outputPath = createTempPath(format.ext);
    await runFFmpeg(inputPath, outputPath, cmd => {
        cmd
            .complexFilter(videoChain(kind))
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
    const withAudio = await hasAudio(inputPath);
    const { sampleRate, duration } = withAudio
        ? await sourceAudioShape(inputPath)
        : { sampleRate: 44100, duration: null };

    if (audioOnly) {
        const outputPath = createTempPath('m4a');
        await runFFmpeg(inputPath, outputPath, cmd => {
            // No picture to stay in step with, so the tail is left to ring out.
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
    });

    await runFFmpeg(inputPath, outputPath, cmd => {
        cmd
            .complexFilter(complexChain(kind, { withAudio, sampleRate, trimTo: duration }))
            .outputOptions([
                '-map [v]',
                ...(withAudio ? ['-map [a]'] : ['-an']),
                ...outputOptions,
            ]);
    });
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
    TREATMENTS,
    KINDS,
};
