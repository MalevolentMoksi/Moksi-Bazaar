// src/utils/emojiRegistry.js
/**
 * Where the bot's reaction faces come from at runtime.
 *
 * They used to be eleven hardcoded `<a:goat_name:1395455098716688424>` strings
 * in constants.js, which has two failure modes and hit both. An id that changes
 * (re-uploaded emoji, emoji deleted, the source server left) leaves the mention
 * pointing at nothing, and nothing in the bot can tell: the string still looks
 * like a mention, so it ships. And a guild emoji is only usable where the app
 * has permission to use external emojis, so a channel with that permission
 * withheld turns every reaction into raw text in front of everyone.
 *
 * Application-owned emojis have neither problem. They belong to the app rather
 * than to a server, they need no guild membership and no USE_EXTERNAL_EMOJIS,
 * and the app can use them anywhere it can speak. The ids are read from the API
 * at boot, so there is no id in the source to rot.
 *
 * The set is uploaded by `node scripts/syncEmojis.js` from the `emojis/`
 * folder; the file name is the key the model writes.
 */

const logger = require('./logger');
const { REACTION_EMOJI } = require('./constants');

/** key -> the `<:key:id>` mention Discord renders. Empty until boot loads it. */
let live = new Map();
let loadedAt = null;

/**
 * Reads the application's emojis once at boot.
 *
 * Throws only when the API call itself fails, which is worth a boot-report
 * line. An app with no emojis uploaded yet is not an error, just a bot whose
 * replies carry no faces, so that path warns and moves on.
 */
async function loadEmojis(client) {
    const emojis = await client.application.emojis.fetch();

    const next = new Map();
    for (const emoji of emojis.values()) {
        next.set(emoji.name.toLowerCase(), emoji.toString());
    }
    live = next;
    loadedAt = Date.now();

    const described = Object.keys(REACTION_EMOJI);
    const missing = described.filter(key => !live.has(key));
    const undescribed = [...live.keys()].filter(key => !described.includes(key));

    if (live.size === 0) {
        logger.warn('[EMOJI] The application owns no emojis; replies will carry no reaction face', {
            expected: described.length,
        });
        console.warn('⚠️  No application emojis found. Upload them with: node scripts/syncEmojis.js');
        return { total: 0, usable: 0, missing, undescribed };
    }

    // Both halves are worth saying out loud. A described key with no image is a
    // key the model can pick and get nothing for; an uploaded emoji with no
    // description is one the model is never told about, so it can never be used.
    if (missing.length > 0) {
        logger.warn('[EMOJI] Described keys have no uploaded emoji', { missing });
    }
    if (undescribed.length > 0) {
        logger.warn('[EMOJI] Uploaded emojis are missing a description, so the model is never offered them', {
            undescribed,
        });
    }

    const usable = emojiKeys().length;
    logger.info('[EMOJI] Application emojis loaded', { total: live.size, usable });
    console.log(`✅ ${usable} reaction emojis loaded from the application`);
    return { total: live.size, usable, missing, undescribed };
}

/**
 * The keys the model may pick from: uploaded AND described. Sorted so the
 * prompt prefix stays byte-identical between calls, which is what makes it
 * cacheable.
 */
function emojiKeys() {
    return Object.keys(REACTION_EMOJI).filter(key => live.has(key)).sort();
}

/** The mention for a key, or '' when it is unknown. Never throws. */
function emojiFor(key) {
    if (!key) return '';
    return live.get(String(key).toLowerCase()) ?? '';
}

/** `key (what it means), key (what it means)` for the prompt. */
function emojiHints() {
    return emojiKeys().map(key => `${key} (${REACTION_EMOJI[key]})`).join(', ');
}

/** Whether anything is loaded at all, for callers that want to skip the work. */
function emojisReady() {
    return live.size > 0;
}

/** Tests only. */
function _setLive(entries) {
    live = new Map(entries);
    loadedAt = entries.length ? Date.now() : null;
}
function _reset() {
    live = new Map();
    loadedAt = null;
}
function _loadedAt() {
    return loadedAt;
}

module.exports = {
    loadEmojis,
    emojiKeys,
    emojiFor,
    emojiHints,
    emojisReady,
    _setLive,
    _reset,
    _loadedAt,
};
