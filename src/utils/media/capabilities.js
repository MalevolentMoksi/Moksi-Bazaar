// src/utils/media/capabilities.js
/**
 * One line at boot saying which media tools this container actually has.
 *
 * The bot's media commands depend on binaries the app does not control, and
 * on 2026-08-08 Railway changed builders without asking: ffmpeg, imagemagick,
 * yt-dlp and the bundled fonts all silently stopped existing. Every one of
 * them was discovered the same way, by somebody running a command and getting
 * an error, days later.
 *
 * Nothing here fixes that. What it does is make it loud: the capabilities are
 * printed in the first seconds of every deploy, in the log that already gets
 * read after every push, so the next time the ground moves it announces
 * itself instead of ambushing a user.
 */

const fs = require('fs');
const logger = require('../logger');
const { binaryResolution } = require('./ffmpegUtils');
const { magickAvailable } = require('./magickUtils');
const { ytdlpAvailable } = require('./ytdlpUtils');
const { FONT_DIR } = require('./fontSetup');

/** Which commands stop working when a given capability is absent. */
const COST_OF_ABSENCE = {
    ffmpeg: 'all video, GIF and audio commands, plus GIF vision',
    ffprobe: 'media probing and audio detection',
    imagemagick: '/magick',
    'yt-dlp': '/videodl',
    fonts: 'caption text in /caption and /meme',
};

function countFonts() {
    try {
        return fs.readdirSync(FONT_DIR).filter(f => /\.(ttf|otf|ttc)$/i.test(f)).length;
    } catch {
        return 0;
    }
}

/**
 * Probes every external tool and returns what it found. Never throws: a
 * capability report that can crash the boot is worse than no report.
 *
 * @returns {Promise<object>} capability name to a short status string
 */
async function probeCapabilities() {
    const ffmpeg = binaryResolution();

    const [magick, ytdlp] = await Promise.all([
        magickAvailable().catch(() => false),
        ytdlpAvailable().catch(() => false),
    ]);

    const fonts = countFonts();

    return {
        ffmpeg: ffmpeg.ffmpeg,
        ffprobe: ffmpeg.ffprobe,
        imagemagick: magick ? 'system' : 'missing',
        'yt-dlp': ytdlp ? 'system' : 'missing',
        fonts: fonts > 0 ? `${fonts} bundled` : 'missing',
    };
}

/**
 * Probes and logs. Anything missing is named alongside what it costs, because
 * "imagemagick=missing" only means something to whoever wrote the code.
 */
async function reportCapabilities() {
    try {
        const caps = await probeCapabilities();

        logger.info('[MEDIA] Capabilities', caps);

        const lost = Object.entries(caps)
            .filter(([, status]) => status === 'missing')
            .map(([name]) => `${name} (${COST_OF_ABSENCE[name] ?? 'unknown impact'})`);

        if (lost.length) {
            logger.warn('[MEDIA] Missing tools; these commands will fail', { lost });
        }
        return caps;
    } catch (error) {
        logger.warn('[MEDIA] Capability probe failed', { error: error.message });
        return null;
    }
}

module.exports = { probeCapabilities, reportCapabilities, COST_OF_ABSENCE };
