// ENHANCED DB.JS - V6: Complete Restoration
const { Pool, types } = require('pg');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const crypto = require('crypto');

// Parse BigInts as integers
types.setTypeParser(types.builtins.INT8, v => parseInt(v, 10));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
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
    `);

    // Default Settings
    await pool.query(`
        INSERT INTO settings (setting, state)
        VALUES ('active_speak', true), ('active_media_analysis', true)
        ON CONFLICT DO NOTHING
    `);
};

// ── ECONOMY FUNCTIONS (RESTORED) ────────────────────────────────────────────
async function getBalance(userId) {
    const { rows } = await pool.query('SELECT balance FROM balances WHERE user_id = $1', [userId]);
    if (rows.length) return rows[0].balance;

    const seed = 10000;
    await pool.query('INSERT INTO balances (user_id, balance) VALUES ($1, $2)', [userId, seed]);
    return seed;
}

async function updateBalance(userId, newBalance) {
    await pool.query(`
        INSERT INTO balances (user_id, balance) VALUES ($1, $2)
        ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance
    `, [userId, newBalance]);
}

async function getTopBalances(limit = 10) {
    const { rows } = await pool.query('SELECT user_id, balance FROM balances ORDER BY balance DESC LIMIT $1', [limit]);
    return rows;
}

// ── SETTINGS & BLACKLIST ────────────────────────────────────────────────────
async function getSettingState(key) {
    const { rows } = await pool.query('SELECT state FROM settings WHERE setting = $1', [key]);
    return rows.length > 0 ? rows[0].state : null;
}

async function isUserBlacklisted(userId) {
    const { rows } = await pool.query('SELECT 1 FROM speak_blacklist WHERE user_id = $1', [userId]);
    return rows.length > 0;
}

async function addUserToBlacklist(userId) {
    await pool.query('INSERT INTO speak_blacklist (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
}

async function removeUserFromBlacklist(userId) {
    await pool.query('DELETE FROM speak_blacklist WHERE user_id = $1', [userId]);
}

// ── MEDIA ANALYSIS (UNIFIED OPENROUTER) ─────────────────────────────────────

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

async function analyzeImageWithOpenRouter(imageUrl, prompt = "Describe this image.") {
    if (!OPENROUTER_API_KEY) return "Analysis unavailable (No API Key)";

    try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://discord.com',
                'X-Title': 'Cooler Moksi Media',
            },
            body: JSON.stringify({
                model: 'google/gemini-2.0-flash-exp:free', 
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            { type: 'image_url', image_url: { url: imageUrl } }
                        ]
                    }
                ],
                max_tokens: 150
            })
        });

        if (!response.ok) return await analyzeImageFallback(imageUrl, prompt);

        const data = await response.json();
        return data.choices?.[0]?.message?.content?.trim() || "Unclear image content.";
    } catch (e) {
        console.error("[MEDIA] Analysis Error:", e);
        return null;
    }
}

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
                model: 'minimax/minimax-01', // Excellent fallback vision model
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            { type: 'image_url', image_url: { url: imageUrl } }
                        ]
                    }
                ],
                max_tokens: 150
            })
        });

        const data = await response.json();
        return data.choices?.[0]?.message?.content?.trim() || "Image analysis failed.";
    } catch (e) {
        return "Image analysis unavailable.";
    }
}

// RESTORED: The robust loop that handles Embeds, Stickers, and Emojis
async function processMediaInMessage(message) {
    const activeMedia = await getSettingState('active_media_analysis');
    if (activeMedia === false) return [];

    const descriptions = [];
    const messageId = message.id || Date.now().toString();

    // 1. Attachments
    if (message.attachments && message.attachments.size > 0) {
        for (const [_, att] of message.attachments) {
            if (!att.contentType?.startsWith('image/')) continue;
            const mediaId = generateMediaId(att.url, null, att.name, messageId);
            const cached = await getCachedMediaDescription(mediaId);

            if (cached) {
                descriptions.push(`[Image Attachment: ${cached.description}]`);
            } else {
                const desc = await analyzeImageWithOpenRouter(att.url, "Briefly describe this image for a chat context.");
                if (desc) {
                    descriptions.push(`[Image Attachment: ${desc}]`);
                    await pool.query(
                        `INSERT INTO media_cache (media_id, description, media_type, original_url) 
                         VALUES ($1, $2, $3, $4) ON CONFLICT (media_id) DO NOTHING`,
                        [mediaId, desc, att.contentType, att.url]
                    );
                }
            }
        }
    }

    // 2. Embeds (Thumbnails/Images)
    if (message.embeds && message.embeds.length > 0) {
        for (const embed of message.embeds) {
            const url = embed.image?.url || embed.thumbnail?.url;
            if (url) {
                const mediaId = generateMediaId(url, null, 'embed', messageId);
                const cached = await getCachedMediaDescription(mediaId);
                if (cached) {
                    descriptions.push(`[Embedded Image: ${cached.description}]`);
                } else {
                    const desc = await analyzeImageWithOpenRouter(url, "Briefly describe this embedded image.");
                    if (desc) {
                        descriptions.push(`[Embedded Image: ${desc}]`);
                        await pool.query(
                            `INSERT INTO media_cache (media_id, description, media_type, original_url) 
                             VALUES ($1, $2, $3, $4) ON CONFLICT (media_id) DO NOTHING`,
                            [mediaId, desc, 'image/embed', url]
                        );
                    }
                }
            }
        }
    }
    
    // 3. Stickers
    if (message.stickers && message.stickers.size > 0) {
        message.stickers.forEach(s => descriptions.push(`[Sticker: ${s.name}]`));
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
    const { rows } = await pool.query('SELECT * FROM user_preferences WHERE user_id = $1', [userId]);
    if (rows.length === 0) return { isNewUser: true, attitudeLevel: 'neutral', sentimentScore: 0 };
    
    const data = rows[0];
    const lastUpdate = new Date(data.last_sentiment_update).getTime();
    const daysSince = (Date.now() - lastUpdate) / (1000 * 60 * 60 * 24);
    
    let currentScore = parseFloat(data.sentiment_score);
    if (daysSince > 3) currentScore = currentScore * 0.9; // Decay

    return {
        isNewUser: false,
        attitudeLevel: data.attitude_level,
        sentimentScore: currentScore,
        displayName: data.display_name
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
        INSERT INTO user_preferences (user_id, display_name, interaction_count, attitude_level, sentiment_score, last_sentiment_update)
        VALUES ($1, $2, 1, $3, $4, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            interaction_count = user_preferences.interaction_count + 1,
            attitude_level = $3,
            sentiment_score = $4,
            last_sentiment_update = NOW()
    `, [userId, userMessage.author?.username || 'user', newLevel, newScore]);

    return { sentiment: newScore, reasoning: analysis.reasoning };
}

