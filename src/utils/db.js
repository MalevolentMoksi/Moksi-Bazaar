// ENHANCED DB.JS - AI-Powered Sentiment Analysis + Media Analysis (FIXED)

const { Pool, types } = require('pg');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

types.setTypeParser(types.builtins.INT8, v => parseInt(v, 10));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const LANGUAGE_API_KEY = process.env.LANGUAGE_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ── ENHANCED TABLE INITIALIZATION WITH MEDIA CACHE ───────────────────────────
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
      sentiment_score DECIMAL(4,2) DEFAULT 0.00,
      recent_interactions JSONB DEFAULT '[]'::jsonb,
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

  // Insert default media analysis setting if not exists
  await pool.query(`
    INSERT INTO settings (setting, state) 
    VALUES ('media_analysis_provider', true) 
    ON CONFLICT DO NOTHING
  `);
};

// ── MEDIA ANALYSIS SYSTEM (FIXED) ─────────────────────────────────────────────

// Generate unique identifier for media (based on URL/content)
function generateMediaId(url, contentHash = null) {
  const crypto = require('crypto');
  const content = contentHash || url;
  return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
}

// Check if media is already cached
async function getCachedMediaDescription(mediaId) {
  const { rows } = await pool.query(
    'SELECT description, media_type FROM media_cache WHERE media_id = $1',
    [mediaId]
  );

  if (rows.length > 0) {
    await pool.query(`
      UPDATE media_cache 
      SET accessed_count = accessed_count + 1, last_accessed = CURRENT_TIMESTAMP
      WHERE media_id = $1
    `, [mediaId]);

    return {
      description: rows[0].description,
      mediaType: rows[0].media_type,
      cached: true
    };
  }

  return null;
}

// Cache new media description
async function cacheMediaDescription(mediaId, description, mediaType, originalUrl = null) {
  await pool.query(`
    INSERT INTO media_cache (media_id, description, media_type, original_url)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (media_id) DO UPDATE SET
      description = EXCLUDED.description,
      accessed_count = media_cache.accessed_count + 1,
      last_accessed = CURRENT_TIMESTAMP
  `, [mediaId, description, mediaType, originalUrl]);
}

// FIXED: Analyze media with AI - handles videos properly
async function analyzeMediaWithAI(mediaUrl, mediaType, fileName = '') {
  const provider = await getMediaAnalysisProvider();

  if (provider === 'disabled') {
    console.log('[MEDIA] Analysis disabled by settings');
    return null;
  }

  console.log(`[MEDIA] Analyzing ${mediaType} with ${provider}: ${fileName}`);

  try {
    if (provider === 'gemini') {
      return await analyzeWithGemini(mediaUrl, mediaType, fileName);
    } else if (provider === 'groq') {
      return await analyzeWithGroq(mediaUrl, mediaType, fileName);
    }
  } catch (error) {
    console.error(`[MEDIA] Analysis failed with ${provider}:`, error.message);
    return null;
  }

  return null;
}

