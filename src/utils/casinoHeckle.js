// src/utils/casinoHeckle.js
/**
 * Moksi noticing the casino.
 *
 * Two behaviours, one switch, and the switch is off until the owner turns it
 * on (`/casino config`). Both are deliberately rare: a bot that comments on
 * every hand is a bot people mute.
 *
 *  1. Memory. A swing past the configured threshold is written to the same
 *     conversation memory store /speak already reads, so weeks later Moksi can
 *     bring up the night you lost forty thousand without anyone re-telling it.
 *  2. A spoken line. At most one per cooldown window, server-wide, generated
 *     by the cheap model.
 *
 * The memory is written whether or not Moksi spoke. Watching quietly and
 * remembering is the more useful half.
 */

const { PermissionFlagsBits } = require('discord.js');
const { callOpenRouterAPI } = require('./apiHelpers');
const {
    storeConversationMemory, getSpeakConfigValue, setSpeakConfigValue, isUserBlacklisted,
} = require('./db');
const { getSetting } = require('./casinoConfig');
const logger = require('./logger');

const HECKLE_MODEL = 'xiaomi/mimo-v2-flash';
/** One unavailable model should not mute the casino for good. */
const FALLBACK_MODEL = 'meta-llama/llama-3.3-8b-instruct';
const LAST_HECKLE_KEY = 'casino_heckle_last_ms';
/**
 * Why the last eligible swing did or did not get a line. Silence has half a
 * dozen legitimate causes and they are indistinguishable from a bug when the
 * only evidence is a channel where nothing happened, so the reason is stored
 * for the config panel to show.
 */
const LAST_RESULT_KEY = 'casino_heckle_last_result';

const GAME_NOUNS = Object.freeze({
    blackjack: 'a blackjack hand',
    slots: 'a slot spin',
    roulette: 'a roulette spin',
    craps: 'a craps roll',
    highlow: 'a high-low call',
    duel: 'a duel',
    tetris: 'a game of tetris',
});

const money = n => `$${Math.abs(Number(n)).toLocaleString()}`;

/**
 * The event as a third-person action rather than as speech.
 *
 * formatMemories in speak.js renders every row as `They said: "..."`, so an
 * event phrased as a sentence would read as something the player claimed. The
 * asterisk convention marks it as an action, which is how models read it.
 */
function memoryLine(game, net) {
    const noun = GAME_NOUNS[game] ?? game;
    return net > 0
        ? `*won ${money(net)} on ${noun}*`
        : `*lost ${money(net)} on ${noun}*`;
}

const PROMPT = `You are Cooler Moksi, a dry cynical AI who runs a Discord casino.

Someone just {event}. React out loud, in the channel, unprompted.

Rules:
- ONE sentence. Short. Under 20 words.
- Dry, deadpan, a bit mean. Never cheerful, never a cheerleader.
- No emoji, no hashtags, no quotation marks around your reply.
- Do not congratulate. Do not offer advice. Do not mention being an AI.
- Never describe what you are, and never make the joke about yourself. The line is about them.
- Address them as "you" or by name; do not narrate in the third person.

Their name: {name}
Reply with the sentence and nothing else.`;

/**
 * Considers reacting to a settled round.
 *
 * Never throws and never blocks: callers fire this without awaiting, because a
 * payout must not wait on a language model.
 *
 * @param {object} params
 * @param {import('discord.js').TextBasedChannel} params.channel
 * @param {string} params.userId
 * @param {string} params.username
 * @param {string} params.game
 * @param {number} params.wagered gross staked
 * @param {number} params.returned gross returned
 */
async function note(reason, extra = {}) {
    await setSpeakConfigValue(LAST_RESULT_KEY, { at: Date.now(), reason, ...extra })
        .catch(() => { /* diagnostics must never be the thing that breaks */ });
}

/**
 * Can the bot actually talk here?
 *
 * A game is posted as an interaction response, which needs no permission at
 * all; a heckle is an ordinary message, which does. So a channel where the
 * casino works perfectly can still be one the bot cannot speak in, and the
 * only symptom is silence.
 */
