// src/utils/interjections.js
/**
 * Whether the bot butts into a conversation nobody invited it to, and what it
 * knows about the moment when it does.
 *
 * This was forty lines of policy living inside the messageCreate handler. It
 * moved out when interjections stopped being a coin flip in front of the
 * ordinary reply path: the scout's read now travels forward into generation,
 * and the writer's own veto can hand the cooldown back, neither of which an
 * event handler is the right place to own.
 */

const { getSpeakConfigValue } = require('./db');
const { normalisePipeline } = require('./speakPipeline');
const { scoutMoment } = require('./interjectionBouncer');
const logger = require('./logger');

/**
 * channelId -> the timestamp the next cooldown counts from. In memory on
 * purpose: a restart resetting a cooldown is harmless, and this is consulted
 * on every guild message.
 */
const lastInterjection = new Map();

/**
 * How much of the cooldown is forgiven when a moment fails a late gate: it
 * costs a tenth of the window. Charging the full window would let one dull
 * moment buy silence through an interesting one; charging nothing would put
 * the scout on every message in a busy channel.
 *
 * 0.9 rather than the original 0.75: the August 2026 export showed the scout
 * reached only four moments in two days and fired zero interjections. The
 * quality gates (the scout itself, then the writer's veto) are the ones
 * deciding what gets said; the gates ahead of them only decide how often
 * there is anything to judge, and they were starving the judges.
 */
const REJECTED_COOLDOWN_FORGIVEN = 0.9;

/**
 * Decides whether this message earns an unprompted remark, cheapest gate
 * first, and hands back whatever the scout understood about it.
 *
 * @param {import('discord.js').Message} message
 * @returns {Promise<{ok: boolean, scout: {hook: string, mode: string}|null}>}
 */
async function shouldInterject(message) {
    const no = { ok: false, scout: null };

    const config = await getSpeakConfigValue('interjections', null);
    if (!config?.enabled) return no;

    // Channel allowlist is mandatory: "everywhere" is not a mode this ships with.
    if (!Array.isArray(config.channels) || !config.channels.includes(message.channelId)) return no;

    // Keyword filter, when set, is a hard requirement (e.g. only when "moksi"
    // comes up in the staff channel). Without keywords, any message may roll.
    const keywords = Array.isArray(config.keywords) ? config.keywords.filter(Boolean) : [];
    if (keywords.length > 0) {
        const content = message.content?.toLowerCase() ?? '';
        if (!keywords.some(kw => content.includes(String(kw).toLowerCase()))) return no;
    }

    // Cooldown before the dice roll, so a hot channel cannot brute-force it.
    const cooldownMs = cooldownFor(config);
    const last = lastInterjection.get(message.channelId) ?? 0;
    if (Date.now() - last < cooldownMs) return no;

    const chance = Math.min(100, Math.max(0, Number(config.chance) || 0));
    if (Math.random() * 100 >= chance) return no;

    // Last gate, and the only expensive one: everything above decides how
    // often to interject, this decides whether this particular moment is
    // worth it and what about it is worth reacting to. Off unless switched on.
    if (config.bouncer) {
        const pipeline = normalisePipeline(await getSpeakConfigValue('pipeline', null).catch(() => null));
        const read = await scoutMoment(message, { model: pipeline.utilityModel });
        if (!read.worth) {
            forgive(message.channelId, cooldownMs * REJECTED_COOLDOWN_FORGIVEN);
            return no;
        }
        lastInterjection.set(message.channelId, Date.now());
        return { ok: true, scout: { hook: read.hook, mode: read.mode } };
    }

    lastInterjection.set(message.channelId, Date.now());
    return { ok: true, scout: null };
}

/**
 * The writer looked at the moment, wrote its drafts, and decided none of them
 * earned an interruption. That is a success of the silence gate, not a spent
 * turn, so most of the cooldown goes back and the next good moment is not
 * made to wait behind this one.
 * @param {string} channelId
 */
async function creditVeto(channelId) {
    const config = await getSpeakConfigValue('interjections', null).catch(() => null);
    forgive(channelId, cooldownFor(config) * REJECTED_COOLDOWN_FORGIVEN);
    logger.debug('Interjection vetoed; most of the cooldown returned', { channelId });
}

function cooldownFor(config) {
    return Math.max(1, Number(config?.cooldownMinutes) || 10) * 60_000;
}

/** Backdates the clock so `served` of the cooldown counts as already done. */
function forgive(channelId, served) {
    lastInterjection.set(channelId, Date.now() - Math.max(0, served));
}

/** Test seam. */
function resetCooldowns() {
    lastInterjection.clear();
}

module.exports = { shouldInterject, creditVeto, resetCooldowns, REJECTED_COOLDOWN_FORGIVEN };
