// src/utils/media/videoFrame.js
/**
 * Pulls one still out of a video so the vision model has something to look at.
 *
 * A video uploaded straight to Discord carries no embed and therefore no
 * thumbnail, so the media pipeline had nothing to describe and fell back to the
 * filename. The bot then reacted to the filename, which is how "mp4 huh.
 * groundbreaking." happens: it was not being lazy, that genuinely was all it
 * had been given.
 *
 * ffmpeg already ships in the image for the media commands, so this costs a
 * download and about a second of low-priority CPU. The result is handed back as
 * a data URI because the frame only exists locally and the vision call takes a
 * URL.
 */

const fs = require('fs');
const { downloadToTemp, createTempPath, cleanup } = require('./tempFiles');
const { runFFmpeg, probeFile } = require('./ffmpegUtils');
const { withSampleSlot } = require('./sampleGate');
const logger = require('../logger');

/** Bigger than this and the download costs more than the joke is worth. */
const MAX_VIDEO_BYTES = 40 * 1024 * 1024;

/** Wide enough to read text off a meme, small enough to stay cheap to send. */
const FRAME_WIDTH = 512;

/** A whole reply is waiting on this, so it cannot be allowed to hang. */
const EXTRACT_TIMEOUT_MS = 20_000;

/** Inner deadlines that actually abort the work; the outer timeout only stops waiting. */
const DOWNLOAD_TIMEOUT_MS = 12_000;
const ENCODE_TIMEOUT_MS = 8_000;

/**
 * Videos routinely open on black, a logo, or a fade. A little way in is far
 * more likely to be the frame a human would call "the thumbnail".
 */
async function pickSeekSeconds(filePath) {
    try {
        const data = await probeFile(filePath);
        const duration = Number(data?.format?.duration);
        if (!Number.isFinite(duration) || duration <= 0) return 0;
        if (duration < 1) return 0;
        return Math.min(1.5, duration / 4);
    } catch {
        return 0;
    }
}

function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
        }),
    ]);
}

/**
 * @param {string} url a fetchable video URL (a Discord attachment URL works)
 * @param {object} opts
 * @param {number} [opts.sizeBytes] the attachment's declared size, checked
 *   before downloading rather than after
 * @returns {Promise<string|null>} a jpeg data URI, or null if nothing could be read
 */
async function firstFrameDataUri(url, { sizeBytes = 0 } = {}) {
    if (sizeBytes && sizeBytes > MAX_VIDEO_BYTES) {
        logger.debug('[MEDIA] Video too large to sample', { sizeBytes });
        return null;
    }

    return withSampleSlot(async () => {
        let videoPath = null;
        let framePath = null;
        try {
            return await withTimeout((async () => {
                videoPath = await downloadToTemp(url, 'mp4', {
                    maxBytes: MAX_VIDEO_BYTES,
                    timeoutMs: DOWNLOAD_TIMEOUT_MS,
                });
                const seek = await pickSeekSeconds(videoPath);
                framePath = createTempPath('jpg');

                await runFFmpeg(videoPath, framePath, (cmd) => {
                    cmd.seekInput(seek)
                        .frames(1)
                        .outputOptions(['-vf', `scale=${FRAME_WIDTH}:-2`, '-q:v', '4']);
                }, { timeoutMs: ENCODE_TIMEOUT_MS });

                const bytes = fs.readFileSync(framePath);
                if (!bytes.length) return null;
                return `data:image/jpeg;base64,${bytes.toString('base64')}`;
            })(), EXTRACT_TIMEOUT_MS, 'Video frame extraction');
        } catch (error) {
            logger.warn('[MEDIA] Could not sample a video frame', { error: error.message });
            return null;
        } finally {
            await cleanup(videoPath, framePath).catch(() => {});
        }
    });
}

module.exports = { firstFrameDataUri, MAX_VIDEO_BYTES, pickSeekSeconds };
