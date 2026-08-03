// src/utils/speakProfile.js
/**
 * Distilled long-term memory for the speak system.
 *
 * conversation_memories stores raw exchanges: episodic, recent, and already
 * fed to the prompt. This module maintains the other kind of memory: a small
 * per-user fact sheet of DURABLE things (interests, running jokes, life
 * details they volunteered, how they treat the bot) that survives long after
 * the raw exchanges have scrolled away.
 *
 * Cost discipline, since this runs on a paid model:
 *  - Only after DISTILL_EVERY_N new real exchanges since the last pass.
 *  - Never more than once per DISTILL_MIN_GAP_MS per user.
 *  - Cheap model (same tier as sentiment), tiny output budget.
 *  - Explicitly told to answer NOTHING_NEW when the exchanges hold nothing
 *    durable, which skips the write entirely.
 */

const {
    getSpeakProfile, saveSpeakProfile, getRecentMemories, getUserContext,
    getSpeakConfigValue,
} = require('./db');
const { callOpenRouterAPI } = require('./apiHelpers');
const logger = require('./logger');

const DISTILL_EVERY_N = 12;
const DISTILL_MIN_GAP_MS = 60 * 60_000;
const DISTILL_MODEL = 'xiaomi/mimo-v2-flash';
const FALLBACK_MODEL = 'meta-llama/llama-3.3-8b-instruct';
const MAX_PROFILE_CHARS = 600;

/** In-flight guard so overlapping speak calls cannot double-distill a user. */
const inFlight = new Set();

const DISTILL_PROMPT = `You maintain a compact fact sheet about one Discord user, written from the perspective of "Cooler Moksi", a dry cynical goat AI who talks with them.

CURRENT FACT SHEET (may be empty):
{profile}

RECENT EXCHANGES (newest last):
{exchanges}

Rewrite the fact sheet. Rules:
- Keep ONLY durable information: interests, life details they volunteered, running jokes, memorable events, how they behave toward the bot.
- NEVER store small talk, one-off questions, or anything only meaningful in the moment.
- Merge new information with the current sheet; drop entries that look stale or superseded.
- At most 6 bullet points, each one short. Total under 500 characters.
- Output ONLY the bullet list, one "- " bullet per line, no headers or commentary.
- If the recent exchanges contain nothing durable and the sheet needs no change, output exactly: NOTHING_NEW`;

/**
 * Runs a distillation pass for one user if they are due. Fire-and-forget:
 * never throws, returns what happened for logging/tests.
 *
 * @returns {Promise<'disabled'|'not-due'|'busy'|'nothing-new'|'updated'|'failed'>}
 */
async function maybeDistillProfile(userId) {
    try {
        const config = await getSpeakConfigValue('distill', { enabled: false });
        if (!config?.enabled) return 'disabled';

        if (inFlight.has(userId)) return 'busy';

        const [profileRow, userContext] = await Promise.all([
            getSpeakProfile(userId),
            getUserContext(userId),
        ]);

        const exchanges = userContext.interactionCount || 0;
        const lastAt = Number(profileRow?.exchanges_at_distill ?? 0);
        if (exchanges - lastAt < DISTILL_EVERY_N) return 'not-due';
        if (profileRow && Date.now() - Number(profileRow.updated_at_ms) < DISTILL_MIN_GAP_MS) return 'not-due';

        inFlight.add(userId);
        try {
            const memories = await getRecentMemories(userId, DISTILL_EVERY_N, { excludeContext: true });
            if (memories.length === 0) return 'nothing-new';

            const exchangeText = memories
                .map(m => `Them: ${String(m.user_message).slice(0, 200)}\nYou: ${String(m.bot_response).slice(0, 200)}`)
                .join('\n---\n');

            const prompt = DISTILL_PROMPT
                .replace('{profile}', profileRow?.profile || '(empty)')
                .replace('{exchanges}', exchangeText);

            const result = await callOpenRouterAPI(DISTILL_MODEL, [
                { role: 'user', content: prompt },
            ], {
                maxTokens: 200,
                temperature: 0.2,
                timeout: 12_000,
                fallbackModel: FALLBACK_MODEL,
            });

            if (!result) return 'failed';

            const text = result.trim();
            if (/^NOTHING_NEW$/i.test(text)) {
                // Still advance the counter, or the same uneventful exchanges
                // would be re-examined on every following message.
                await saveSpeakProfile(userId, profileRow?.profile ?? null, exchanges);
                return 'nothing-new';
            }

            // Keep only well-formed bullets; a chatty model gets its prose dropped.
            const bullets = text.split('\n')
                .map(l => l.trim())
                .filter(l => l.startsWith('- '))
                .slice(0, 6);
            if (bullets.length === 0) return 'failed';

            const profile = bullets.join('\n').slice(0, MAX_PROFILE_CHARS);
            await saveSpeakProfile(userId, profile, exchanges);
            logger.info('[SPEAK] Profile distilled', { userId, bullets: bullets.length, exchanges });
            return 'updated';
        } finally {
            inFlight.delete(userId);
        }
    } catch (error) {
        inFlight.delete(userId);
        logger.warn('[SPEAK] Profile distillation failed', { userId, error: error.message });
        return 'failed';
    }
}

module.exports = {
    DISTILL_EVERY_N,
    DISTILL_MIN_GAP_MS,
    MAX_PROFILE_CHARS,
    maybeDistillProfile,
};
