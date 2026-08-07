// src/utils/media/fontSetup.js
/**
 * Makes the repo's bundled fonts visible to whatever renders SVG text.
 *
 * /caption and /meme build an SVG asking for "Impact" (and Atkinson
 * Hyperlegible for the white-box style) and hand it to sharp, which renders
 * text through librsvg and pango, which find fonts through fontconfig. None of
 * that searches the application directory on its own: the font has to be
 * registered.
 *
 * The Dockerfile used to do it in one RUN, writing a conf into
 * /etc/fonts/conf.d and running fc-cache. Railway's Express builder skips the
 * Dockerfile entirely, so that step stopped happening and the meme text
 * quietly fell back to whatever font the base image had, if any. Doing it here
 * makes it true on every builder, and costs one small file at boot.
 *
 * Deliberately additive: the generated config INCLUDES the system config
 * rather than replacing it, so anywhere the platform already provides fonts
 * (the Docker image, a dev machine) keeps all of them and simply gains ours.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../logger');

/** Where the bundled .ttf/.otf files live. */
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');

/**
 * Writes a fontconfig config naming our font directory and points the
 * environment at it. Safe to call more than once; safe to fail.
 *
 * @returns {string|null} the config path, or null when nothing was done
 */
function registerBundledFonts() {
    try {
        // Nothing to register, and no reason to touch the environment.
        if (!fs.existsSync(FONT_DIR)) return null;

        // Somebody (the Dockerfile, an operator) already made a deliberate
        // choice about fontconfig. Do not overrule it.
        if (process.env.FONTCONFIG_FILE) return null;

        // The cache has to be somewhere writable. Fontconfig falls back to a
        // path under the home directory, which is not reliably writable in a
        // container, and an unwritable cache turns into a warning on every
        // single render.
        const cacheDir = path.join(os.tmpdir(), 'fontconfig-cache');
        fs.mkdirSync(cacheDir, { recursive: true });

        const conf = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>${FONT_DIR}</dir>
  <cachedir>${cacheDir}</cachedir>
</fontconfig>
`;
        const confPath = path.join(os.tmpdir(), 'moksi-fonts.conf');
        fs.writeFileSync(confPath, conf, 'utf8');
        process.env.FONTCONFIG_FILE = confPath;

        const count = fs.readdirSync(FONT_DIR).filter(f => /\.(ttf|otf|ttc)$/i.test(f)).length;
        logger.info('[MEDIA] Registered bundled fonts', { fonts: count, confPath });
        return confPath;
    } catch (error) {
        // A caption in the wrong font is a worse outcome than this being
        // noisy, and a much better one than the process not starting.
        logger.warn('[MEDIA] Could not register bundled fonts', { error: error.message });
        return null;
    }
}

module.exports = { registerBundledFonts, FONT_DIR };
