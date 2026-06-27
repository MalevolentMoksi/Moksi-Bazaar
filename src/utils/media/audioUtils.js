// src/utils/media/audioUtils.js
// Audio effects ported from MediaForge (processing/ffmpeg/other.py). Each works on
// either a video (keeps the video stream, transforms the audio) or a pure audio
// file (outputs m4a). Video keeps mp4; audio-only outputs m4a (AAC).
const { runFFmpeg, probeFile, mp4OutputOptions, atempoChain } = require('./ffmpegUtils');
const { createTempPath } = require('./tempFiles');

// Decide the output container based on whether the input has a video stream.
async function outputKind(inputPath, isAudioOnly) {
    if (isAudioOnly) return { ext: 'm4a', isVideo: false };
    // A video file: confirm it actually has a video stream (else treat as audio).
    try {
        const probeData = await probeFile(inputPath);
        const hasVideo = probeData.streams?.some(s => s.codec_type === 'video');
        return hasVideo ? { ext: 'mp4', isVideo: true } : { ext: 'm4a', isVideo: false };
    } catch {
        return { ext: 'mp4', isVideo: true };
    }
}

// Apply an audio filter, preserving video when present.
async function applyAudioFilter(inputPath, audioFilter, isAudioOnly) {
    const { ext, isVideo } = await outputKind(inputPath, isAudioOnly);
    const outputPath = createTempPath(ext);
    await runFFmpeg(inputPath, outputPath, cmd => {
        cmd.audioFilters(audioFilter);
        if (isVideo) {
            cmd.outputOptions(['-c:v copy', '-c:a aac', '-b:a 192k']);
        } else {
            cmd.outputOptions(['-vn', '-c:a aac', '-b:a 192k']);
        }
    });
    return outputPath;
}

// volume: linear multiplier -> dB. vol=1 is unchanged; vol=0 mutes.
// (MediaForge converts vol% to dB via 10*log2(vol).)
async function volume(inputPath, vol, isAudioOnly = false) {
    const filter = vol > 0 ? `volume=${(10 * Math.log2(vol)).toFixed(4)}dB` : 'volume=0';
    return applyAudioFilter(inputPath, filter, isAudioOnly);
}

// pitch: shift by N half-steps without changing duration.
// asetrate changes pitch+speed; atempo compensates speed; aresample restores rate.
async function pitch(inputPath, halfSteps, isAudioOnly = false) {
    let sampleRate = 44100;
    try {
        const probeData = await probeFile(inputPath);
        const a = probeData.streams?.find(s => s.codec_type === 'audio');
        if (a?.sample_rate) sampleRate = parseInt(a.sample_rate, 10) || 44100;
    } catch {}
    const asetrate = Math.max(1, Math.round(sampleRate * 2 ** (halfSteps / 12)));
    const tempo = 2 ** (-halfSteps / 12);
    const filter = `asetrate=r=${asetrate},${atempoChain(tempo)},aresample=${sampleRate}`;
    return applyAudioFilter(inputPath, filter, isAudioOnly);
}

// vibrato: wavy-pitch effect. frequency in Hz, depth 0-1.
async function vibrato(inputPath, frequency = 5, depth = 0.5, isAudioOnly = false) {
    return applyAudioFilter(inputPath, `vibrato=f=${frequency}:d=${depth}`, isAudioOnly);
}

// toaudio: strip video, output AAC m4a.
async function toAudio(inputPath) {
    const outputPath = createTempPath('m4a');
    await runFFmpeg(inputPath, outputPath, cmd => {
        cmd.outputOptions(['-vn', '-c:a aac', '-b:a 192k']);
    });
    return outputPath;
}

// videoloop: repeat the whole video (with audio) N extra times via -stream_loop.
async function videoLoop(inputPath, loops, isAudioOnly = false) {
    const { ext, isVideo } = await outputKind(inputPath, isAudioOnly);
    const outputPath = createTempPath(ext);
    if (isVideo) {
        const outputOptions = await mp4OutputOptions(inputPath, { durationMultiplier: loops + 1 });
        await runFFmpeg(inputPath, outputPath, cmd => {
            cmd.inputOptions([`-stream_loop ${loops}`]).outputOptions(outputOptions);
        });
    } else {
        await runFFmpeg(inputPath, outputPath, cmd => {
            cmd.inputOptions([`-stream_loop ${loops}`]).outputOptions(['-vn', '-c:a aac', '-b:a 192k']);
        });
    }
    return outputPath;
}

module.exports = { volume, pitch, vibrato, toAudio, videoLoop };
