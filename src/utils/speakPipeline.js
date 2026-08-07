// src/utils/speakPipeline.js
/**
 * The structural half of the conversation overhaul: read the room first,
 * write several drafts, let a judge pick, instead of publishing whatever a
 * single sample happened to be.
 *
 * Every fix before this one was either "fix an input" or "add a rule", and
 * both hit the same ceiling: one cheap model, one sample at temperature 0.85,
 * published unconditionally. Rules constrain; they do not select. The pieces
 * here select.
 *
 * Everything is off by default and toggled per-piece from /speak_settings, so
 * the legacy single-call path stays byte-identical until a switch is flipped,
 * and any piece that turns out to be a downgrade can be flipped back without
 * losing code.
 *
 * Model choices (researched against live OpenRouter pricing, August 2026, at
 * this bot's real usage shape of ~2000 tokens in / ~80 out per reply):
 *  - deepseek-v4-flash-0731: the top-ranked budget model for character chat,
 *    a third of the old deepseek-chat's price. Three drafts of it cost less
 *    than one draft used to.
 *  - kimi-k2.6 as the wildcard third draft: the humor-famous family, ~7x the
 *    flash price and still a fraction of a cent.
 * With everything on, a reply costs roughly $0.002; the agreed ceiling was
 * $0.005.
 */

const { callOpenRouterAPI } = require('./apiHelpers');
const logger = require('./logger');

const FLASH = 'deepseek/deepseek-v4-flash-0731';
const WILDCARD = 'moonshotai/kimi-k2.6';
/**
 * The fourth voice on the interjection panel. A different lineage from the
 * other three on purpose: two DeepSeek drafts and a Moonshot draft already
 * rhyme with each other, and the point of a wider panel is a wider spread to
 * choose from. Priced against live OpenRouter rates in August 2026, at this
 * bot's real shape of ~2000 tokens in and ~80 out, it adds $0.0009 a draft.
 */
const INTERJECTION_FOURTH = 'z-ai/glm-4.7';

/**
 * Interjections are the one path where latency is nearly free: nobody asked,
 * so nobody is watching a typing indicator. They therefore get the full
 * pipeline whatever the live-reply toggles say, a wider panel of drafts, and
 * a judge that is allowed to answer "none of these" and post nothing at all.
 *
 * That veto is the point of the whole profile. An interjection is only a good
 * surprise when it is genuinely relevant; the bouncer already judges whether
 * the MOMENT deserves a remark, and this judges whether the REMARK does.
 *
 * Whole panel plus scout and judge: roughly $0.0028 a fired interjection,
 * against a $0.005 ceiling, and the channel cooldown bounds how often that
 * can happen at all.
 */
const DEFAULT_INTERJECTION_PROFILE = Object.freeze({
    enabled: true,
    veto: true,
    writers: Object.freeze([FLASH, FLASH, WILDCARD, INTERJECTION_FOURTH]),
});

const DEFAULT_PIPELINE = Object.freeze({
    /** Read-the-room step: what is this moment, what deserves the reaction. */
    prepass: false,
    /** Several drafts in parallel, a judge picks. One toggle: drafts without
     *  a judge would just be paying threefold for the same dice roll. */
    drafts: false,
    /** Memory v2: per-user retention, distilled profiles as the primary
     *  memory, raw exchange pairs demoted to distiller fuel. */
    memory: false,
    /** Attitude v2: one honest relationship sentence instead of five canned
     *  personas, fed by the pre-pass instead of a per-message model cascade. */
    attitude: false,
    writers: Object.freeze([FLASH, FLASH, WILDCARD]),
    /** Pre-pass, scout and judge all run here: tiny outputs, price barely matters. */
    utilityModel: FLASH,
    interjection: DEFAULT_INTERJECTION_PROFILE,
});

/** Model ids look like "vendor/model-name"; good enough to reject garbage. */
const MODEL_ID_RE = /^[\w.:-]+\/[\w.:-]+$/;

/** Keeps a stored writer list from becoming garbage or a runaway bill. */
function cleanWriters(raw, limit) {
    if (!Array.isArray(raw)) return null;
    const writers = raw
        .map(w => String(w ?? '').trim())
        .filter(w => MODEL_ID_RE.test(w))
        .slice(0, limit);
    return writers.length > 0 ? writers : null;
}

