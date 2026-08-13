// src/utils/constants.js - Shared Constants for Moksi's Bazaar
// Consolidated configuration module - all bot settings centralized here

// ── BOT CONFIGURATION ───────────────────────────────────────────────────────
const OWNER_ID = '619637817294848012';
const DEFAULT_TIMEOUT = 60000; // 1 minute for button collectors

// ── WHO THE BOT IS ──────────────────────────────────────────────────────────
/**
 * One source of truth for the bot's own identity.
 *
 * It used to be written out by hand in five prompts across five files, in four
 * different wordings: the reply prompt called it "a bot Moksi built and
 * modelled on himself", three others called it "a dry cynical AI", and the
 * casino heckler was forbidden from acknowledging what it was at all. None of
 * them used its actual Discord name. Renaming it meant finding eight strings.
 */
const BOT_IDENTITY = Object.freeze({
    /** Exactly as the display name reads in Discord. */
    name: 'The Cooler Moksi',
    /** What everyone actually calls it, itself included. */
    shortName: 'Cooler Moksi',
    creator: 'Moksi',
    /**
     * The one-line version, for the small prompts that only need to know who
     * is speaking (heckles, relationship summaries, profile distillation).
     */
    line: 'You are The Cooler Moksi, usually just "Cooler Moksi": a dry, cynical Discord bot '
        + 'that Moksi built and modelled on himself.',
    /**
     * How its own prior lines are labelled in the chat log it reads. Three
     * separate places parse this string, so it lives here rather than being
     * retyped and silently drifting apart.
     */
    ownLineLabel: 'You (Cooler Moksi)',
});

/**
 * Every model id that is not chosen from /speak_settings.
 *
 * They were scattered across db.js and speak.js as bare strings, which is how
 * a delisted vision fallback survived for months: nothing enumerated what the
 * bot was configured to call, so nothing could check it. utils/modelCheck.js
 * verifies this list plus the configurable ones against OpenRouter at boot.
 */
const SPEAK_MODELS = Object.freeze({
    /** The pre-pipeline writer, still used whenever drafts are switched off. */
    LEGACY_WRITER: 'deepseek/deepseek-chat',
    VISION: 'google/gemini-3.1-flash-lite',
    VISION_FALLBACK: 'qwen/qwen3-vl-8b-instruct',
    /** Last resort under the sentiment cascade; deliberately a different family. */
    SENTIMENT_SAFETY_NET: 'deepseek/deepseek-chat',
});

/**
 * What the bot can actually do, in its own words.
 *
 * Built from the commands that actually registered rather than written by
 * hand. The hand-written version named 32 of them and the bot has 71: the
 * media files each export a whole family, so reading one name per file missed
 * roughly thirty. A list that is wrong about what it can do is worse than no
 * list, because it makes the bot deny real features with confidence.
 *
 * It is fixed for the life of the process, so it sits in the cacheable prompt
 * prefix and costs nothing after the first call.
 *
 * @param {Iterable<string>} names registered command names
 */
function botCapabilities(names) {
    const list = [...names].filter(Boolean).sort();
    if (list.length === 0) return '';
    return `- What you can actually do, so you never invent a feature or deny a real one. `
        + `You run this server's casino on a fake currency, you edit images, video and audio people `
        + `post, and you quietly guard the door against sketchy new accounts. These are every command `
        + `you have, and you have no others: ${list.map(n => `/${n}`).join(' ')}. `
        + `When someone names one in chat, you know what they mean. Never recite this list and never `
        + `advertise it; if something is not on it, you cannot do it.`;
}

// Sleepy command allowed guilds
const SLEEPY_GUILDS = ['1217066705537204325', '1347922267853553806'];

// ── ATTITUDE & SENTIMENT ────────────────────────────────────────────────────
const ATTITUDE_LEVELS = {
    HOSTILE: 'hostile',
    CAUTIOUS: 'cautious',
    NEUTRAL: 'neutral',
    FAMILIAR: 'familiar',
    FRIENDLY: 'friendly'
};

const SENTIMENT_THRESHOLDS = {
    // Auto-emoji triggers
    AUTO_EMOJI_NEGATIVE: -0.6,
    AUTO_EMOJI_POSITIVE: 0.6,
    
    // Attitude level transitions
    HOSTILE_THRESHOLD: -0.6,
    CAUTIOUS_THRESHOLD: -0.25,
    FAMILIAR_THRESHOLD: 0.25,
    FRIENDLY_THRESHOLD: 0.6,
    
    // Impact factors
    HIGH_IMPACT: 0.2,  // For messages with sentiment > 0.8
    LOW_IMPACT: 0.1,   // For normal messages
    MAX_CHANGE: 0.3    // Maximum single-message sentiment shift
};

