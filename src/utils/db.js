/**
 * Database Module
 * Handles all database operations for balances, user preferences, media caching, and game state
 */

const { Pool, types } = require('pg');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const crypto = require('crypto');
const logger = require('./logger');

// Parse BigInts as integers
types.setTypeParser(types.builtins.INT8, v => parseInt(v, 10));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20, // Maximum connections
  min: 5, // Minimum idle connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// ── POOL ERROR HANDLERS ──────────────────────────────────────────────────────
pool.on('error', (err, client) => {
  logger.error('Unexpected error on idle client', { error: err.message, stack: err.stack });
});

pool.on('connect', () => {
  logger.debug('New database connection established');
});

pool.on('remove', () => {
  logger.debug('Database connection removed from pool');
});

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// ── INITIALIZATION ──────────────────────────────────────────────────────────
const init = async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS balances (
            user_id TEXT PRIMARY KEY,
            balance BIGINT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS user_preferences (
            user_id TEXT PRIMARY KEY,
            display_name TEXT,
            interaction_count INTEGER DEFAULT 0,
            last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            attitude_level TEXT DEFAULT 'neutral',
            sentiment_score DECIMAL(4,3) DEFAULT 0.000, 
            last_sentiment_update TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS conversation_memories (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            user_message TEXT,
            bot_response TEXT,
            sentiment_score DECIMAL(4,2),
            timestamp BIGINT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS speak_blacklist (
            user_id TEXT PRIMARY KEY
        );
        CREATE TABLE IF NOT EXISTS settings (
            setting TEXT PRIMARY KEY,
            state BOOLEAN NOT NULL
        );
        CREATE TABLE IF NOT EXISTS media_cache (
            media_id TEXT PRIMARY KEY,
            description TEXT NOT NULL,
            media_type TEXT NOT NULL,
            original_url TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            accessed_count INTEGER DEFAULT 1,
            last_accessed TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_media_cache_accessed ON media_cache(last_accessed);
        CREATE INDEX IF NOT EXISTS idx_conversation_memories_user ON conversation_memories(user_id);
        CREATE INDEX IF NOT EXISTS idx_conversation_memories_timestamp ON conversation_memories(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_user_preferences_composite ON user_preferences(attitude_level, interaction_count DESC);
        CREATE TABLE IF NOT EXISTS pending_duels (
            id SERIAL PRIMARY KEY,
            challenger_id TEXT NOT NULL,
            challenged_id TEXT NOT NULL,
            amount BIGINT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP NOT NULL,
            status TEXT DEFAULT 'pending'
        );
        CREATE INDEX IF NOT EXISTS idx_pending_duels_challenged ON pending_duels(challenged_id);
        CREATE INDEX IF NOT EXISTS idx_pending_duels_status ON pending_duels(status, expires_at);
        CREATE TABLE IF NOT EXISTS user_cooldowns (
            user_id TEXT PRIMARY KEY,
            command TEXT NOT NULL,
            expires_at TIMESTAMP NOT NULL,
            UNIQUE(user_id, command)
        );
        CREATE INDEX IF NOT EXISTS idx_user_cooldowns_expires ON user_cooldowns(expires_at);
        CREATE TABLE IF NOT EXISTS reminders (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            due_at_utc_ms BIGINT NOT NULL,
            reason TEXT,
            created_at_utc_ms BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at_utc_ms);
        CREATE TABLE IF NOT EXISTS sleepy_counts (
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (guild_id, user_id)
        );
    `);

    // Default Settings
    await pool.query(`
        INSERT INTO settings (setting, state)
        VALUES ('active_speak', true), ('active_media_analysis', true)
        ON CONFLICT DO NOTHING
    `);
};

// ── ECONOMY FUNCTIONS ───────────────────────────────────────────────────────
/**
 * Gets the balance for a user, creating account with seed amount if not exists
 * @param {string} userId - Discord user ID
 * @returns {Promise<number>} User's balance
 */
async function getBalance(userId) {
    const { rows } = await pool.query('SELECT balance FROM balances WHERE user_id = $1', [userId]);
    if (rows.length) return rows[0].balance;
    const seed = 10000;
    await pool.query('INSERT INTO balances (user_id, balance) VALUES ($1, $2)', [userId, seed]);
    logger.debug('New user balance created', { userId, seed });
    return seed;
}

/**
 * Updates a user's balance
 * @param {string} userId - Discord user ID
 * @param {number} newBalance - New balance amount
 */
async function updateBalance(userId, newBalance) {
    await pool.query(`
        INSERT INTO balances (user_id, balance) VALUES ($1, $2)
        ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance
    `, [userId, newBalance]);
    logger.debug('Balance updated', { userId, newBalance });
}

/**
 * Gets top N users by balance
 * @param {number} limit - Number of top users to retrieve (default: 10)
 * @returns {Promise<Array>} Array of {user_id, balance} objects
 */
async function getTopBalances(limit = 10) {
    const { rows } = await pool.query('SELECT user_id, balance FROM balances ORDER BY balance DESC LIMIT $1', [limit]);
    return rows;
}

// ── SETTINGS & BLACKLIST ────────────────────────────────────────────────────
/**
 * Gets a setting state by key
 * @param {string} key - Setting key name
 * @returns {Promise<boolean|null>} Setting state or null if not found
 */
async function getSettingState(key) {
    const { rows } = await pool.query('SELECT state FROM settings WHERE setting = $1', [key]);
    return rows.length > 0 ? rows[0].state : null;
}

/**
 * Checks if a user is blacklisted from using speak command
 * @param {string} userId - Discord user ID
 * @returns {Promise<boolean>} True if blacklisted
 */
async function isUserBlacklisted(userId) {
    const { rows } = await pool.query('SELECT 1 FROM speak_blacklist WHERE user_id = $1', [userId]);
    return rows.length > 0;
}

/**
 * Adds a user to the speak command blacklist
 * @param {string} userId - Discord user ID
 */
async function addUserToBlacklist(userId) {
    await pool.query('INSERT INTO speak_blacklist (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
    logger.info('User added to blacklist', { userId });
}

/**
 * Removes a user from the speak command blacklist
 * @param {string} userId - Discord user ID
 */
async function removeUserFromBlacklist(userId) {
    await pool.query('DELETE FROM speak_blacklist WHERE user_id = $1', [userId]);
    logger.info('User removed from blacklist', { userId });
}

// ── MEDIA ANALYSIS (LLAMA VISION) ───────────────────────────────────────────

function generateMediaId(url, contentHash = null, fileName = '', messageId = '') {
    const uniqueString = `${url}_${messageId}_${fileName}`;
    return crypto.createHash('sha256').update(uniqueString).digest('hex').substring(0, 16);
}

async function getCachedMediaDescription(mediaId) {
    const { rows } = await pool.query(
        'SELECT description, media_type FROM media_cache WHERE media_id = $1',
        [mediaId]
    );

    if (rows.length > 0) {
        pool.query(`UPDATE media_cache SET accessed_count = accessed_count + 1, last_accessed = CURRENT_TIMESTAMP WHERE media_id = $1`, [mediaId]).catch(console.error);
        return rows[0];
    }
    return null;
}

// PRIMARY: Gemini 2.0 Flash (Fast, Smart, ~$0.10/1M tokens)
async function analyzeImageWithOpenRouter(imageUrl, prompt = "Describe this image in a consise way, focusing on the main subject.") {
    if (!OPENROUTER_API_KEY) return null;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 Seconds Max

    try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://discord.com',
                'X-Title': 'Cooler Moksi Media',
            },
            signal: controller.signal,
            body: JSON.stringify({
                // CHANGED: From free Llama to paid (but cheap) Gemini 2.0 Flash
                model: 'google/gemini-2.0-flash-001', 
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            { type: 'image_url', image_url: { url: imageUrl } }
                        ]
                    }
                ],
                max_tokens: 300 // Increased slightly for better detail
            })
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
             // If Gemini fails, try Qwen
             return await analyzeImageFallback(imageUrl, prompt);
        }

        const data = await response.json();
        return data.choices?.[0]?.message?.content?.trim() || null;
    } catch (e) {
        clearTimeout(timeoutId);
        console.error("[MEDIA] Primary Analysis Failed, trying fallback...", e.message);
        return await analyzeImageFallback(imageUrl, prompt);
    }
}

// FALLBACK: Qwen 2.5 VL 7B (Very good at reading text/memes, ~$0.20/1M tokens)
async function analyzeImageFallback(imageUrl, prompt) {
    try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://discord.com',
                'X-Title': 'Cooler Moksi Media Fallback',
            },
            body: JSON.stringify({
                model: 'qwen/qwen-2.5-vl-7b-instruct', 
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            { type: 'image_url', image_url: { url: imageUrl } }
                        ]
                    }
                ],
                max_tokens: 200
            })
        });
        const data = await response.json();
        return data.choices?.[0]?.message?.content?.trim() || null;
    } catch (e) {
        console.error("[MEDIA] Fallback Analysis Failed:", e.message);
        return null;
    }
}

async function processMediaInMessage(message, shouldAnalyze = true) {
    const activeMedia = await getSettingState('active_media_analysis');
    if (activeMedia === false) return [];

    const descriptions = [];
    const messageId = message.id || Date.now().toString();

    // Helper to process a URL
    const processUrl = async (url, type, name) => {
        const mediaId = generateMediaId(url, null, name, messageId);
        const cached = await getCachedMediaDescription(mediaId);

        if (cached) {
            descriptions.push(`[${type}: ${cached.description}]`);
        } else if (shouldAnalyze) {
            // Your preferred concise prompt
            const prompt = "Describe this image in a concise way, focusing on the main subject.";
            
            const desc = await analyzeImageWithOpenRouter(url, prompt);
            if (desc) {
                descriptions.push(`[${type}: ${desc}]`);
                await pool.query(
                    `INSERT INTO media_cache (media_id, description, media_type, original_url) 
                     VALUES ($1, $2, $3, $4) ON CONFLICT (media_id) DO NOTHING`,
                    [mediaId, desc, 'image', url]
                );
            } else {
                descriptions.push(`[${type} (Analysis Failed)]`);
            }
        } else {
            descriptions.push(`[Unanalyzed ${type}]`);
        }
    };

    // 1. Attachments (Images & VIDEOS)
    if (message.attachments?.size > 0) {
        for (const [_, att] of message.attachments) {
            // Handle Images
            if (att.contentType?.startsWith('image/')) {
                await processUrl(att.url, "Image Attachment", att.name);
            }
            // Handle Videos (Try to find a thumbnail)
            else if (att.contentType?.startsWith('video/')) {
                const videoThumbnail = message.embeds.find(e => e.video)?.thumbnail?.url;
                if (videoThumbnail) {
                    await processUrl(videoThumbnail, "Video Thumbnail", att.name);
                } else {
                    descriptions.push(`[Video File: ${att.name}]`);
                }
            }
        }
    }

    // 2. Embeds
    if (message.embeds?.length > 0) {
        for (const embed of message.embeds) {
            if (embed.video && message.attachments.size > 0) continue;
            const url = embed.image?.url || embed.thumbnail?.url;
            if (url) await processUrl(url, "Embedded Image", "embed");
        }
    }
    
    // 3. Stickers (RESTORED AI ANALYSIS)
    if (message.stickers?.size > 0) {
        for (const [_, s] of message.stickers) {
            // Format 1=PNG, 2=APNG, 4=GIF. (Format 3 is Lottie/JSON which AI cannot see).
            if (s.format === 1 || s.format === 2 || s.format === 4) {
                 await processUrl(s.url, "Sticker", s.name);
            } else {
                 // Fallback for Lottie stickers
                 descriptions.push(`[Sticker: ${s.name}]`);
            }
        }
    }

    // 4. Custom Emojis
    const emojiRegex = /<a?:(\w+):(\d+)>/g;
    const emojis = [...(message.content?.matchAll(emojiRegex) || [])];
    
    if (emojis.length > 0) {
        const uniqueNames = [...new Set(emojis.map(m => m[1]))].slice(0, 5);
        if (uniqueNames.length > 0) {
            descriptions.push(`[Custom Emojis used: ${uniqueNames.join(', ')}]`);
        }
    }

    return descriptions;
}

// ── SENTIMENT & RELATIONSHIP ────────────────────────────────────────────────
async function analyzeMessageSentiment(userMessage, conversationContext) {
    if (!OPENROUTER_API_KEY) return { sentiment: 0, reasoning: 'No API' };

    const prompt = `Analyze the sentiment of the last message towards the bot.
    CONTEXT:
    ${conversationContext.slice(-800)}
    MESSAGE: "${userMessage}"
    Determine sentiment (-1.0 to 1.0). Be cynical. Return JSON: {"sentiment": 0.0, "reasoning": "..."}`;

    try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://discord.com',
                'X-Title': 'Cooler Moksi Sentiment',
            },
            body: JSON.stringify({
                model: 'deepseek/deepseek-chat', 
                messages: [
                    { role: 'system', content: 'Output JSON only.' },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 100,
                temperature: 0.1,
                response_format: { type: 'json_object' }
            })
        });
        const data = await response.json();
        return JSON.parse(data.choices?.[0]?.message?.content);
    } catch (e) {
        return { sentiment: 0, reasoning: "Error" };
    }
}

async function getUserContext(userId) {
    const { rows } = await pool.query(
        'SELECT user_id, display_name, interaction_count, attitude_level, sentiment_score, last_sentiment_update, last_seen FROM user_preferences WHERE user_id = $1',
        [userId]
    );
    if (rows.length === 0) return { isNewUser: true, attitudeLevel: 'neutral', sentimentScore: 0, interactionCount: 0 };
    
    const data = rows[0];
    const lastUpdate = new Date(data.last_sentiment_update).getTime();
    const daysSince = (Date.now() - lastUpdate) / (1000 * 60 * 60 * 24);
    
    let currentScore = parseFloat(data.sentiment_score);
    if (daysSince > 3) currentScore = currentScore * 0.9; // Decay

    return {
        isNewUser: false,
        attitudeLevel: data.attitude_level,
        sentimentScore: currentScore,
        displayName: data.display_name,
        interactionCount: data.interaction_count || 0,
        lastSeen: data.last_seen
    };
}

async function updateUserAttitudeWithAI(userId, userMessage, conversationContext) {
    const analysis = await analyzeMessageSentiment(userMessage, conversationContext);
    const userContext = await getUserContext(userId);
    
    let currentScore = userContext.sentimentScore;
    let impactFactor = Math.abs(analysis.sentiment) > 0.8 ? 0.2 : 0.1;
    let newScore = (currentScore * (1 - impactFactor)) + (analysis.sentiment * impactFactor);
    newScore = Math.max(-1, Math.min(1, newScore));

    let newLevel = 'neutral';
    if (newScore <= -0.6) newLevel = 'hostile';
    else if (newScore <= -0.25) newLevel = 'cautious';
    else if (newScore >= 0.6) newLevel = 'friendly';
    else if (newScore >= 0.25) newLevel = 'familiar';
    
    await pool.query(`
        INSERT INTO user_preferences (user_id, interaction_count, attitude_level, sentiment_score, last_sentiment_update)
        VALUES ($1, 1, $2, $3, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
            interaction_count = user_preferences.interaction_count + 1,
            attitude_level = $2,
            sentiment_score = $3,
            last_sentiment_update = NOW(),
            updated_at = NOW()
    `, [userId, newLevel, newScore]);

    return { sentiment: newScore, reasoning: analysis.reasoning };
}

// ── MEMORY ──────────────────────────────────────────────────────────────────
async function storeConversationMemory(userId, channelId, userMessage, botResponse, sentimentScore) {
    await pool.query(`
        INSERT INTO conversation_memories (user_id, channel_id, user_message, bot_response, sentiment_score, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6)
    `, [userId, channelId, userMessage, botResponse, sentimentScore, Date.now()]);

    // Deterministic cleanup: trigger when table exceeds 1000 rows
    const { rows } = await pool.query('SELECT COUNT(*) as count FROM conversation_memories');
    if (rows[0].count > 1000) {
        await pool.query(`
            DELETE FROM conversation_memories WHERE id IN (
                SELECT id FROM conversation_memories ORDER BY timestamp ASC LIMIT 200
            )
        `);
        logger.info('Cleaned up old conversation memories', { deleted: 200, remaining: rows[0].count - 200 });
    }
}

async function getRecentMemories(userId, limit = 5, options = {}) {
    const { excludeContext = false } = options;

    const query = excludeContext
        ? `SELECT user_message, bot_response FROM conversation_memories
           WHERE user_id = $1 AND user_message <> '[context]'
           ORDER BY timestamp DESC LIMIT $2`
        : `SELECT user_message, bot_response FROM conversation_memories
           WHERE user_id = $1 ORDER BY timestamp DESC LIMIT $2`;

    const { rows } = await pool.query(query, [userId, limit]);
    return rows.reverse();
}

async function updateUserPreferences(userId, interaction) {
    const displayName = interaction.member?.displayName || interaction.user?.username || null;

    await pool.query(`
        INSERT INTO user_preferences (user_id, display_name, last_seen)
        VALUES ($1, $2, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
            display_name = COALESCE(EXCLUDED.display_name, user_preferences.display_name),
            last_seen = NOW(),
            updated_at = NOW()
    `, [userId, displayName]);
}

async function getMediaAnalysisProvider() {
    // Check if the setting is active
    const active = await getSettingState('active_media_analysis');
    if (!active) return 'disabled';
    
    // Since you are using OpenRouter for Llama/Gemini
    if (process.env.OPENROUTER_API_KEY) return 'openrouter';
    
    return 'unknown';
}

// ── DUEL STATE PERSISTENCE ──────────────────────────────────────────────────────
/**
 * Creates a pending duel between two users
 * @param {string} challengerId - Discord ID of duel initiator
 * @param {string} challengedId - Discord ID of challenged user
 * @param {number} amount - Wagered amount
 * @param {number} expiryMs - Milliseconds until duel expires (default: 30s)
 * @returns {Promise<number>} Duel ID
 */
async function createPendingDuel(challengerId, challengedId, amount, expiryMs = 30000) {
    const expiresAt = new Date(Date.now() + expiryMs);
    const { rows } = await pool.query(
        `INSERT INTO pending_duels (challenger_id, challenged_id, amount, expires_at)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [challengerId, challengedId, amount, expiresAt]
    );
    logger.info('Duel created', { duelId: rows[0].id, challengerId, challengedId, amount });
    return rows[0].id;
}

/**
 * Retrieves pending duels for a user
 * @param {string} userId - Discord user ID to check
 * @returns {Promise<Array>} Array of pending duel objects
 */
async function getPendingDuelsFor(userId) {
    const { rows } = await pool.query(
        `SELECT * FROM pending_duels WHERE challenged_id = $1 AND status = 'pending' AND expires_at > NOW()`,
        [userId]
    );
    return rows;
}

/**
 * Updates duel status
 * @param {number} duelId - Duel ID
 * @param {string} status - New status (pending, accepted, completed, expired)
 */
async function updateDuelStatus(duelId, status) {
    await pool.query(
        `UPDATE pending_duels SET status = $1 WHERE id = $2`,
        [status, duelId]
    );
    logger.debug('Duel status updated', { duelId, status });
}

/**
 * Deletes a duel
 * @param {number} duelId - Duel ID to delete
 */
async function deleteDuel(duelId) {
    await pool.query(`DELETE FROM pending_duels WHERE id = $1`, [duelId]);
    logger.debug('Duel deleted', { duelId });
}

// ── COOLDOWN MANAGEMENT ─────────────────────────────────────────────────────────
/**
 * Sets a cooldown for a user on a specific command
 * @param {string} userId - Discord user ID
 * @param {string} command - Command name (e.g., 'gacha', 'duel')
 * @param {number} durationMs - Cooldown duration in milliseconds
 */
async function setUserCooldown(userId, command, durationMs) {
    const expiresAt = new Date(Date.now() + durationMs);
    await pool.query(
        `INSERT INTO user_cooldowns (user_id, command, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, command) DO UPDATE SET expires_at = $3`,
        [userId, command, expiresAt]
    );
    logger.debug('Cooldown set', { userId, command, durationMs });
}

/**
 * Gets remaining cooldown time for a user on a command
 * @param {string} userId - Discord user ID
 * @param {string} command - Command name
 * @returns {Promise<number>} Milliseconds remaining (0 if expired)
 */
async function getUserCooldownRemaining(userId, command) {
    const { rows } = await pool.query(
        `SELECT expires_at FROM user_cooldowns WHERE user_id = $1 AND command = $2`,
        [userId, command]
    );
    
    if (rows.length === 0) return 0;
    
    const remaining = new Date(rows[0].expires_at).getTime() - Date.now();
    return Math.max(0, remaining);
}

/**
 * Checks if a user is on cooldown for a command
 * @param {string} userId - Discord user ID
 * @param {string} command - Command name
 * @returns {Promise<boolean>} True if on cooldown
 */
async function isUserOnCooldown(userId, command) {
    const remaining = await getUserCooldownRemaining(userId, command);
    return remaining > 0;
}

/**
 * Clears expired cooldowns (maintenance task)
 */
async function clearExpiredCooldowns() {
    const result = await pool.query(
        `DELETE FROM user_cooldowns WHERE expires_at <= NOW()`
    );
    logger.debug('Expired cooldowns cleared', { rowsDeleted: result.rowCount });
}

// ── MEDIA CACHE CLEANUP ──────────────────────────────────────────────────────
/**
 * Cleans up old media cache entries (deterministic, not probabilistic)
 * Runs automatically if table has >1000 rows
 */
async function cleanupMediaCache(maxRows = 1000) {
    try {
        // Check cache size
        const { rows: size } = await pool.query('SELECT COUNT(*) as count FROM media_cache');
        const count = parseInt(size[0].count, 10);
        
        if (count > maxRows) {
            logger.info('Media cache cleanup triggered', { currentSize: count, maxRows });
            
            // Delete oldest cache entries, keeping newest maxRows
            const result = await pool.query(
                `DELETE FROM media_cache WHERE media_id NOT IN (
                    SELECT media_id FROM media_cache ORDER BY last_accessed DESC LIMIT $1
                )`,
                [maxRows]
            );
            
            logger.info('Media cache cleanup completed', { rowsDeleted: result.rowCount });
        }
    } catch (error) {
        logger.error('Media cache cleanup failed', { error: error.message });
    }
}

// ── EXPORTS ─────────────────────────────────────────────────────────────────
module.exports = {
    pool,
    init,
    // Economy
    getBalance,
    updateBalance,
    getTopBalances,
    // User Management
    isUserBlacklisted,
    addUserToBlacklist,
    removeUserFromBlacklist,
    getSettingState,
    getUserContext,
    updateUserPreferences,
    updateUserAttitudeWithAI,
    // Media & Cache
    processMediaInMessage,
    getMediaAnalysisProvider,
    cleanupMediaCache,
    // Memory & Sentiment
    storeConversationMemory,
    getRecentMemories,
    // Duels (Persistent State)
    createPendingDuel,
    getPendingDuelsFor,
    updateDuelStatus,
    deleteDuel,
    // Cooldowns (Persistent State)
    setUserCooldown,
    getUserCooldownRemaining,
    isUserOnCooldown,
    clearExpiredCooldowns,
};