// FIXED: Analyze with Google Gemini - proper video support
async function analyzeWithGemini(mediaUrl, mediaType, fileName = '') {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  const isVideo = mediaType.includes('video') || fileName.match(/\.(mp4|mov|avi|webm|mkv)$/i);

  try {
    if (isVideo) {
      console.log('[MEDIA] Gemini: Attempting video analysis');

      // Try direct video upload to Gemini
      const videoResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                text: `Describe this video briefly in one sentence for conversation context. Focus on key visual elements, actions, people, objects, or scenes. Keep it concise and relevant.`
              },
              {
                // Try inline video data
                inlineData: {
                  mimeType: mediaType,
                  data: await getMediaAsBase64(mediaUrl)
                }
              }
            ]
          }]
        }),
      });

      if (videoResponse.ok) {
        const videoData = await videoResponse.json();
        const description = videoData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

        if (description) {
          console.log('[MEDIA] Gemini video analysis successful');
          return description;
        }
      } else {
        console.log('[MEDIA] Gemini video analysis failed, trying thumbnail fallback');
      }

      // Fallback: analyze thumbnail for videos
      return await analyzeVideoThumbnail(mediaUrl, 'gemini');

    } else {
      // Handle images normally
      console.log('[MEDIA] Gemini: Analyzing image');

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                text: `Describe this ${mediaType} briefly in one sentence for conversation context. Focus on key visual elements, people, objects, text, or actions. Keep it concise and relevant.`
              },
              {
                inlineData: {
                  mimeType: mediaType.includes('gif') ? 'image/gif' : 'image/jpeg',
                  data: await getMediaAsBase64(mediaUrl)
                }
              }
            ]
          }]
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[MEDIA] Gemini API error:', errorText);
        throw new Error(`Gemini API error: ${errorText}`);
      }

      const data = await response.json();
      const description = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

      if (!description) {
        throw new Error('No description returned from Gemini');
      }

      return description;
    }
  } catch (error) {
    console.error('[MEDIA] Gemini analysis error:', error.message);

    // For videos, try thumbnail fallback
    if (isVideo) {
      console.log('[MEDIA] Trying thumbnail fallback for video');
      return await analyzeVideoThumbnail(mediaUrl, 'gemini');
    }

    throw error;
  }
}

// FIXED: Analyze with Groq - correct model name
async function analyzeWithGroq(mediaUrl, mediaType, fileName = '') {
  if (!LANGUAGE_API_KEY) {
    throw new Error('LANGUAGE_API_KEY not configured');
  }

  const isVideo = mediaType.includes('video') || fileName.match(/\.(mp4|mov|avi|webm|mkv)$/i);

  if (isVideo) {
    console.log('[MEDIA] Groq does not support video analysis, using thumbnail fallback');
    return await analyzeVideoThumbnail(mediaUrl, 'groq');
  }

  console.log('[MEDIA] Groq: Analyzing image with correct model');

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LANGUAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct', // FIXED: Correct model
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Describe this ${mediaType} briefly in one sentence for conversation context. Focus on key visual elements, people, objects, text, or actions. Keep it concise and relevant.`
          },
          {
            type: 'image_url',
            image_url: {
              url: mediaUrl
            }
          }
        ]
      }],
      max_tokens: 100,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[MEDIA] Groq API error:', errorText);
    throw new Error(`Groq API error: ${errorText}`);
  }

  const data = await response.json();
  const description = data.choices?.[0]?.message?.content?.trim();

  if (!description) {
    throw new Error('No description returned from Groq');
  }

  return description;
}

// NEW: Video thumbnail fallback analysis
async function analyzeVideoThumbnail(videoUrl, provider) {
  try {
    console.log(`[MEDIA] Generating thumbnail for video analysis with ${provider}`);

    // For Discord CDN videos, try getting a thumbnail
    // Discord sometimes provides thumbnails automatically
    const thumbnailUrl = videoUrl.replace(/\.mp4$/, '_thumbnail.jpg');

    // Try to analyze thumbnail
    let description = null;

    try {
      if (provider === 'gemini') {
        description = await analyzeWithGemini(thumbnailUrl, 'image/jpeg', 'thumbnail');
      } else if (provider === 'groq') {
        description = await analyzeWithGroq(thumbnailUrl, 'image/jpeg', 'thumbnail');
      }
    } catch (thumbnailError) {
      console.log('[MEDIA] Thumbnail URL failed, using generic video description');
    }

    if (description) {
      return `Video thumbnail shows: ${description}`;
    } else {
      // Generic fallback for videos
      const videoName = videoUrl.split('/').pop().split('?')[0];
      return `Video file (${videoName}) - unable to analyze content, thumbnail not available`;
    }

  } catch (error) {
    console.error('[MEDIA] Video thumbnail fallback failed:', error.message);
    return 'Video content - unable to analyze';
  }
}

// Helper function to convert media URL to base64 
async function getMediaAsBase64(mediaUrl) {
  try {
    console.log(`[MEDIA] Converting to base64: ${mediaUrl.substring(0, 80)}...`);

    const response = await fetch(mediaUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch media: ${response.status}`);
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > 20 * 1024 * 1024) { // 20MB limit
      throw new Error(`Media too large: ${contentLength} bytes`);
    }

    const buffer = await response.buffer();
    console.log(`[MEDIA] Converted ${buffer.length} bytes to base64`);
    return buffer.toString('base64');
  } catch (error) {
    console.error('[MEDIA] Base64 conversion failed:', error.message);
    throw new Error(`Failed to convert media to base64: ${error.message}`);
  }
}

