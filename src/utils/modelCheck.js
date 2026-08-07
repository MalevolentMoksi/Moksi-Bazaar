// src/utils/modelCheck.js
/**
 * Confirms at boot that every model the bot is configured to call still
 * exists on OpenRouter.
 *
 * Three ids in this repo have been found dead, none of them by anything in
 * the bot noticing. The vision fallback had been delisted for months, so
 * every hiccup in the primary 404ed into "contents not seen". The
 * interjection scout's model was gone, and since that path fails open, the
 * gate had been passing every moment. Worst of all, profile distillation and
 * the casino heckler each had a dead primary AND a dead fallback, so both
 * features had simply stopped happening while the code around them looked
 * perfectly healthy.
 *
 * That is the shape of the problem: every one of these paths degrades
 * quietly on purpose, which is right in the moment and catastrophic over
 * months. A dead model is indistinguishable from a feature that never fires.
 * One request at startup makes it distinguishable.
 *
 * It never blocks and never throws: a check that can stop the bot booting is
 * a worse bug than the one it is here to catch.
 */

const { configuredModels } = require('./speakPipeline');
const logger = require('./logger');

const CATALOGUE_URL = 'https://openrouter.ai/api/v1/models';
const TIMEOUT_MS = 10_000;

/**
 * The last result, for the settings panel to show. Null until the check has
 * run; `checked` false means it could not be established either way, which is
 * not the same as everything being fine.
 */
let lastResult = null;

async function fetchCatalogue() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(CATALOGUE_URL, { signal: controller.signal });
        if (!response.ok) throw new Error(`catalogue returned ${response.status}`);
        const body = await response.json();
        const ids = (body?.data ?? []).map(m => m?.id).filter(Boolean);
        if (ids.length === 0) throw new Error('catalogue was empty');
        return new Set(ids);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * @returns {Promise<{checked: boolean, missing: string[], total: number, at: number, error?: string}>}
 */
async function verifyModels() {
    let configured = [];
    try {
        configured = await configuredModels();
        const live = await fetchCatalogue();
        const missing = configured.filter(id => !live.has(id));

        lastResult = { checked: true, missing, total: configured.length, at: Date.now() };
        if (missing.length > 0) {
            // Loud on purpose. Everything downstream of this failure is silent.
            logger.error('[MODELS] Configured models are NOT on OpenRouter; the features using them will fail quietly', {
                missing, checked: configured.length,
            });
        } else {
            logger.info('[MODELS] All configured models are live', { checked: configured.length });
        }
        return lastResult;
    } catch (error) {
        // Could not establish it either way. Say so rather than implying health.
        lastResult = {
            checked: false, missing: [], total: configured.length,
            at: Date.now(), error: error.message,
        };
        logger.warn('[MODELS] Could not verify models against OpenRouter', { error: error.message });
        return lastResult;
    }
}

/** Whatever the last check found; null before it has run. */
function lastModelCheck() {
    return lastResult;
}

module.exports = { verifyModels, lastModelCheck, CATALOGUE_URL };
