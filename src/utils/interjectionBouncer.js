// src/utils/interjectionBouncer.js
/**
 * A second opinion on whether an unprompted interjection is worth making.
 *
 * The existing gauntlet (channel allowlist, keywords, cooldown, dice roll)
 * controls how OFTEN Moksi butts in. It has nothing to say about whether the
 * particular moment it landed on is one anybody would want a remark about, so
 * a winning roll on "ok" or "gm" spends a full generation to produce a reply
 * nobody needed.
 *
 * This reads the last few messages with the cheap model and answers one
 * question: is there anything here to react to? It is off unless the owner
 * turns it on, and it fails open, because a bouncer that silently swallows
 * every interjection when the API is down is worse than no bouncer.
 */

const { callOpenRouterAPI } = require('./apiHelpers');
const logger = require('./logger');

const BOUNCER_MODEL = 'xiaomi/mimo-v2-flash';
/** Enough to see what the conversation is, not enough to cost anything. */
const CONTEXT_MESSAGES = 8;
const MAX_LINE_CHARS = 200;

const PROMPT = `Below is the tail of a Discord conversation. A dry, cynical bot is deciding
whether to butt in uninvited with one remark.

Answer YES only if there is something specific and concrete here to react to:
an opinion, a claim, a story, a complaint, a joke, an argument, someone being
wrong about something.

Answer NO if it is small talk, greetings, goodbyes, one-word replies, logistics
("anyone on tonight?"), link-dumps with no commentary, or a conversation that
has clearly already ended. When in doubt, answer NO: an unprompted remark that
adds nothing is worse than silence.

CONVERSATION:
{transcript}

Answer with exactly one word, YES or NO.`;

/**
 * @param {import('discord.js').Message} message the message that won the roll
 * @returns {Promise<boolean>} true when the interjection should proceed
 */
async function passesBouncer(message) {
    try {
        const fetched = await message.channel.messages
            .fetch({ limit: CONTEXT_MESSAGES })
            .catch(() => null);
        if (!fetched?.size) return true; // cannot judge; do not block

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
        if (lines.length < 2) return false;

        const verdict = await callOpenRouterAPI(
            BOUNCER_MODEL,
            [{ role: 'user', content: PROMPT.replace('{transcript}', lines.join('\n')) }],
            { maxTokens: 4, temperature: 0, timeout: 8000 }
        );

        if (verdict === null) return true; // model unreachable; fail open
        const yes = /\byes\b/i.test(String(verdict));
        logger.debug('Interjection bouncer verdict', {
            channelId: message.channelId, verdict: String(verdict).trim(), passed: yes,
        });
        return yes;
    } catch (error) {
        logger.warn('Interjection bouncer failed, allowing', { error: error.message });
        return true;
    }
}

module.exports = { passesBouncer, CONTEXT_MESSAGES };