function normalisePipeline(raw) {
    const cfg = {
        ...DEFAULT_PIPELINE,
        writers: [...DEFAULT_PIPELINE.writers],
        interjection: { ...DEFAULT_INTERJECTION_PROFILE, writers: [...DEFAULT_INTERJECTION_PROFILE.writers] },
    };
    if (!raw || typeof raw !== 'object') return cfg;

    for (const key of ['prepass', 'drafts', 'memory', 'attitude']) {
        if (typeof raw[key] === 'boolean') cfg[key] = raw[key];
    }
    cfg.writers = cleanWriters(raw.writers, 4) ?? cfg.writers;
    if (typeof raw.utilityModel === 'string' && MODEL_ID_RE.test(raw.utilityModel.trim())) {
        cfg.utilityModel = raw.utilityModel.trim();
    }

    if (raw.interjection && typeof raw.interjection === 'object') {
        for (const key of ['enabled', 'veto']) {
            if (typeof raw.interjection[key] === 'boolean') cfg.interjection[key] = raw.interjection[key];
        }
        // One more slot than a live reply gets: latency is not the constraint here.
        cfg.interjection.writers = cleanWriters(raw.interjection.writers, 5) ?? cfg.interjection.writers;
    }
    return cfg;
}

// ── READ THE ROOM ───────────────────────────────────────────────────────────

const READ_MODES = {
    question: 'a real question that wants a real answer',
    banter: 'banter; wit matters more than information',
    heavy: 'something genuinely serious; drop the bit and be straight',
    media: 'a reaction to something they shared; talk about its contents',
    callout: 'about you specifically; answer as yourself, no bit',
};

function modeSentence(mode) {
    return READ_MODES[mode] || READ_MODES.banter;
}