const SENTIMENT_DECAY = {
    DAYS_THRESHOLD: 3,      // Days before decay starts
    DECAY_MULTIPLIER: 0.9   // Multiply score by this after threshold
};

// ── GAME CONFIGURATION ──────────────────────────────────────────────────────
const GAME_CONFIG = {
    BLACKJACK: {
        COLOR_BLACKJACK: '#800080', // Purple
        COLOR_WIN: '#00a86b',       // Green
        COLOR_LOSS: '#dc143c',      // Red
        COLLECTOR_TIMEOUT: 120000   // 2 minutes per action
    },
    GACHA: {
        COLLECTOR_TIMEOUT: 60000,   // 1 minute
        JITTER_MAX: 60000,          // 60 second jitter range
        INITIAL_COOLDOWN: 5000,     // 5 seconds initial
        TIERS: [
            {
                name: 'Common',
                weight: 45,
                color: '#808080',
                rewards: { min: 150, max: 600 },
                cooldown: 120000 // 2 minutes
            },
            {
                name: 'Rare',
                weight: 28,
                color: '#4169e1',
                rewards: { min: 700, max: 2000 },
                cooldown: 480000 // 8 minutes
            },
            {
                name: 'Epic',
                weight: 17,
                color: '#9932cc',
                rewards: { min: 2500, max: 7500 },
                cooldown: 1800000 // 30 minutes
            },
            {
                name: 'Legendary',
                weight: 8,
                color: '#ffd700',
                rewards: { min: 8000, max: 25000 },
                cooldown: 7200000 // 2 hours
            },
            {
                name: 'Mythic',
                weight: 2,
                color: '#ff00ff',
                rewards: { min: 25000, max: 100000 },
                cooldown: 28800000 // 8 hours
            }
        ]
    },
    ROULETTE: {
        COLLECTOR_TIMEOUT: 60000,
        COLORS: ['red', 'black', 'green'],
        PAYOUT_RED: 2,
        PAYOUT_BLACK: 2,
        PAYOUT_GREEN: 17
    },
    SLOTS: {
        COLLECTOR_TIMEOUT: 60000,
        SYMBOLS: [
            { emoji: '🍒', weight: 30, payout: 2 },
            { emoji: '🍊', weight: 25, payout: 3 },
            { emoji: '🍋', weight: 20, payout: 4 },
            { emoji: '💎', weight: 15, payout: 10 },
            { emoji: '🎰', weight: 8, payout: 50 },
            { emoji: '👑', weight: 2, payout: 100 }
        ]
    },
    CRAPS: {
        COLLECTOR_TIMEOUT: 60000
    },
    COINFLIP: {
        COLLECTOR_TIMEOUT: 60000
    },
    DUELS: {
        DUEL_TIMEOUT: 30000 // 30 seconds to accept challenge
    }
};

// ── MEMORY & CONTEXT LIMITS ─────────────────────────────────────────────────
const MEMORY_LIMITS = {
    // The bot's own replies occupy the same window as human messages, so in an
    // active exchange roughly half of these slots are its own voice. These
    // numbers are sized so the human side of the conversation stays useful.
    CONVERSATION_MESSAGES: 18,    // Messages to include in AI context
    FETCH_LIMIT: 25,              // Messages to fetch from Discord
    MESSAGE_CHAR_LIMIT: 600,      // Per-message truncation inside the chat log
    RECENT_MEMORIES: 4,           // Past conversations to include
    PER_USER_KEPT: 30             // Raw exchanges retained per user (was a
                                  // 1000-row cap for the entire server)
};

// ── API TIMEOUTS & LIMITS ───────────────────────────────────────────────────
const TIMEOUTS = {
    API_CALL: 15000,           // General API call timeout (15s)
    MEDIA_ANALYSIS: 10000,     // Image analysis timeout (10s)
    BUTTON_COLLECTOR: 60000,   // Button interaction timeout (60s)
    MODAL_SUBMIT: 60000        // Modal submission timeout (60s)
};

const API_COST_THRESHOLDS = {
    DAILY_WARN: 5.00,
    WEEKLY_WARN: 25.00,
    MONTHLY_WARN: 100.00
};