// Get media analysis provider setting
async function getMediaAnalysisProvider() {
  const { rows } = await pool.query(`
    SELECT setting FROM settings 
    WHERE setting IN ('media_provider_gemini', 'media_provider_groq', 'media_provider_disabled')
    AND state = true
  `);

  if (rows.length === 0) {
    return 'gemini'; // Default to Gemini
  }

  const activeSetting = rows[0].setting;
  if (activeSetting === 'media_provider_gemini') return 'gemini';
  if (activeSetting === 'media_provider_groq') return 'groq';
  if (activeSetting === 'media_provider_disabled') return 'disabled';

  return 'gemini'; // fallback
}

// Set media analysis provider
async function setMediaAnalysisProvider(provider) {
  await pool.query(`
    DELETE FROM settings 
    WHERE setting IN ('media_provider_gemini', 'media_provider_groq', 'media_provider_disabled')
  `);

  const settingName = `media_provider_${provider}`;
  await pool.query(`
    INSERT INTO settings (setting, state) VALUES ($1, true)
  `, [settingName]);
}

// ENHANCED: Process media from Discord message attachments/embeds
async function processMediaInMessage(message) {
  const mediaDescriptions = [];

  try {
    // Process attachments
    if (message.attachments && message.attachments.size > 0) {
      console.log(`[MEDIA] Processing ${message.attachments.size} attachments`);

      for (const [, attachment] of message.attachments) {
        console.log(`[MEDIA] Processing attachment: ${attachment.name} (${attachment.contentType})`);

        const mediaInfo = await processMediaItem(attachment.url, attachment.name, attachment.contentType);
        if (mediaInfo) {
          mediaDescriptions.push(`[${attachment.name}: ${mediaInfo.description}]`);
        }
      }
    }

    // Process embeds with images
    if (message.embeds && message.embeds.length > 0) {
      console.log(`[MEDIA] Processing ${message.embeds.length} embeds`);

      for (const embed of message.embeds) {
        if (embed.image?.url) {
          const mediaInfo = await processMediaItem(embed.image.url, 'embedded image', 'image');
          if (mediaInfo) {
            mediaDescriptions.push(`[embedded image: ${mediaInfo.description}]`);
          }
        }
        if (embed.thumbnail?.url) {
          const mediaInfo = await processMediaItem(embed.thumbnail.url, 'thumbnail', 'image');
          if (mediaInfo) {
            mediaDescriptions.push(`[thumbnail: ${mediaInfo.description}]`);
          }
        }
      }
    }

    // Process custom emojis in message content
    if (message.content) {
      const customEmojiRegex = /<a?:([^:]+):(\d+)>/g;
      let match;

      while ((match = customEmojiRegex.exec(message.content)) !== null) {
        const emojiName = match[1];
        const emojiId = match[2];
        const emojiUrl = `https://cdn.discordapp.com/emojis/${emojiId}.${match[0].startsWith('<a:') ? 'gif' : 'png'}`;

        console.log(`[MEDIA] Processing custom emoji: ${emojiName}`);
        const mediaInfo = await processMediaItem(emojiUrl, emojiName, 'emoji');
        if (mediaInfo) {
          mediaDescriptions.push(`[emoji ${emojiName}: ${mediaInfo.description}]`);
        }
      }
    }
  } catch (error) {
    console.error('[MEDIA] Error processing media in message:', error.message);
  }

  console.log(`[MEDIA] Processed message, found ${mediaDescriptions.length} media items`);
  return mediaDescriptions;
}