/** Digs a JSON object out of a model reply that may have chatter around it. */
function extractJson(text) {
    const raw = String(text ?? '');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

/**
 * One fast call that does the comprehension a human does before answering:
 * what kind of moment is this, and what is the one detail worth reacting to.
 * Also reads how the asker is treating the bot, which replaces the separate
 * per-message sentiment cascade when attitude v2 is on: same signal, one
 * fewer model round-trip per reply.
 *
 * @returns {Promise<{mode: string, focus: string, tone: number}|null>}
 *   null when the read failed; the pipeline continues without it.
 */
async function readRoom({ conversationContext, askerName, userRequest, isInterjection, utilityModel, timeoutMs = 6000 }) {
    const ask = isInterjection
        ? '(nobody addressed the bot; it is deciding whether the tail of this chat deserves an unprompted remark)'
        : (userRequest ? `${askerName} said to the bot: "${String(userRequest).slice(0, 400)}"` : `${askerName} pinged the bot without saying anything`);

    const prompt = `Below is the tail of a Discord conversation. Lines starting "You (Cooler Moksi)" are a bot's own replies. The bot is about to reply.

CONVERSATION:
${conversationContext}

THE TRIGGER:
${ask}

Answer in strict JSON, nothing else, exactly this shape:
{"mode": "question" | "banter" | "heavy" | "media" | "callout", "focus": "the ONE concrete detail most worth reacting to, under 20 words", "tone": 0.0}

mode: "question" = they want a real answer; "banter" = riffing, a joke opening; "heavy" = something serious or emotional; "media" = the point is an image/video/link they shared; "callout" = it is about the bot itself.
tone: how ${askerName} is treating the bot here, -1 (hostile) to 1 (warm), 0 if unclear.`;

    try {
        const reply = await callOpenRouterAPI(utilityModel, [
            { role: 'user', content: prompt },
        ], { maxTokens: 120, temperature: 0, timeout: timeoutMs, telemetry: { kind: 'room_read' } });

        const parsed = extractJson(reply);
        if (!parsed) return null;

        const mode = Object.prototype.hasOwnProperty.call(READ_MODES, parsed.mode) ? parsed.mode : 'banter';
        const focus = String(parsed.focus ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
        const toneRaw = Number(parsed.tone);
        const tone = Number.isFinite(toneRaw) ? Math.max(-1, Math.min(1, toneRaw)) : 0;
        return { mode, focus, tone };
    } catch (error) {
        logger.warn('[SPEAK] Room read failed, continuing without it', { error: error.message });
        return null;
    }
}

/** The line the writer receives; deliberately short so it guides, not scripts. */
function readBlock(read) {
    if (!read) return '';
    const focusPart = read.focus ? `; the thing worth reacting to: ${read.focus}` : '';
    return `(your read before answering: this is ${modeSentence(read.mode)}${focusPart})\n`;
}

// ── JUDGE ───────────────────────────────────────────────────────────────────

/** The bot's own recent lines, for the shape-variety criterion. */
function recentOwnReplies(conversationContext, count = 2) {
    return String(conversationContext ?? '')
        .split('\n')
        .filter(l => l.startsWith('You (Cooler Moksi):'))
        .slice(-count)
        .map(l => l.slice('You (Cooler Moksi):'.length).trim());
}

/**
 * Picks the best of several drafts. This is where "a jab needs a target" and
 * "commit to something" stop being pleas aimed at a sampler and become a bar
 * a reply has to clear: a draft that violates them loses to one that does not.
 *
 * With `veto`, the judge may also answer 0, meaning none of these earns the
 * interruption and the bot should say nothing. That option only exists on the
 * interjection path: for a reply somebody actually asked for, silence is not
 * an improvement over a mediocre answer, it is a bug.
 *
 * Failure handling flips with it. Normally any failure returns the first
 * draft, so the judge can only ever improve on the old behaviour of shipping
 * draft one unexamined. Under veto it fails closed instead: nobody asked, so
 * an unjudged remark is worse than none.
 *
 * @returns {Promise<string|null>} the winning draft, or null when vetoed
 */
async function pickBestDraft({ drafts, conversationContext, userPrompt, utilityModel, timeoutMs = 5000, veto = false }) {
    if (!Array.isArray(drafts) || drafts.length === 0) return null;
    if (drafts.length === 1 && !veto) return drafts[0];

    const tail = String(conversationContext ?? '').split('\n').slice(-12).join('\n');
    const ownReplies = recentOwnReplies(conversationContext);
    const numbered = drafts.map((d, i) => `${i + 1}: ${String(d).replace(/\s+/g, ' ').trim()}`).join('\n');

    const vetoClause = veto
        ? `\n\nNobody asked this bot anything: it is about to interrupt a conversation it was not part of. That is only welcome when the remark is genuinely worth reading. If none of the candidates clears every bar below, answer 0 and it will stay silent, which is always an acceptable outcome. Do not settle for the least bad one.`
        : '';
    const answerLine = veto
        ? 'Answer with the winning number alone, or 0 for none of them.'
        : 'Answer with the winning number alone.';

    const prompt = `A dry, lowercase Discord bot wrote ${drafts.length} candidate replies to the same moment. Pick the best one.${vetoClause}

THE MOMENT (tail of the chat):
${tail}

WHAT WAS ASKED OF IT:
${String(userPrompt ?? '').slice(0, 500)}

ITS OWN RECENT REPLIES (for shape comparison):
${ownReplies.length ? ownReplies.map(r => `- ${r}`).join('\n') : '(none visible)'}

CANDIDATES:
${numbered}

Judge in this order:
1. It reacts to the actual content of the moment, not a format or category, and invents nothing that is not in the log.
2. It commits to something: an opinion, an answer, a specific jab. Contentless dismissal loses.
3. Its shape differs from the recent replies above; if those were flat one-line sneers, another one loses.
4. It reads like a person typing, not a bot performing.

${answerLine}`;

    try {
        const verdict = await callOpenRouterAPI(utilityModel, [
            { role: 'user', content: prompt },
        ], { maxTokens: 6, temperature: 0, timeout: timeoutMs, telemetry: { kind: 'judge', extra: { candidates: drafts.length, veto } } });

        const match = String(verdict ?? '').match(/\d+/);
        const picked = match ? Number(match[0]) : -1;
        if (veto && picked === 0) {
            logger.debug('[SPEAK] Judge vetoed every draft', { of: drafts.length });
            return null;
        }
        const index = picked - 1;
        if (index >= 0 && index < drafts.length) {
            logger.debug('[SPEAK] Judge picked draft', { index: picked, of: drafts.length });
            return drafts[index];
        }
        // An unreadable verdict is not a veto; it is a judge that did not
        // answer, which lands on the same fail rule as an exception.
        return veto ? null : drafts[0];
    } catch (error) {
        logger.warn('[SPEAK] Judge failed', { veto, error: error.message });
        return veto ? null : drafts[0];
    }
}

// ── ATTITUDE SENTENCE ───────────────────────────────────────────────────────

/**
 * One honest line composed from score and history, replacing the five canned
 * personas. The personas contradicted the relationship data they sat next to:
 * a "neutral" user with 200 exchanges was described as a stranger at a bus
 * stop on the same screen that called them a regular, and the model was fed
 * both on every reply.
 */
function attitudeSentence(userContext) {
    const n = userContext?.interactionCount || 0;
    const s = Number(userContext?.sentimentScore) || 0;

    const age = n === 0 ? 'you have never spoken with them before'
        : n < 5 ? `you have barely spoken (${n} exchanges)`
        : n < 20 ? `you have talked a handful of times (${n} exchanges)`
        : n < 60 ? `you have talked plenty (${n} exchanges)`
        : `they are a regular; you have talked a lot (${n} exchanges)`;

    const feel = s <= -0.6 ? 'they have earned real hostility; be sharp and unwelcoming with them'
        : s <= -0.25 ? 'they have been rude enough that you are guarded and terse with them'
        : s < 0.25 ? (n >= 20
            ? 'no strong feelings either way; familiar, not close'
            : 'no history to speak of; dry and indifferent, like a stranger')
        : s < 0.6 ? 'you are warming to them; a little less guarded than usual'
        : 'you genuinely like this one; warm but never gushing';

    return `${age}; ${feel}.`;
}

module.exports = {
    DEFAULT_PIPELINE,
    DEFAULT_INTERJECTION_PROFILE,
    normalisePipeline,
    readRoom,
    readBlock,
    modeSentence,
    extractJson,
    pickBestDraft,
    recentOwnReplies,
    attitudeSentence,
};
