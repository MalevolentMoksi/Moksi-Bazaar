/**
 * Database Module
 * Handles all database operations for balances, user preferences, media caching, and game state
 */

const { Pool, types } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const logger = require('./logger');
const { SENTIMENT_THRESHOLDS, SENTIMENT_DECAY } = require('./constants');
const { downloadToTemp, createTempPath, cleanup, extFromUrl } = require('./media/tempFiles');
const { runFFmpeg } = require('./media/ffmpegUtils');

// Single source of truth for score → attitude level mapping
function scoreToAttitudeLevel(score) {
    if (score <= SENTIMENT_THRESHOLDS.HOSTILE_THRESHOLD)  return 'hostile';
    if (score <= SENTIMENT_THRESHOLDS.CAUTIOUS_THRESHOLD) return 'cautious';
    if (score >= SENTIMENT_THRESHOLDS.FRIENDLY_THRESHOLD) return 'friendly';
    if (score >= SENTIMENT_THRESHOLDS.FAMILIAR_THRESHOLD) return 'familiar';
    return 'neutral';
}

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
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            is_context_only BOOLEAN DEFAULT false
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
            user_id TEXT NOT NULL,
            command TEXT NOT NULL,
            expires_at TIMESTAMP NOT NULL,
            PRIMARY KEY (user_id, command)
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

    // Migration: Add is_context_only column if it doesn't exist
    await pool.query(`
        ALTER TABLE conversation_memories ADD COLUMN IF NOT EXISTS is_context_only BOOLEAN DEFAULT false
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

function generateMediaId(url, contentHash = null, fileName = '') {
    const uniqueString = `${url}_${fileName}`;
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

// PRIMARY: Gemini 3.1 Flash-Lite (2.5X faster TTFT, 45% faster output, $0.25/$1.50/1M, replaces deprecated Gemini 2.0)
// FALLBACK: Qwen 2.5 VL 7B ($0.12/$0.36/1M) — excellent for text/memes, proven reliable
// RETRY: Exponential backoff (100ms, 200ms, 400ms) for transient failures
async function analyzeImageWithOpenRouter(imageUrl, prompt = "Describe this image in a concise way, focusing on the main subject.", attempt = 1) {
    if (!OPENROUTER_API_KEY) return null;
    const MAX_ATTEMPTS = 3;
    const BACKOFF_BASE = 100; // milliseconds

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
                model: 'google/gemini-3.1-flash-lite-preview',
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            { type: 'image_url', image_url: { url: imageUrl } }
                        ]
                    }
                ],
                max_tokens: 300
            })
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            // HTTP error — try fallback
            logger.warn('[MEDIA] Gemini HTTP error, attempting fallback', { status: response.status, attempt });
            return await analyzeImageFallback(imageUrl, prompt);
        }

        const data = await response.json();
        const result = data.choices?.[0]?.message?.content?.trim();
        if (result) {
            logger.debug('[MEDIA] Gemini primary success', { urlLength: imageUrl.length });
            return result;
        }
        
        // Empty response — try fallback
        logger.warn('[MEDIA] Gemini returned empty response, trying fallback');
        return await analyzeImageFallback(imageUrl, prompt);
    } catch (e) {
        clearTimeout(timeoutId);
        
        // Retry logic for transient errors (network, timeout, etc.)
        if (attempt < MAX_ATTEMPTS && (e.name === 'AbortError' || e.message.includes('fetch'))) {
            const backoffMs = BACKOFF_BASE * Math.pow(2, attempt - 1); // 100ms, 200ms, 400ms
            logger.warn('[MEDIA] Transient error, retrying Gemini', { attempt, nextAttemptMs: backoffMs, error: e.message });
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            return await analyzeImageWithOpenRouter(imageUrl, prompt, attempt + 1);
        }
        
        // Failed after retries — fall through to fallback
        logger.error('[MEDIA] Gemini failed after retries, trying fallback', { error: e.message });
        return await analyzeImageFallback(imageUrl, prompt);
    }
}

// FALLBACK: Qwen 2.5 VL 7B (excellent for text/memes, proven reliable, $0.12/$0.36/1M)
async function analyzeImageFallback(imageUrl, prompt) {
    const FALLBACK_TIMEOUT = 8000; // Slightly shorter timeout than primary
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FALLBACK_TIMEOUT);
        
        logger.debug('[MEDIA] Qwen fallback attempt', { urlLength: imageUrl.length });
        
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://discord.com',
                'X-Title': 'Cooler Moksi Media Fallback',
            },
            signal: controller.signal,
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
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            logger.warn('[MEDIA] Qwen HTTP error', { status: response.status });
            return null;
        }
        
        const data = await response.json();
        const result = data.choices?.[0]?.message?.content?.trim();
        if (result) {
            logger.info('[MEDIA] Qwen fallback success');
            return result;
        }
        
        logger.warn('[MEDIA] Qwen returned empty result');
        return null;
    } catch (e) {
        logger.error('[MEDIA] Qwen fallback exception', { error: e.message });
        return null;
    }
}

function isGifMedia(url = '', fileName = '', contentType = '') {
    const ct = String(contentType || '').toLowerCase();
    const name = String(fileName || '').toLowerCase();
    const urlLower = String(url || '').toLowerCase();
    const ext = extFromUrl(urlLower);

    return ct === 'image/gif'
        || ct.includes('gif')
        || name.endsWith('.gif')
        || ext === 'gif'
        || urlLower.includes('.gif');
}

function isAnimatedEmbedCandidate(embed) {
    const embedType = String(embed?.type || '').toLowerCase();
    const candidates = [
        embed?.url,
        embed?.video?.url,
        embed?.video?.proxyURL,
        embed?.image?.url,
        embed?.image?.proxyURL,
        embed?.thumbnail?.url,
        embed?.thumbnail?.proxyURL
    ].filter(Boolean).map(v => String(v).toLowerCase());

    const hasAnimatedHost = candidates.some(u => /tenor\.com|giphy\.com|media\.discordapp\.net|cdn\.discordapp\.com/.test(u));
    const hasAnimatedExt = candidates.some(u => u.includes('.gif') || u.includes('.webm') || u.includes('.mp4'));

    return embedType === 'gifv' || hasAnimatedHost || hasAnimatedExt;
}

async function buildGifStoryboard(gifUrl) {
    let inputPath = null;
    let storyboardPath = null;

    try {
        const sourceExt = extFromUrl(gifUrl) || 'gif';
        inputPath = await downloadToTemp(gifUrl, sourceExt);
        storyboardPath = createTempPath('jpg');

        // Sample animation across time and tile frames into one image (3x2).
        await runFFmpeg(inputPath, storyboardPath, cmd => {
            cmd
                .videoFilters('fps=2,scale=320:-1:flags=lanczos,tile=3x2')
                .outputOptions(['-frames:v 1']);
        });

        return { inputPath, storyboardPath };
    } catch (e) {
        logger.warn('[MEDIA] GIF storyboard generation failed', { error: e.message });
        await cleanup(inputPath, storyboardPath);
        return null;
    }
}

async function analyzeGifWithOpenRouter(gifUrl, prompt) {
    const storyboard = await buildGifStoryboard(gifUrl);
    if (!storyboard?.storyboardPath) {
        return await analyzeImageWithOpenRouter(gifUrl, prompt);
    }

    try {
        const storyboardBuffer = await fs.promises.readFile(storyboard.storyboardPath);
        const storyboardDataUrl = `data:image/jpeg;base64,${storyboardBuffer.toString('base64')}`;
        const gifPrompt = `${prompt}\n\nThis is an animated GIF shown as a storyboard of equally-spaced frames in timeline order (left-to-right, top-to-bottom). Describe both the scene content and what changes across the frames — focus on the event or reaction being shown.`;
        return await analyzeImageWithOpenRouter(storyboardDataUrl, gifPrompt);
    } finally {
        await cleanup(storyboard.inputPath, storyboard.storyboardPath);
    }
}

async function processMediaInMessage(message, shouldAnalyze = true, options = {}) {
    const { forceReanalyze = false } = options;
    const activeMedia = await getSettingState('active_media_analysis');
    if (activeMedia === false) return [];

    const descriptions = [];
    // Helper to process a URL
    const processUrl = async (url, type, name, mediaMeta = {}) => {
        const mediaId = generateMediaId(url, null, name);
        const cached = await getCachedMediaDescription(mediaId);

        if (!forceReanalyze && cached) {
            descriptions.push(`[${type}: ${cached.description}]`);
        } else if (shouldAnalyze) {
            const prompt = "Describe what is shown in this image in 1-2 sentences. This description will be used by a chat AI to react to what was shared — prioritize anything visually striking, emotionally notable, or culturally significant. Name any recognizable characters, memes, or public figures. If text is visible in the image, include it.";

            const desc = mediaMeta.isGif
                ? await analyzeGifWithOpenRouter(url, prompt)
                : await analyzeImageWithOpenRouter(url, prompt);

            if (desc) {
                descriptions.push(`[${type}: ${desc}]`);
                await pool.query(
                    `INSERT INTO media_cache (media_id, description, media_type, original_url) 
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (media_id)
                     DO UPDATE SET
                        description = EXCLUDED.description,
                        media_type = EXCLUDED.media_type,
                        original_url = EXCLUDED.original_url,
                        last_accessed = CURRENT_TIMESTAMP`,
                    [mediaId, desc, mediaMeta.isGif ? 'gif' : 'image', url]
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
                const gifLike = isGifMedia(att.url, att.name, att.contentType);
                await processUrl(att.url, gifLike ? "GIF Attachment" : "Image Attachment", att.name, { isGif: gifLike });
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

            const gifLikeEmbed = isAnimatedEmbedCandidate(embed);
            const preferredUrl = embed.video?.url || embed.video?.proxyURL;

            if (gifLikeEmbed && preferredUrl) {
                await processUrl(preferredUrl, "Embedded GIF", "embed-gifv", { isGif: true });
                continue;
            }

            const url = embed.image?.url || embed.thumbnail?.url;
            if (url) {
                await processUrl(url, gifLikeEmbed ? "Embedded GIF" : "Embedded Image", "embed", { isGif: gifLikeEmbed });
            }
        }
    }
    
    // 3. Stickers (RESTORED AI ANALYSIS)
    if (message.stickers?.size > 0) {
        for (const [_, s] of message.stickers) {
            // Format 1=PNG, 2=APNG, 4=GIF. (Format 3 is Lottie/JSON which AI cannot see).
            if (s.format === 1 || s.format === 2 || s.format === 4) {
                  await processUrl(s.url, "Sticker", s.name, { isGif: s.format === 4 });
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
// PRIMARY: MiMo-V2-Flash ($0.09/$0.29/M) — cost-efficient JSON scoring
// FALLBACK 1: Groq Llama 3.3 8B ($0.05/$0.08/M) — lightweight dense model
// FALLBACK 2: DeepSeek V3 ($0.32/$0.89/M) — full reasoning fallback (safe but expensive)
async function analyzeMessageSentiment(userMessage, conversationContext) {
    if (!OPENROUTER_API_KEY) return { sentiment: 0, reasoning: 'No API' };

    const contextSlice = conversationContext.slice(-800).replace(/^[^\n]*\n/, '');
    const prompt = `Analyze the sentiment of the last message as directed specifically at the bot — not the user's general mood or topic.
CONTEXT:
${contextSlice}
MESSAGE: "${userMessage}"
Rules:
- Score only sentiment directed AT the bot. Venting, seeking help, or expressing emotions about unrelated topics should score near 0.
- Examples: "haha you're actually funny" → 0.5 | "you're so annoying, shut up" → -0.8 | "my day was terrible, help me" → 0.0
- Clamp to [-1.0, 1.0].
Return JSON only: {"sentiment": 0.0, "reasoning": "..."}`;

    // Try MiMo-V2-Flash first (cheapest, native JSON mode, reasoning toggle)
    try {
        logger.debug('Sentiment: Attempting MiMo-V2-Flash primary', { promptLength: prompt.length });
        const { callOpenRouterAPI } = require('./apiHelpers');
        const result = await callOpenRouterAPI('xiaomi/mimo-v2-flash', [
            { role: 'system', content: 'Output JSON only.' },
            { role: 'user', content: prompt }
        ], {
            maxTokens: 100,
            temperature: 0.1,
            timeout: 8000
        });
        if (result) {
            const parsed = JSON.parse(result);
            logger.info('Sentiment: MiMo-V2-Flash success', { sentiment: parsed.sentiment });
            return parsed;
        }
    } catch (e) {
        logger.warn('Sentiment: MiMo-V2-Flash failed', { error: e.message });
    }

    // Fallback 1: Groq Llama 3.3 8B (cheaper than 70B, same family)
    try {
        logger.debug('Sentiment: Attempting Groq Llama 3.3 8B fallback');
        const { callOpenRouterAPI } = require('./apiHelpers');
        const result = await callOpenRouterAPI('meta-llama/llama-3.3-8b-instruct', [
            { role: 'system', content: 'Output JSON only.' },
            { role: 'user', content: prompt }
        ], {
            maxTokens: 100,
            temperature: 0.1,
            timeout: 8000
        });
        if (result) {
            const parsed = JSON.parse(result);
            logger.info('Sentiment: Groq 8B fallback success', { sentiment: parsed.sentiment });
            return parsed;
        }
    } catch (e) {
        logger.warn('Sentiment: Groq 8B fallback failed', { error: e.message });
    }

    // Fallback 2: DeepSeek V3 (proven reliable, use as final safety net)
    try {
        logger.debug('Sentiment: Attempting DeepSeek V3 final fallback');
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
        const result = data.choices?.[0]?.message?.content;
        if (result) {
            const parsed = JSON.parse(result);
            logger.info('Sentiment: DeepSeek V3 fallback success', { sentiment: parsed.sentiment });
            return parsed;
        }
    } catch (e) {
        logger.error('Sentiment: All models failed', { error: e.message });
    }

    // Last resort: neutral
    return { sentiment: 0, reasoning: 'All sentiment models failed; defaulting to neutral' };
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
    let currentLevel = data.attitude_level;

    // Persist decay so reads and writes never disagree (fire-and-forget)
    if (daysSince > SENTIMENT_DECAY.DAYS_THRESHOLD) {
        currentScore = currentScore * SENTIMENT_DECAY.DECAY_MULTIPLIER;
        currentLevel = scoreToAttitudeLevel(currentScore);
        pool.query(
            `UPDATE user_preferences
             SET sentiment_score = $1, attitude_level = $2, last_sentiment_update = NOW(), updated_at = NOW()
             WHERE user_id = $3`,
            [currentScore, currentLevel, userId]
        ).catch(e => logger.warn('Sentiment decay persistence failed', { userId, error: e.message }));
    }

    return {
        isNewUser: false,
        attitudeLevel: currentLevel,
        sentimentScore: currentScore,
        displayName: data.display_name,
        interactionCount: data.interaction_count || 0,
        lastSeen: data.last_seen
    };
}

async function updateUserAttitudeWithAI(userId, userMessage, conversationContext, userContext) {
    const analysis = await analyzeMessageSentiment(userMessage, conversationContext);
    
    // Use provided userContext to eliminate N+1 query
    const currentScore = userContext.sentimentScore ?? 0;
    const impactFactor = Math.abs(analysis.sentiment) > 0.8
        ? SENTIMENT_THRESHOLDS.HIGH_IMPACT
        : SENTIMENT_THRESHOLDS.LOW_IMPACT;
    let newScore = (currentScore * (1 - impactFactor)) + (analysis.sentiment * impactFactor);
    newScore = Math.max(-1, Math.min(1, newScore));

    const newLevel = scoreToAttitudeLevel(newScore);
    
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

    // Return both smoothed score and original for proper recording
    return { sentiment: newScore, originalSentiment: analysis.sentiment, reasoning: analysis.reasoning };
}

// ── MEMORY ──────────────────────────────────────────────────────────────────
async function storeConversationMemory(userId, channelId, userMessage, botResponse, sentimentScore, isContextOnly = false) {
    await pool.query(`
        INSERT INTO conversation_memories (user_id, channel_id, user_message, bot_response, sentiment_score, timestamp, is_context_only)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [userId, channelId, userMessage, botResponse, sentimentScore, Date.now(), isContextOnly]);

    // Deterministic cleanup: trigger when estimated row count is high
    // Uses pg_class reltuples for fast approximate count instead of COUNT(*)
    const { rows } = await pool.query(
        `SELECT reltuples::bigint AS count FROM pg_class WHERE relname = 'conversation_memories'`
    );
    if (rows[0]?.count > 1000) {
        await pool.query(`
            DELETE FROM conversation_memories WHERE id IN (
                SELECT id FROM conversation_memories ORDER BY timestamp ASC LIMIT 200
            )
        `);
        logger.info('Cleaned up old conversation memories', { deleted: 200, remaining: rows[0].count - 200 });
    }
}

/**
 * Returns chronological sentiment history for a user, oldest first.
 * Used by checkrelationship/stats to compute trend (improving / declining).
 * Excludes context-only rows so lurking doesn't skew the trendline.
 */
async function getSentimentHistory(userId, limit = 10) {
    const { rows } = await pool.query(
        `SELECT sentiment_score, timestamp FROM conversation_memories
         WHERE user_id = $1 AND is_context_only = false AND sentiment_score IS NOT NULL
         ORDER BY timestamp DESC LIMIT $2`,
        [userId, limit]
    );
    return rows.reverse().map(r => ({
        sentiment: parseFloat(r.sentiment_score),
        timestamp: Number(r.timestamp)
    }));
}

async function getRecentMemories(userId, limit = 5, options = {}) {
    const { excludeContext = false } = options;

    const query = excludeContext
        ? `SELECT user_message, bot_response FROM conversation_memories
           WHERE user_id = $1 AND is_context_only = false
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
    getSentimentHistory,
    scoreToAttitudeLevel,
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