// ENHANCED: Process individual media item with better type detection
async function processMediaItem(url, fileName, contentType) {
  try {
    console.log(`[MEDIA] Processing item: ${fileName} (${contentType || 'unknown'})`);

    // Generate media ID
    const mediaId = generateMediaId(url);

    // Check cache first
    const cached = await getCachedMediaDescription(mediaId);
    if (cached) {
      console.log(`[MEDIA] Found cached description for ${fileName}`);
      return cached;
    }

    // Determine if we can analyze this media type
    const mediaTypeInfo = determineMediaType(contentType, fileName, url);
    if (!mediaTypeInfo.analyzable) {
      console.log(`[MEDIA] Media type not analyzable: ${fileName}`);
      return null;
    }

    // Analyze with AI
    console.log(`[MEDIA] Analyzing ${fileName} as ${mediaTypeInfo.type}`);
    const description = await analyzeMediaWithAI(url, mediaTypeInfo.type, fileName);

    if (!description) {
      console.log(`[MEDIA] No description returned for ${fileName}`);
      return null;
    }

    // Cache the result
    await cacheMediaDescription(mediaId, description, mediaTypeInfo.type, url);
    console.log(`[MEDIA] Cached analysis for ${fileName}: "${description}"`);

    return {
      description,
      mediaType: mediaTypeInfo.type,
      cached: false
    };

  } catch (error) {
    console.error(`[MEDIA] Failed to process media ${fileName}:`, error.message);
    return null;
  }
}

// NEW: Better media type determination
function determineMediaType(contentType, fileName, url) {
  // Check content type first
  if (contentType) {
    if (contentType.startsWith('image/')) {
      return { type: contentType, analyzable: true };
    }
    if (contentType.startsWith('video/')) {
      return { type: contentType, analyzable: true };
    }
  }

  // Fallback to file extension
  if (fileName) {
    const ext = fileName.toLowerCase().split('.').pop();

    // Images
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)) {
      return { type: `image/${ext === 'jpg' ? 'jpeg' : ext}`, analyzable: true };
    }

    // Videos  
    if (['mp4', 'mov', 'avi', 'webm', 'mkv'].includes(ext)) {
      return { type: `video/${ext}`, analyzable: true };
    }
  }

  // Check URL patterns (for Discord CDN)
  if (url && url.includes('cdn.discordapp.com/emojis/')) {
    return { type: 'emoji', analyzable: true };
  }

  return { type: 'unknown', analyzable: false };
}

// Clean old cache entries (optional maintenance function)
async function cleanupMediaCache() {
  const result = await pool.query(`
    DELETE FROM media_cache 
    WHERE created_at < NOW() - INTERVAL '30 days'
    AND last_accessed < NOW() - INTERVAL '7 days'
    AND accessed_count < 3
  `);

  console.log(`[MEDIA] Cleaned up ${result.rowCount} old cache entries`);
  return result.rowCount;
}

// ── AI-POWERED SENTIMENT ANALYSIS (unchanged) ────────────────────────────────
async function analyzeMessageSentiment(userMessage, conversationContext = '') {
  if (!userMessage || userMessage.trim().length === 0) {
    return { sentiment: 0, confidence: 0.5, reasoning: 'Empty message' };
  }

  const prompt = `Analyze the sentiment of this user message in context.

CONTEXT (previous messages):
${conversationContext}

USER MESSAGE TO ANALYZE: "${userMessage}"

Task: Determine if this message is positive, negative, or neutral toward the AI/bot.
Consider:
- Tone and word choice
- Sarcasm and implied meaning
- Context from previous messages
- Rudeness, hostility, or aggression
- Appreciation, kindness, or friendliness
- Questions show engagement (slightly positive)

Respond with JSON only:
{
  "sentiment": <number from -1.0 to 1.0>,
  "confidence": <number from 0.0 to 1.0>,
  "reasoning": "<brief explanation>"
}`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LANGUAGE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-3.2-3b-preview', // Keep this one for sentiment analysis
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 150,
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      console.error('Sentiment analysis API error:', await response.text());
      return simpleBackupSentiment(userMessage);
    }

    const data = await response.json();
    const rawResponse = data.choices?.[0]?.message?.content?.trim();

    try {
      const sentimentData = JSON.parse(rawResponse);

      if (typeof sentimentData.sentiment === 'number' && 
          sentimentData.sentiment >= -1 && sentimentData.sentiment <= 1) {
        return {
          sentiment: sentimentData.sentiment,
          confidence: sentimentData.confidence || 0.7,
          reasoning: sentimentData.reasoning || 'AI analysis'
        };
      } else {
        throw new Error('Invalid sentiment range');
      }
    } catch (parseError) {
      console.error('Error parsing sentiment response:', parseError, 'Raw:', rawResponse);
      return simpleBackupSentiment(userMessage);
    }
  } catch (error) {
    console.error('Sentiment analysis failed:', error);
    return simpleBackupSentiment(userMessage);
  }
}