function maySpeakIn(channel) {
    const me = channel.guild?.members?.me;
    if (!me || typeof channel.permissionsFor !== 'function') return true;
    const perms = channel.permissionsFor(me);
    return !perms || perms.has(PermissionFlagsBits.SendMessages);
}

/**
 * Decides whether to speak, and speaks. Returns the line or null.
 *
 * The cooldown is claimed before generating so two simultaneous big hands
 * cannot both pass the check, and released again on every path that does not
 * end in a delivered message. Burning the window on a failure would mean one
 * missing permission or one bad model response buying a full period of
 * silence, which reads exactly like the feature being broken.
 */
async function maybeSpeak({ channel, username, event }) {
    const cooldownSeconds = await getSetting('heckle_cooldown_seconds');
    const last = Number(await getSpeakConfigValue(LAST_HECKLE_KEY, 0)) || 0;
    // Zero is a real answer: react to every qualifying swing.
    if (cooldownSeconds > 0 && Date.now() - last < cooldownSeconds * 1000) {
        const readyIn = Math.ceil((last + cooldownSeconds * 1000 - Date.now()) / 1000);
        await note('cooling down', { readyInSeconds: readyIn });
        return null;
    }

    if (!maySpeakIn(channel)) {
        await note('no permission to send messages in that channel', { channelId: channel.id });
        logger.warn('Casino heckle cannot speak there', { channelId: channel.id });
        return null;
    }

    await setSpeakConfigValue(LAST_HECKLE_KEY, Date.now());
    try {
        const prompt = PROMPT
            .replace('{event}', event.replace(/\*/g, ''))
            .replace('{name}', username || 'they');

        const reply = await callOpenRouterAPI(
            HECKLE_MODEL,
            [{ role: 'user', content: prompt }],
            { maxTokens: 60, temperature: 1.0, fallbackModel: FALLBACK_MODEL }
        );

        const line = String(reply ?? '').trim().replace(/^["']|["']$/g, '').split('\n')[0];
        if (!line || line.length > 300) {
            await setSpeakConfigValue(LAST_HECKLE_KEY, last);
            await note(reply ? 'model returned something unusable' : 'model returned nothing');
            logger.warn('Casino heckle got no usable line', { hadReply: Boolean(reply) });
            return null;
        }

        await channel.send({ content: line, allowedMentions: { parse: [] } });
        await note('spoke', { line });
        return line;
    } catch (error) {
        await setSpeakConfigValue(LAST_HECKLE_KEY, last);
        await note('failed', { error: error.message });
        logger.warn('Casino heckle failed to speak', { error: error.message });
        return null;
    }
}

async function considerHeckle({ channel, userId, username, game, wagered, returned }) {
    try {
        if (!(await getSetting('heckle_enabled'))) return;
        if (!channel?.isTextBased?.()) return;

        const net = Number(returned) - Number(wagered);
        const threshold = await getSetting('heckle_threshold');
        if (Math.abs(net) < threshold) return;

        // Someone who has opted out of Moksi talking to them does not want
        // this either.
        if (await isUserBlacklisted(userId).catch(() => false)) {
            await note('that player has opted out of Moksi speaking', { userId });
            return;
        }

        const event = memoryLine(game, net);
        const spoken = await maybeSpeak({ channel, username, event });
        if (spoken) logger.info('Casino heckle spoken', { userId, game, net });

        // Outside the speaking path on purpose: watching quietly and
        // remembering is the more useful half, and it should survive a failure
        // to say anything out loud.
        await storeConversationMemory(
            userId,
            channel.id,
            event,
            spoken ?? '*said nothing, but noticed*',
            net > 0 ? 0.1 : -0.1,
            false
        ).catch(error => logger.warn('Casino memory write failed', { error: error.message }));
    } catch (error) {
        logger.warn('Casino heckle failed', { error: error.message });
        await note('failed', { error: error.message });
    }
}

/** What happened the last time a swing was worth remarking on. */
async function lastHeckleResult() {
    const stored = await getSpeakConfigValue(LAST_RESULT_KEY, null);
    return (stored && typeof stored === 'object') ? stored : null;
}

module.exports = {
    considerHeckle, memoryLine, lastHeckleResult,
    LAST_HECKLE_KEY, LAST_RESULT_KEY, GAME_NOUNS,
};