// ── API & EXTERNAL SERVICES ─────────────────────────────────────────────────
const API_CONFIG = {
    OPENROUTER: {
        BASE_URL: 'https://openrouter.ai/api/v1/chat/completions',
        TIMEOUT: 10000, // 10 seconds
        DEFAULT_PROMPT: 'Describe this image in a concise way, focusing on the main subject.',
        MAX_TOKENS: 300
    },
    MEDIA: {
        CACHE_MAX_ROWS: 1000,
        CACHE_CLEANUP_INTERVAL: 3600000, // 1 hour
        TTL_DAYS: 30 // Keep cache for 30 days
    }
};

// ── DATABASE CONFIGURATION ──────────────────────────────────────────────────
const DATABASE_CONFIG = {
    POOL_CONFIG: {
        max: 20,                      // Maximum connections
        min: 5,                       // Minimum idle connections
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000
    },
    STATEMENT_TIMEOUT: 30000 // 30 seconds per query
};

// ── LOGGING CONFIGURATION ───────────────────────────────────────────────────
const LOGGING_CONFIG = {
    LEVEL: process.env.LOG_LEVEL || 'info',
    FILE: 'logs/bot.log',
    MAX_SIZE: '10m',
    MAX_FILES: '5'
};

// ── COOLDOWN SETTINGS ───────────────────────────────────────────────────────
const COOLDOWNS = {
    MEDIA_ANALYSIS_PER_USER_PER_DAY: 20 // Not used since rate limit removed, but kept for future
};

// ── EMBED COLORS ────────────────────────────────────────────────────────────
const EMBED_COLORS = {
    // Attitude-based colors
    HOSTILE: 0xFF0000,      // Red
    CAUTIOUS: 0xFFA500,     // Orange
    NEUTRAL: 0x808080,      // Gray
    FAMILIAR: 0x00FFFF,     // Cyan
    FRIENDLY: 0x00FF00,     // Green
    
    // Status colors
    SUCCESS: 0x00FF00,      // Green
    ERROR: 0xFF0000,        // Red
    WARNING: 0xFFA500,      // Orange
    INFO: 0x00AAFF,         // Blue
    
    // Special game states
    BLACKJACK: 0x800080,    // Purple
    WIN: 0x00FF00,          // Green
    LOSE: 0xFF0000          // Red
};

// ── EMOJIS ──────────────────────────────────────────────────────────────────
/**
 * The reaction faces the model may end a reply with, and what each one means.
 *
 * Keys, not ids: the id of every one of these is read from the Discord API at
 * boot by emojiRegistry, because an id written into source cannot be told apart
 * from a working one once it stops resolving. A key here with no uploaded image
 * is offered to nobody, so adding a line to this table does nothing until
 * `emojis/<key>.<ext>` exists and `node scripts/syncEmojis.js` has run.
 *
 * The descriptions are written to be mutually exclusive. Sixteen faces of the
 * same person are easy to confuse, and a hint like "annoyed" on three of them
 * makes the choice a coin flip; each line below names the thing that makes
 * that face the only right answer.
 */
const REACTION_EMOJI = {
    angry:     'snapping at someone, actually annoyed rather than playing at it',
    bored:     'tuned out, nothing here is holding your attention',
    confused:  'thrown by what was just said, genuinely not following',
    dazed:     'vacant, nothing behind the eyes, no thought at all',
    huh:       'a blank "???", you have no idea what they are on about',
    laughing:  'genuinely laughing, something actually landed',
    look:      'a sideways glance held a beat too long, said without saying it',
    neutral:   'a flat stare, deliberately no reaction',
    peace:     'a casual sign-off, leaving it there, "sure, whatever"',
    point:     'calling attention to one specific thing, "that, there"',
    sad:       'genuinely down about it, not joking',
    scold:     'telling someone off, an exasperated lecture',
    shock:     'caught off guard, did not see that coming',
    sigh:      'letting it go, not worth the argument',
    smile:     'sly and pleased, smug approval',
    talking:   'mid-sentence, making a point in passing',
    thinking:  'turning something over, not convinced it adds up',
    tired:     'worn out, a long day of exactly this',
    unamused:  'not laughing, unimpressed by the attempt',
    upset:     'hurt, taking it badly',
    yell:      'a loud outburst, shouting it',
};

/**
 * What to react with when the model picked nothing.
 *
 * Every value has to be a key of REACTION_EMOJI; a fallback pointing at a
 * missing key silently produced no emoji at all, which is how the old
 * `goat_small_bleat` mapping survived long after anyone read it.
 */
