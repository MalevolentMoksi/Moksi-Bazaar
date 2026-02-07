/**
 * Configuration Module
 * Centralized configuration and constants for the bot
 */

module.exports = {
  // Bot Settings
  BOT: {
    OWNER_ID: process.env.OWNER_ID || '619637817294848012',
    DEFAULT_TIMEOUT: 60000, // 1 minute for button collectors
  },

  // Game Configuration
  GAMES: {
    BLACKJACK: {
      COLOR_BLACKJACK: '#800080', // Purple
      COLOR_WIN: '#00a86b', // Green
      COLOR_LOSS: '#dc143c', // Red
      COLLECTOR_TIMEOUT: 120000, // 2 minutes per action
    },
    GACHA: {
      COLLECTOR_TIMEOUT: 60000, // 1 minute
      JITTER_MAX: 60000, // 60 second jitter range
      INITIAL_COOLDOWN: 5000, // 5 seconds initial
      TIERS: [
        {
          name: 'Common',
          weight: 50,
          color: '#808080',
          rewards: { min: 10, max: 50 },
          cooldown: 60000, // 1 minute
        },
        {
          name: 'Rare',
          weight: 30,
          color: '#4169e1',
          rewards: { min: 50, max: 150 },
          cooldown: 180000, // 3 minutes
        },
        {
          name: 'Epic',
          weight: 15,
          color: '#9932cc',
          rewards: { min: 150, max: 500 },
          cooldown: 600000, // 10 minutes
        },
        {
          name: 'Legendary',
          weight: 4,
          color: '#ffd700',
          rewards: { min: 500, max: 2000 },
          cooldown: 3600000, // 1 hour
        },
        {
          name: 'Mythic',
          weight: 1,
          color: '#ff00ff',
          rewards: { min: 2000, max: 5000 },
          cooldown: 86400000, // 24 hours
        },
      ],
    },
    ROULETTE: {
      COLLECTOR_TIMEOUT: 60000,
      COLORS: ['red', 'black', 'green'],
      PAYOUT_RED: 2,
      PAYOUT_BLACK: 2,
      PAYOUT_GREEN: 17,
    },
    SLOTS: {
      COLLECTOR_TIMEOUT: 60000,
      SYMBOLS: [
        { emoji: '🍒', weight: 30, payout: 2 },
        { emoji: '🍊', weight: 25, payout: 3 },
        { emoji: '🍋', weight: 20, payout: 4 },
        { emoji: '💎', weight: 15, payout: 10 },
        { emoji: '🎰', weight: 8, payout: 50 },
        { emoji: '👑', weight: 2, payout: 100 },
      ],
    },
    CRAPS: {
      COLLECTOR_TIMEOUT: 60000,
    },
    COINFLIP: {
      COLLECTOR_TIMEOUT: 60000,
    },
    DUELS: {
      DUEL_TIMEOUT: 30000, // 30 seconds to accept challenge
    },
  },

  // API & External Services
  API: {
    OPENROUTER: {
      BASE_URL: 'https://openrouter.ai/api/v1/chat/completions',
      TIMEOUT: 10000, // 10 seconds
      DEFAULT_PROMPT: 'Describe this image in a concise way, focusing on the main subject.',
      MAX_TOKENS: 300,
    },
    MEDIA: {
      CACHE_MAX_ROWS: 1000,
      CACHE_CLEANUP_INTERVAL: 3600000, // 1 hour
      TTL_DAYS: 30, // Keep cache for 30 days
    },
  },

  // Emojis
  EMOJIS: {
    GOAT: ['🐐', '🐐'],
    SUCCESS: '✅',
    ERROR: '❌',
    LOADING: '⏳',
    COIN_HEADS: '🪙',
    COIN_TAILS: '🪙',
  },

  // Database Configuration
  DATABASE: {
    POOL_CONFIG: {
      max: 20, // Maximum connections
      min: 5, // Minimum idle connections
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    },
    STATEMENT_TIMEOUT: 30000, // 30 seconds per query
  },

  // Logging
  LOGGING: {
    LEVEL: process.env.LOG_LEVEL || 'info',
    FILE: 'logs/bot.log',
    MAX_SIZE: '10m',
    MAX_FILES: '5',
  },

  // Cooldown Settings
  COOLDOWNS: {
    MEDIA_ANALYSIS_PER_USER_PER_DAY: 20, // Not used since rate limit removed, but kept for future
  },
};
