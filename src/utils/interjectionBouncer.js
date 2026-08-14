// src/utils/interjectionBouncer.js
/**
 * The scout that reads a moment before the bot butts into it.
 *
 * The gauntlet in utils/interjections.js (channel allowlist, keywords,
 * cooldown, dice roll) controls how OFTEN Moksi interjects. It has nothing to
 * say about whether the particular moment it landed on is one anybody would
 * want a remark about, so a winning roll on "ok" or "gm" spent a full
 * generation on a reply nobody needed.
 *
 * This used to answer YES or NO and throw away everything it understood in
 * the process, which was the waste: the model that decided the moment was
 * interesting knew exactly WHAT was interesting about it, and the writer was
 * then sent in blind. It now returns that judgment as well, which makes it
 * the interjection path's whole pre-pass rather than a gate bolted in front
 * of one.
 *
 * It fails open, because a scout that silently swallows every interjection
 * when the API is down is worse than no scout at all.
 */

const { callOpenRouterAPI } = require('./apiHelpers');
const { extractJson } = require('./speakPipeline');
const telemetry = require('./telemetry');
const logger = require('./logger');

/** Nobody is waiting on an interjection, so it reads more than a reply's gate would. */
const CONTEXT_MESSAGES = 12;
const MAX_LINE_CHARS = 220;

/** Whatever the scout could not determine; the pipeline continues without it. */
const OPEN = Object.freeze({ worth: true, hook: '', mode: 'banter' });
const CLOSED = Object.freeze({ worth: false, hook: '', mode: 'banter' });

const PROMPT = `Below is the tail of a Discord conversation. A dry, cynical bot is deciding
whether to butt in uninvited with one remark.

The test is the remark, not the conversation: would the bot's one line ADD
something, either genuinely useful or genuinely funny? Useful looks like a
real answer to confusion in the room, especially about something the bot did
or plainly knows. Funny needs an actual target: an opinion, a claim, a story,
a complaint, an argument, someone being wrong about something. A lively chat
the bot has nothing for is still a no.

Say it is not worth it if this is small talk, greetings, goodbyes, one-word
replies, logistics ("anyone on tonight?"), link-dumps with no commentary, or a
conversation that has clearly already ended. When in doubt, say it is not
worth it: an unprompted remark that adds nothing is worse than silence.

CONVERSATION:
{transcript}

Answer in strict JSON, nothing else, exactly this shape:
{"worth": true, "hook": "the ONE thing the bot's line would add, under 20 words", "mode": "banter"}

mode: "question" = someone wants a real answer, including a playful ask for real information; "banter" = riffing or joking;
"heavy" = something serious or emotional; "media" = the point is an image,
video or link someone shared; "callout" = they are talking about the bot.
hook: leave it empty when the bot has nothing to add.`;

/**
 * @param {import('discord.js').Message} message the message that won the roll
 * @param {Object} options
 * @param {string} options.model which model reads the room
 * @returns {Promise<{worth: boolean, hook: string, mode: string}>}
 */
async function scoutMoment(message, { model }) {
    // Its own small trace: the interjection it may green-light gets a fresh
    // one, so a refused moment still shows up in the telemetry export.
    return telemetry.runWithTrace(
        { kind: 'bouncer', channelId: message.channelId },
        () => readMoment(message, model).then((read) => {
            telemetry.finishTrace({ flags: read, outcome: 'ok' });
            return read;
        })
    );
}

async function readMoment(message, model) {
    try {
        const fetched = await message.channel.messages
            .fetch({ limit: CONTEXT_MESSAGES })
            .catch(() => null);
        if (!fetched?.size) return OPEN; // cannot judge; do not block

        const lines = [...fetched.values()]
            .reverse()
            .map(m => {
                const text = (m.content ?? '').replace(/\s+/g, ' ').trim();
                if (!text) return null;
                const who = m.author.bot ? 'bot' : (m.member?.displayName ?? m.author.username);
                return `${who}: ${text.slice(0, MAX_LINE_CHARS)}`;
            })
            .filter(Boolean);

        // Nothing but images and stickers: there is no text to have a take on.
        if (lines.length < 2) return CLOSED;

        const verdict = await callOpenRouterAPI(
            model,
            [{ role: 'user', content: PROMPT.replace('{transcript}', lines.join('\n')) }],
            { maxTokens: 120, temperature: 0, timeout: 10_000, telemetry: { kind: 'bouncer' } }
        );

        if (verdict === null) return OPEN; // model unreachable; fail open
        const parsed = extractJson(verdict);
        if (!parsed) {
            // Older prompts answered in bare words; honour that rather than
            // failing open on a model that simply did not use JSON.
            return /\bno\b/i.test(String(verdict)) ? CLOSED : OPEN;
        }

        const read = {
            worth: parsed.worth !== false,
            hook: String(parsed.hook ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
            mode: typeof parsed.mode === 'string' ? parsed.mode.trim() : 'banter',
        };
        logger.debug('Interjection scout', { channelId: message.channelId, ...read });
        return read;
    } catch (error) {
        logger.warn('Interjection scout failed, allowing', { error: error.message });
        return OPEN;
    }
}

module.exports = { scoutMoment, CONTEXT_MESSAGES };
