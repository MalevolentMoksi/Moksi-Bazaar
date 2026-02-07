// src/utils/constants.js - Shared Constants for Moksi's Bazaar

// ── BOT CONFIGURATION ───────────────────────────────────────────────────────
const OWNER_ID = '619637817294848012';

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

// ── MEMORY & CONTEXT LIMITS ─────────────────────────────────────────────────
const MEMORY_LIMITS = {
    CONVERSATION_MESSAGES: 12,    // Messages to include in AI context
    FETCH_LIMIT: 15,              // Messages to fetch from Discord
    RECENT_MEMORIES: 4,           // Past conversations to include
    MAX_STORED_MEMORIES: 1000,    // Total memories before cleanup
    CLEANUP_BATCH: 200            // How many to delete during cleanup
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
// Animated goat emojis (server-specific)
const GOAT_EMOJIS = {
    goat_cry: '<a:goat_cry:1395455098716688424>',
    goat_puke: '<a:goat_puke:1398407422187540530>',
    goat_meditate: '<a:goat_meditate:1395455714901884978>',
    goat_hurt: '<a:goat_hurt:1395446681826234531>',
    goat_exhausted: '<a:goat_exhausted:1397511703855366154>',
    goat_boogie: '<a:goat_boogie:1396947962252234892>',
    goat_small_bleat: '<a:goat_small_bleat:1395444644820684850>',
    goat_scream: '<a:goat_scream:1399489715555663972>',
    goat_smile: '<a:goat_smile:1399444751165554982>',
    goat_pet: '<a:goat_pet:1273634369445040219>',
    goat_sleep: '<a:goat_sleep:1395450280161710262>'
};

// ── MESSAGES ────────────────────────────────────────────────────────────────
const SPEAK_DISABLED_REPLIES = [
    "Sorry, no more talking for now.",
    "The goat rests.",
    "Shush.",
    "No."
];

const OWNER_REJECTION_JOKES = [
    "Woah! Trying to tamper with the wires, buddy?",
    "Hands off, weirdo.",
    "Only the Supreme Goat can tweak these settings.",
    "you STINK.",
    "Shoo.",
    "You are not the guy."
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
    // Configuration
    OWNER_ID,
    
    // Sentiment & Attitude
    ATTITUDE_LEVELS,
    SENTIMENT_THRESHOLDS,
    SENTIMENT_DECAY,
    
    // Limits
    MEMORY_LIMITS,
    TIMEOUTS,
    API_COST_THRESHOLDS,
    
    // Visual
    EMBED_COLORS,
    GOAT_EMOJIS,
    
    // Messages
    SPEAK_DISABLED_REPLIES,
    OWNER_REJECTION_JOKES,
    
    // Helpers
    getColorForAttitude,
    getEmojiForAttitude,
    isOwner
};
