// src/utils/media/mediaErrors.js
/**
 * What a failed media command says to the person who ran it.
 *
 * It used to say "❌ Processing failed: " followed by whatever ffmpeg wrote to
 * stderr, temp-file paths and all. That reads as the bot falling over, tells
 * the reader nothing they can act on, and the useful half of it was already
 * in the logs. So: one plain line about what happened and what to try, and
 * underneath it, in small grey text, the short technical reason, for whoever
 * reports it.
 *
 * Some errors are thrown on purpose to be read ("No caption detected at the
 * top of this media. Try a lower threshold."). Those already are the plain
 * line and pass through untouched.
 */

/** Messages written for people, thrown as errors because that is the exit. */
const ALREADY_PLAIN = [
    /^No caption detected/i,
    /^Detected caption is larger/i,
    /^Too many frames/i,
    /^No frames could be extracted/i,
    /^Download produced no file/i,
];

/** First match wins, so the specific causes sit above the general ones. */
const RULES = [
    {
        test: /byte cap|over the \d+ byte/i,
        line: 'That file is too big to fetch; 64 MB is the most I take in.',
    },
    {
        test: /download timed out|HTTP \d{3} downloading|redirect|non-media download|ENOTFOUND|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|No URL to download/i,
        line: "Couldn't fetch that file. If it's an old message, the link may have expired; post it again and retry.",
    },
    {
        test: /timed out/i,
        line: 'That took too long to process, so I stopped it. A shorter or smaller file will go through.',
    },
    {
        test: /matches no streams|does not contain any stream|Output file .* does not contain|no audio/i,
        line: 'That file has no audio track to work with.',
    },
    {
        // Not "Invalid argument": ffmpeg says that about its own filter
        // mistakes too, and blaming the file for those would be a lie.
        test: /invalid data found|moov atom not found|could not find codec parameters|unsupported image format|could not determine (video|gif|media) dimensions|End of file|corrupt/i,
        line: "Couldn't read that file; it may be damaged or an odd format.",
    },
    {
        test: /not installed on this host|failed to start/i,
        line: "The tool this needs isn't available on this host right now.",
    },
    {
        test: /produced no output/i,
        line: 'Processing finished without producing anything.',
    },
];

const DEFAULT_LINE = 'Something went wrong processing that file.';

/** Wrappers this codebase adds around an underlying message, outermost first. */
const PREFIXES = /^(?:FFmpeg(?: [\w-]+)* error:\s*|ffmpeg exited with code \d+:\s*|ImageMagick exited \d+:\s*|ERROR:\s*)+/i;

/**
 * Absolute paths: a temp file's location is noise to a reader and none of
 * their business. A slash after a colon, a letter or another slash is part of
 * a URL or a word, not the start of a path, and is left alone: the URL in a
 * failed /videodl is the reader's own.
 */
const PATHS = /(?:\b[A-Za-z]:\\|(?<![\w:/])\/)(?:[^\s:'"]+[\\/])+[^\s:'"]*/g;

/**
 * The short technical reason: wrappers peeled, paths blanked, one line, clipped.
 * @returns {string} empty when nothing useful is left
 */
function technicalDetail(message, max = 140) {
    const lines = String(message ?? '')
        .split(/\r?\n/)
        .map(line => line.replace(PREFIXES, '').replace(PATHS, 'file').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    // ffmpeg's last line is usually the real reason; earlier ones are context.
    const last = lines[lines.length - 1] ?? '';
    return last.length > max ? `${last.slice(0, max - 1)}…` : last;
}

/**
 * @param {unknown} error
 * @param {{fallback?: string}} [options] fallback: the line when no rule
 *   matches, for a command that knows better than "processing" (a download)
 * @returns {string} ready to send: the plain line, then the detail as subtext
 */
function describeMediaFailure(error, { fallback = DEFAULT_LINE } = {}) {
    const message = String(error?.message ?? error ?? '').trim();
    if (ALREADY_PLAIN.some(re => re.test(message))) return message;

    const rule = RULES.find(r => r.test.test(message));
    const line = rule ? rule.line : fallback;
    const detail = technicalDetail(message);
    return detail ? `${line}\n-# ${detail}` : line;
}

module.exports = { describeMediaFailure, technicalDetail };