const REACTION_FALLBACK = {
    hostile: 'angry',
    cautious: 'neutral',
    friendly: 'smile',
    familiar: 'talking',
    negativeSentiment: 'tired',
    positiveSentiment: 'smile',
};

// Nuanced persona instruction per attitude level (all 5 buckets, not just 3)
const ATTITUDE_INSTRUCTIONS = {
    hostile:  "You openly dislike this person. Answers are sharp, mocking, unwelcoming. Do not help them eagerly.",
    cautious: "You are guarded with this one; they've been rude before. Short, terse, skeptical replies.",
    neutral:  "You don't really know them. Dry, deadpan, indifferent; treat them like a stranger at a bus stop.",
    familiar: "You've talked with them enough that they're alright. A little warmer than default, still dry.",
    friendly: "You actually like this one. Warm but never gushing. Easy to joke with, still understated."
};

// ── MESSAGES ────────────────────────────────────────────────────────────────
const SPEAK_DISABLED_REPLIES = [
    "Sorry, no more talking for now.",
    "Off duty.",
    "Shush.",
    "No."
];

const OWNER_REJECTION_JOKES = [
    "Hands off, weirdo.",
    "you STINK.",
    "Shoo.",
    "You are not the guy.",
    "No.",
    "Absolutely not.",
    "lol",
    "Access denied. Appeal denied. Appeal of appeal denied.",
    "Not with those hands."
];

// ── HELPER FUNCTIONS ────────────────────────────────────────────────────────

/**
 * Gets embed color for a given attitude level
 * @param {string} attitudeLevel - One of ATTITUDE_LEVELS values
 * @returns {number} Hex color code
 */
function getColorForAttitude(attitudeLevel) {
    switch (attitudeLevel) {
        case ATTITUDE_LEVELS.HOSTILE: return EMBED_COLORS.HOSTILE;
        case ATTITUDE_LEVELS.CAUTIOUS: return EMBED_COLORS.CAUTIOUS;
        case ATTITUDE_LEVELS.NEUTRAL: return EMBED_COLORS.NEUTRAL;
        case ATTITUDE_LEVELS.FAMILIAR: return EMBED_COLORS.FAMILIAR;
        case ATTITUDE_LEVELS.FRIENDLY: return EMBED_COLORS.FRIENDLY;
        default: return EMBED_COLORS.NEUTRAL;
    }
}

/**
 * Gets emoji indicator for attitude level
 * @param {string} attitudeLevel - One of ATTITUDE_LEVELS values
 * @returns {string} Emoji character
 */
function getEmojiForAttitude(attitudeLevel) {
    switch (attitudeLevel) {
        case ATTITUDE_LEVELS.HOSTILE: return '🖕';
        case ATTITUDE_LEVELS.CAUTIOUS: return '🤨';
        case ATTITUDE_LEVELS.NEUTRAL: return '😐';
        case ATTITUDE_LEVELS.FAMILIAR: return '💚';
        case ATTITUDE_LEVELS.FRIENDLY: return '😊';
        default: return '❓';
    }
}

/**
 * Checks if user is the bot owner
 * @param {string} userId - Discord user ID
 * @returns {boolean} True if owner
 */
function isOwner(userId) {
    return userId === OWNER_ID;
}

// ── EXPORTS ─────────────────────────────────────────────────────────────────
module.exports = {
    // Bot Configuration
    OWNER_ID,
    DEFAULT_TIMEOUT,
    SLEEPY_GUILDS,
    BOT_IDENTITY,
    botCapabilities,
    SPEAK_MODELS,
    
    // Game Configuration
    GAME_CONFIG,
    
    // Sentiment & Attitude
    ATTITUDE_LEVELS,
    SENTIMENT_THRESHOLDS,
    SENTIMENT_DECAY,
    
    // Limits
    MEMORY_LIMITS,
    TIMEOUTS,
    API_COST_THRESHOLDS,
    
    // API & External Services
    API_CONFIG,
    DATABASE_CONFIG,
    LOGGING_CONFIG,
    COOLDOWNS,
    
    // Visual
    EMBED_COLORS,
    REACTION_EMOJI,
    REACTION_FALLBACK,
    ATTITUDE_INSTRUCTIONS,

    // Messages
    SPEAK_DISABLED_REPLIES,
    OWNER_REJECTION_JOKES,
    
    // Helpers
    getColorForAttitude,
    getEmojiForAttitude,
    isOwner
};