// ── MEMORY ──────────────────────────────────────────────────────────────────
async function storeConversationMemory(userId, channelId, userMessage, botResponse, sentimentScore) {
    await pool.query(`
        INSERT INTO conversation_memories (user_id, channel_id, user_message, bot_response, sentiment_score, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6)
    `, [userId, channelId, userMessage, botResponse, sentimentScore, Date.now()]);

    if (Math.random() < 0.1) {
        await pool.query(`
            DELETE FROM conversation_memories WHERE user_id = $1 
            AND id NOT IN (SELECT id FROM conversation_memories WHERE user_id = $1 ORDER BY timestamp DESC LIMIT 20)
        `, [userId]);
    }
}

async function getRecentMemories(userId, limit = 5) {
    const { rows } = await pool.query(`
        SELECT user_message, bot_response FROM conversation_memories
        WHERE user_id = $1 ORDER BY timestamp DESC LIMIT $2
    `, [userId, limit]);
    return rows.reverse();
}

async function updateUserPreferences(userId, interaction) {
    await pool.query(`
        INSERT INTO user_preferences (user_id, last_seen) VALUES ($1, NOW())
        ON CONFLICT (user_id) DO UPDATE SET last_seen = NOW()
    `, [userId]);
}

// ── EXPORTS ─────────────────────────────────────────────────────────────────
module.exports = {
    pool,
    init,
    getBalance,
    updateBalance,
    getTopBalances,
    isUserBlacklisted,
    addUserToBlacklist,
    removeUserFromBlacklist,
    getSettingState,
    getUserContext,
    updateUserPreferences,
    updateUserAttitudeWithAI,
    storeConversationMemory,
    getRecentMemories,
    processMediaInMessage
};