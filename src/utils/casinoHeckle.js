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

const { callOpenRouterAPI } = require('./apiHelpers');
const {
    storeConversationMemory, getSpeakConfigValue, setSpeakConfigValue, isUserBlacklisted,
} = require('./db');
const { getSetting } = require('./casinoConfig');
const logger = require('./logger');

const HECKLE_MODEL = 'xiaomi/mimo-v2-flash';
const LAST_HECKLE_KEY = 'casino_heckle_last_ms';

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

const PROMPT = `You are Cooler Moksi, a dry cynical goat AI who runs a Discord casino.

Someone just {event}. React out loud, in the channel, unprompted.

Rules:
- ONE sentence. Short. Under 20 words.
- Dry, deadpan, a bit mean. Never cheerful, never a cheerleader.
- No emoji, no hashtags, no quotation marks around your reply.
- Do not congratulate. Do not offer advice. Do not mention being an AI.
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
async function considerHeckle({ channel, userId, username, game, wagered, returned }) {
    try {
        if (!(await getSetting('heckle_enabled'))) return;
        if (!channel?.isTextBased?.()) return;

        const net = Number(returned) - Number(wagered);
        const threshold = await getSetting('heckle_threshold');
        if (Math.abs(net) < threshold) return;

        // Someone who has opted out of Moksi talking to them does not want
        // this either.
        if (await isUserBlacklisted(userId).catch(() => false)) return;

        const event = memoryLine(game, net);

        // Cooldown is server-wide and stored, not held in memory: this process
        // restarts on every deploy, and an in-memory timer would reset with it
        // and let a burst through each time.
        const last = Number(await getSpeakConfigValue(LAST_HECKLE_KEY, 0)) || 0;
        const cooldownMs = (await getSetting('heckle_cooldown_seconds')) * 1000;
        const quiet = Date.now() - last < cooldownMs;

        let spoken = null;
        if (!quiet) {
            // Claimed before generating, so two simultaneous big hands cannot
            // both pass the check and both speak.
            await setSpeakConfigValue(LAST_HECKLE_KEY, Date.now());

            const prompt = PROMPT
                .replace('{event}', event.replace(/\*/g, ''))
                .replace('{name}', username || 'they');

            const reply = await callOpenRouterAPI(
                HECKLE_MODEL,
                [{ role: 'user', content: prompt }],
                { maxTokens: 60, temperature: 1.0 }
            );

            const line = String(reply ?? '').trim().replace(/^["']|["']$/g, '').split('\n')[0];
            if (line && line.length <= 300) {
                await channel.send({
                    content: line,
                    allowedMentions: { parse: [] },
                });
                spoken = line;
                logger.info('Casino heckle spoken', { userId, game, net });
            } else {
                // Nothing usable came back; do not burn the cooldown on it.
                await setSpeakConfigValue(LAST_HECKLE_KEY, last);
            }
        }

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
    }
}

module.exports = { considerHeckle, memoryLine, LAST_HECKLE_KEY, GAME_NOUNS };
