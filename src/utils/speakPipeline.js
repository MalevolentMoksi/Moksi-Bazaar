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
const { BOT_IDENTITY, SPEAK_MODELS, REACTION_EMOJI } = require('./constants');
const logger = require('./logger');

const FLASH = 'deepseek/deepseek-v4-flash-0731';
const WILDCARD = 'moonshotai/kimi-k2.6';
/**
 * The writer for moments where being right matters more than being funny.
 *
 * The August 2026 telemetry round found the worst-rated cluster was fabricated
 * real-world facts: movie recaps where every draft invented plot beats and
 * post-credits scenes, all marked "judge picked fine, all drafts wrong". That
 * is a knowledge failure of the budget writers, and no amount of judging fixes
 * a panel where nobody knows the answer.
 *
 * Verified live on OpenRouter (August 2026): $0.38/M in, $1.88/M out, which at
 * this bot's ~3k in / 80 out shape is ~$0.0013 a draft, cheaper than the
 * wildcard slot it replaces. Different lineage from every other writer AND the
 * judge, which the panel was missing entirely.
 */
const FACTUAL = 'google/gemini-3.7-flash';
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
    /** Takes the last panel slot when the room read says the moment is factual. */
    factualWriter: FACTUAL,
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
    if (typeof raw.factualWriter === 'string' && MODEL_ID_RE.test(raw.factualWriter.trim())) {
        cfg.factualWriter = raw.factualWriter.trim();
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

/**
 * The model every small job runs on: sentiment, profile distillation, casino
 * heckles, relationship summaries, the scout, the pre-pass and the judge.
 *
 * They each used to name their own, and two of those ids were delisted from
 * OpenRouter without anything noticing, because every one of these paths
 * degrades quietly by design. Profile distillation and heckling had a dead
 * primary AND a dead fallback, so both had simply stopped happening. One id,
 * editable from /speak_settings, is one id to keep alive.
 *
 * db.js is required lazily: it reads config through this module's caller and
 * requiring it at load time would close a cycle.
 */
async function getUtilityModel() {
    try {
        const { getSpeakConfigValue } = require('./db');
        return normalisePipeline(await getSpeakConfigValue('pipeline', null)).utilityModel;
    } catch {
        return DEFAULT_PIPELINE.utilityModel;
    }
}

/** Every model id the bot is currently configured to call. */
async function configuredModels() {
    const cfg = normalisePipeline(await (async () => {
        try {
            const { getSpeakConfigValue } = require('./db');
            return await getSpeakConfigValue('pipeline', null);
        } catch { return null; }
    })());
    return [...new Set([
        ...cfg.writers,
        ...cfg.interjection.writers,
        cfg.utilityModel,
        cfg.factualWriter,
        ...Object.values(SPEAK_MODELS),
    ])];
}

// ── READ THE ROOM ───────────────────────────────────────────────────────────

const READ_MODES = {
    question: 'a real question that wants a real answer; if it is about something real, the facts must be right',
    banter: 'banter; wit matters more than information',
    heavy: 'something genuinely serious; drop the bit and be straight',
    media: 'a reaction to something they shared; talk about its contents',
    callout: 'about you specifically; answer as yourself, no bit',
};

/**
 * Which modes want the factual writer on the panel. `media` is included
 * because identifying what was shared is a knowledge task too: "it's thor,
 * just a bad comment" was a media reply, not a question.
 */
const FACTUAL_MODES = new Set(['question', 'media']);

/**
 * The panel for a factual moment: the last slot, wildcard by convention in
 * both the reply and interjection panels, hands its seat to the writer with
 * the world knowledge. The telemetry behind this is unambiguous: on "spoil me
 * X" asks every budget draft invented different wrong facts, so adding a rule
 * or a judge criterion selects among fabrications. Only a writer that knows
 * the answer fixes it.
 */
function factualPanel(writers, factualWriter) {
    if (!factualWriter || !Array.isArray(writers) || writers.length === 0) return writers;
    if (writers.includes(factualWriter)) return writers;
    return [...writers.slice(0, -1), factualWriter];
}

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

    const prompt = `Below is the tail of a Discord conversation. Lines starting "${BOT_IDENTITY.ownLineLabel}" are a bot's own replies. The bot is about to reply.

CONVERSATION:
${conversationContext}

THE TRIGGER:
${ask}

Answer in strict JSON, nothing else, exactly this shape:
{"mode": "question" | "banter" | "heavy" | "media" | "callout", "focus": "the ONE concrete detail most worth reacting to, under 20 words", "tone": 0.0}

mode: "question" = they want a real answer, and a playful ask for real information (a recap, a spoiler, who someone is) is still a question; "banter" = riffing, a joke opening; "heavy" = something serious or emotional; "media" = the point is an image/video/link they shared; "callout" = it is about the bot itself.
tone: how ${askerName} is treating the bot here, -1 (hostile) to 1 (warm), 0 if unclear.`;

    try {
        const reply = await callOpenRouterAPI(utilityModel, [
            { role: 'user', content: prompt },
            // 220 rather than 120: three room reads in the August export came
            // back "empty" by hitting the old cap mid-JSON. The read is
            // ~60 tokens when healthy; the headroom only ever costs when a
            // model rambles, and a truncated read costs the whole pre-pass.
        ], { maxTokens: 220, temperature: 0, timeout: timeoutMs, telemetry: { kind: 'room_read' } });

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

/**
 * Strips the trailing reaction-key line off a draft before the judge sees it.
 *
 * The key is plumbing, not prose: left in place the judge compares which
 * reaction image each writer asked for as if it were part of the reply, and
 * "you goat_small_bleat" is noise in every candidate. Mirrors the rule in
 * extractEmojiKey: only a bare key alone on the last line, and only when text
 * remains, so a one-word reply that happens to be a key ("tired") survives.
 */
function stripReactionKey(text) {
    const known = new Set(Object.keys(REACTION_EMOJI).map(k => k.toLowerCase()));
    const lines = String(text ?? '').split('\n');
    let last = lines.length - 1;
    while (last >= 0 && lines[last].trim() === '') last--;
    if (last < 0) return String(text ?? '').trim();

    const bare = lines[last].trim().toLowerCase().replace(/[.!?]+$/, '');
    if (known.has(bare) || bare === 'none') {
        const rest = lines.slice(0, last).join('\n').trim();
        if (rest) return rest;
    }
    return lines.join('\n').trim();
}

/**
 * The bot's own recent lines, for the repetition and shape criteria. Five
 * rather than two since the August 2026 export: the "typo apology" bit was
 * re-referenced three replies apart, each repeat downvoted, and a two-line
 * window cannot see a joke being run into the ground.
 */
function recentOwnReplies(conversationContext, count = 5) {
    const label = `${BOT_IDENTITY.ownLineLabel}:`;
    return String(conversationContext ?? '')
        .split('\n')
        .filter(l => l.startsWith(label))
        .map(l => l.slice(label.length).trim())
        // A mod panel or file reply renders as "[no text] [panel: ...]".
        // Those are not something the bot SAID, and on the night of the
        // spam incident the judge was literally comparing candidate prose
        // against a moderation report for shape variety. Only typed lines
        // count; the filter runs before the slice so a panel does not
        // shoulder a real reply out of the window.
        .filter(text => text && !text.startsWith('[no text]'))
        .slice(-count);
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

    // Candidates go in shuffled, and the permutation is logged. The August
    // export's picks split 36/26/4 across three FIXED slots, which is either
    // a wildcard that genuinely loses or a judge with first-position and
    // same-family bias, and with a fixed order those are indistinguishable.
    // order[displayPosition] = index into `drafts`.
    const order = drafts.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }
    const numbered = order
        .map((originalIndex, pos) => `${pos + 1}: ${stripReactionKey(drafts[originalIndex]).replace(/\s+/g, ' ').trim()}`)
        .join('\n');

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
1. It reacts to the actual content of the moment, not a format or category, and invents nothing that is not in the log. If media was shared and no tag describes its contents, any reply describing those contents is invention and loses.
2. It does not repeat the bot. A candidate that reuses a joke, callback, opening, or verbal tic visible in the recent replies above loses to one that finds a new angle; referencing the same running joke a second time is repetition, not memory.
3. For shared media, naming what it is plus a stock jab ("ah, the X clip. bold move.") is a caption, not a reaction: it loses to a reply that engages with the content itself or with why they posted it.
4. It commits to something: an opinion, an answer, a specific jab. Contentless dismissal loses.
5. Its shape differs from the recent replies above; if those were flat one-line sneers, another one loses.
6. It reads like a person typing, not a bot performing.

${answerLine}`;

    try {
        // 16 tokens, not 6: four verdicts in the export came back with no
        // digit in them, and a budget that cannot survive one stray word
        // turns a working judge into a silent draft-one fallback.
        const verdict = await callOpenRouterAPI(utilityModel, [
            { role: 'user', content: prompt },
        ], { maxTokens: 16, temperature: 0, timeout: timeoutMs, telemetry: { kind: 'judge', extra: { candidates: drafts.length, veto, order: order.map(i => i + 1).join('') } } });

        const match = String(verdict ?? '').match(/\d+/);
        const picked = match ? Number(match[0]) : -1;
        if (veto && picked === 0) {
            logger.debug('[SPEAK] Judge vetoed every draft', { of: drafts.length });
            return null;
        }
        // The verdict names a display position; the shuffle map turns it back
        // into the draft that was actually standing there.
        const index = picked >= 1 && picked <= order.length ? order[picked - 1] : -1;
        if (index >= 0 && index < drafts.length) {
            logger.debug('[SPEAK] Judge picked draft', { position: picked, index: index + 1, of: drafts.length });
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
    FACTUAL_MODES,
    normalisePipeline,
    getUtilityModel,
    configuredModels,
    readRoom,
    readBlock,
    modeSentence,
    extractJson,
    factualPanel,
    pickBestDraft,
    stripReactionKey,
    recentOwnReplies,
    attitudeSentence,
};
