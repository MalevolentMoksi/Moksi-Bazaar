// src/utils/ui/mode.js
/**
 * Which rendering style each surface of the bot uses.
 *
 * Discord's Components V2 is opt-in per message via a flag that CANNOT be
 * removed once the message is sent. That makes a live toggle dangerous unless
 * every edit renders in the mode its message was born in, so this module only
 * ever answers "what should a NEW message use". Edits resolve their mode from
 * the message itself (see isV2Message in panel.js).
 *
 * Reads are synchronous on purpose: ui() is called inline inside
 * interaction.reply({...}) at roughly a hundred sites, and making those await
 * a database round trip would be both slow and invasive. The toggle lives in
 * speak_config and is mirrored into memory at boot and on every write.
 */

const { getSpeakConfigValue, setSpeakConfigValue } = require('../db');
const logger = require('../logger');

const CONFIG_KEY = 'embed_v2_modes';

/**
 * The surfaces that can be switched independently. Grouped by how they are
 * used rather than by folder, since that is how someone judging the look
 * thinks about them.
 */
const SCOPES = {
    casino: 'Casino games, economy and the shop',
    speak:  'Chat personality, relationships and profiles',
    mod:    'Moderation, join gate and guard',
    media:  'Media commands and file replies',
    misc:   'Reminders, boot report and everything else',
};

const SCOPE_NAMES = Object.keys(SCOPES);

/** Nothing is on until someone turns it on. */
const DEFAULTS = Object.fromEntries(SCOPE_NAMES.map(name => [name, false]));

let cache = { ...DEFAULTS };

/** Drops anything that is not a known scope, so a stale row cannot resurrect one. */
function sanitise(stored) {
    const clean = { ...DEFAULTS };
    if (stored && typeof stored === 'object') {
        for (const name of SCOPE_NAMES) {
            if (stored[name] === true) clean[name] = true;
        }
    }
    return clean;
}

/** Loads the toggle into memory. Call once at boot; never throws. */
async function loadModes() {
    try {
        cache = sanitise(await getSpeakConfigValue(CONFIG_KEY, null));
    } catch (error) {
        cache = { ...DEFAULTS };
        logger.warn('[UI] Could not load embed mode config, defaulting to embeds', {
            error: error.message,
        });
    }
    return { ...cache };
}

/** True when new messages on this surface should use Components V2. */
function isV2Scope(scope) {
    return cache[scope] === true;
}

/** A copy, so callers cannot mutate the cache by accident. */
function allModes() {
    return { ...cache };
}

/**
 * Turns one scope on or off. Writes through to the database and updates the
 * in-memory copy only after the write lands, so a failed write cannot leave
 * the running bot disagreeing with what is stored.
 */
async function setMode(scope, enabled) {
    if (!SCOPE_NAMES.includes(scope)) {
        throw new Error(`Unknown surface "${scope}".`);
    }
    const next = { ...cache, [scope]: Boolean(enabled) };
    await setSpeakConfigValue(CONFIG_KEY, next);
    cache = next;
    return { ...cache };
}

/** Turns every scope on or off at once. */
async function setAllModes(enabled) {
    const next = Object.fromEntries(SCOPE_NAMES.map(name => [name, Boolean(enabled)]));
    await setSpeakConfigValue(CONFIG_KEY, next);
    cache = next;
    return { ...cache };
}

/** Test seam: sets the cache without touching the database. */
function _setCacheForTests(next) {
    cache = sanitise(next);
}

module.exports = {
    CONFIG_KEY,
    SCOPES,
    SCOPE_NAMES,
    DEFAULTS,
    loadModes,
    isV2Scope,
    allModes,
    setMode,
    setAllModes,
    _setCacheForTests,
};