// Backup simple sentiment analysis if AI fails
function simpleBackupSentiment(message) {
  const text = message.toLowerCase();
  let sentiment = 0;

  const strongNegative = ['fuck', 'shit', 'stupid', 'hate', 'terrible', 'awful', 'garbage', 'useless', 'pathetic'];
  const negative = ['bad', 'sucks', 'annoying', 'boring', 'whatever', 'dumb'];
  const positive = ['thanks', 'thank you', 'great', 'awesome', 'cool', 'nice', 'good', 'love', 'amazing'];
  const strongPositive = ['incredible', 'fantastic', 'perfect', 'brilliant', 'excellent'];

  strongNegative.forEach(word => {
    if (text.includes(word)) sentiment -= 0.4;
  });

  negative.forEach(word => {
    if (text.includes(word)) sentiment -= 0.2;
  });

  positive.forEach(word => {
    if (text.includes(word)) sentiment += 0.3;
  });

  strongPositive.forEach(word => {
    if (text.includes(word)) sentiment += 0.5;
  });

  if (text.includes('?')) sentiment += 0.1;

  sentiment = Math.max(-1, Math.min(1, sentiment));

  return {
    sentiment,
    confidence: 0.6,
    reasoning: 'Backup keyword analysis'
  };
}

// ── ALL OTHER EXISTING FUNCTIONS (unchanged) ─────────────────────────────────
async function getBalance(userId) {
  const { rows } = await pool.query('SELECT balance FROM balances WHERE user_id = $1', [userId]);
  if (rows.length) return rows[0].balance;

  const seed = 10000;
  await pool.query('INSERT INTO balances (user_id, balance) VALUES ($1, $2)', [userId, seed]);
  return seed;
}

async function updateBalance(userId, newBalance) {
  await pool.query(`INSERT INTO balances (user_id, balance) VALUES ($1, $2)
                    ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance`,
                   [userId, newBalance]);
}

async function getTopBalances(limit = 10) {
  const { rows } = await pool.query('SELECT user_id, balance FROM balances ORDER BY balance DESC LIMIT $1', [limit]);
  return rows;
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

async function getSettingState(key) {
  const { rows } = await pool.query('SELECT state FROM settings WHERE setting = $1', [key]);
  return rows.length > 0 ? rows[0].state : null;
}

async function getUserContext(userId) {
  const { rows } = await pool.query('SELECT * FROM user_preferences WHERE user_id = $1', [userId]);

  if (rows.length === 0) {
    return {
      isNewUser: true,
      attitudeLevel: 'neutral',
      interactionCount: 0,
      sentimentScore: 0,
      recentInteractions: []
    };
  }

  return {
    isNewUser: false,
    attitudeLevel: rows[0].attitude_level,
    interactionCount: rows[0].interaction_count,
    displayName: rows[0].display_name,
    lastSeen: rows[0].last_seen,
    sentimentScore: parseFloat(rows[0].sentiment_score) || 0,
    recentInteractions: rows[0].recent_interactions || []
  };
}

async function updateUserPreferences(userId, interaction) {
  const displayName = interaction?.member?.displayName || interaction?.user?.username || 'unknown';

  await pool.query(`
    INSERT INTO user_preferences (user_id, display_name, interaction_count)
    VALUES ($1, $2, 1)
    ON CONFLICT (user_id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      interaction_count = user_preferences.interaction_count + 1,
      last_seen = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `, [userId, displayName]);
}

async function updateUserAttitudeWithAI(userId, userMessage, conversationContext) {
  const sentimentAnalysis = await analyzeMessageSentiment(userMessage, conversationContext);
  const userContext = await getUserContext(userId);

  const recentInteractions = userContext.recentInteractions || [];
  recentInteractions.push({
    timestamp: Date.now(),
    sentiment: sentimentAnalysis.sentiment,
    confidence: sentimentAnalysis.confidence,
    message: userMessage.substring(0, 50) + (userMessage.length > 50 ? '...' : '')
  });

  if (recentInteractions.length > 10) {
    recentInteractions.splice(0, recentInteractions.length - 10);
  }

  const weights = recentInteractions.map((_, index) => Math.pow(1.2, index));
  const weightedSum = recentInteractions.reduce((sum, interaction, index) => 
    sum + (interaction.sentiment * weights[index]), 0);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const newSentimentScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

  let newAttitude = 'neutral';
  const count = userContext.interactionCount + 1;

  if (newSentimentScore <= -0.4) {
    newAttitude = 'hostile';
  } else if (newSentimentScore <= -0.2) {
    newAttitude = 'cautious'; 
  } else if (newSentimentScore >= 0.4 && count >= 50) {
    newAttitude = 'familiar';
  } else if (newSentimentScore >= 0.2 && count >= 10) {
    newAttitude = 'friendly';
  } else if (newSentimentScore >= 0.1) {
    newAttitude = 'neutral';
  }

  await pool.query(`
    UPDATE user_preferences 
    SET 
      attitude_level = $2, 
      sentiment_score = $3,
      recent_interactions = $4,
      updated_at = CURRENT_TIMESTAMP 
    WHERE user_id = $1
  `, [userId, newAttitude, newSentimentScore, JSON.stringify(recentInteractions)]);

  console.log(`User ${userId} sentiment: ${sentimentAnalysis.sentiment.toFixed(2)} -> avg: ${newSentimentScore.toFixed(2)} -> attitude: ${newAttitude}`);

  return {
    sentiment: sentimentAnalysis.sentiment,
    newAverage: newSentimentScore,
    newAttitude,
    reasoning: sentimentAnalysis.reasoning
  };
}

async function storeConversationMemory(userId, channelId, userMessage, botResponse, sentimentScore) {
  await pool.query(`
    INSERT INTO conversation_memories (user_id, channel_id, user_message, bot_response, sentiment_score, timestamp)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [userId, channelId, userMessage, botResponse, sentimentScore, Date.now()]);

  await pool.query(`
    DELETE FROM conversation_memories 
    WHERE user_id = $1 AND id NOT IN (
      SELECT id FROM conversation_memories 
      WHERE user_id = $1 
      ORDER BY timestamp DESC 
      LIMIT 20
    )
  `, [userId]);
}

async function getRecentMemories(userId, limit = 5) {
  const { rows } = await pool.query(`
    SELECT user_message, bot_response, sentiment_score, timestamp
    FROM conversation_memories
    WHERE user_id = $1
    ORDER BY timestamp DESC
    LIMIT $2
  `, [userId, limit]);

  return rows.reverse();
}

// ── EXPORTS ────────────────────────────────────────────────────────────────────
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
  analyzeMessageSentiment,
  storeConversationMemory,
  getRecentMemories,
  // Media analysis functions
  processMediaInMessage,
  getCachedMediaDescription,
  cacheMediaDescription,
  analyzeMediaWithAI,
  getMediaAnalysisProvider,
  setMediaAnalysisProvider,
  cleanupMediaCache
};