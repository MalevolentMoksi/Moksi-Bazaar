// ENHANCED DB.JS - AI-Powered Sentiment Analysis

const { Pool, types } = require('pg');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

types.setTypeParser(types.builtins.INT8, v => parseInt(v, 10));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const LANGUAGE_API_KEY = process.env.LANGUAGE_API_KEY;

// ── ENHANCED TABLE INITIALIZATION ─────────────────────────────────────────────
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
      sentiment_score DECIMAL(4,2) DEFAULT 0.00,  -- Running average sentiment
      recent_interactions JSONB DEFAULT '[]'::jsonb,  -- Last 10 interactions with sentiment
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversation_memories (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_message TEXT,
      bot_response TEXT,
      sentiment_score DECIMAL(4,2), -- AI-analyzed sentiment for this interaction
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
  `);
};

// ── AI-POWERED SENTIMENT ANALYSIS ─────────────────────────────────────────────
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
}

Examples:
- "fuck you bot" = {"sentiment": -0.9, "confidence": 0.95, "reasoning": "Direct insult"}
- "you're stupid" = {"sentiment": -0.8, "confidence": 0.9, "reasoning": "Direct negative judgment"}
- "whatever" = {"sentiment": -0.3, "confidence": 0.7, "reasoning": "Dismissive tone"}
- "hey" = {"sentiment": 0.0, "confidence": 0.8, "reasoning": "Neutral greeting"}
- "thanks" = {"sentiment": 0.6, "confidence": 0.8, "reasoning": "Expression of gratitude"}
- "that's awesome!" = {"sentiment": 0.8, "confidence": 0.9, "reasoning": "Enthusiastic positive"}`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LANGUAGE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-3.2-3b-preview',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 150,
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      console.error('Sentiment analysis API error:', await response.text());
      // Fallback to simple analysis
      return simpleBackupSentiment(userMessage);
    }

    const data = await response.json();
    const rawResponse = data.choices?.[0]?.message?.content?.trim();

    try {
      const sentimentData = JSON.parse(rawResponse);

      // Validate the response
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

  // Strong negative indicators
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

  // Questions show some engagement
  if (text.includes('?')) sentiment += 0.1;

  sentiment = Math.max(-1, Math.min(1, sentiment));

  return {
    sentiment,
    confidence: 0.6,
    reasoning: 'Backup keyword analysis'
  };
}

// ── BALANCE FUNCTIONS (unchanged) ─────────────────────────────────────────────
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

// ── BLACKLIST FUNCTIONS (unchanged) ───────────────────────────────────────────
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

// ── SETTINGS FUNCTIONS (unchanged) ────────────────────────────────────────────
async function getSettingState(key) {
  const { rows } = await pool.query('SELECT state FROM settings WHERE setting = $1', [key]);
  return rows.length > 0 ? rows[0].state : null;
}

// ── ENHANCED USER CONTEXT ─────────────────────────────────────────────────────
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

// ── ENHANCED USER PREFERENCE UPDATES ──────────────────────────────────────────
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

// ── ROBUST RELATIONSHIP TRACKING ──────────────────────────────────────────────
async function updateUserAttitudeWithAI(userId, userMessage, conversationContext) {
  // Get AI-powered sentiment analysis
  const sentimentAnalysis = await analyzeMessageSentiment(userMessage, conversationContext);

  // Get current user context
  const userContext = await getUserContext(userId);

  // Update recent interactions array (keep last 10)
  const recentInteractions = userContext.recentInteractions || [];
  recentInteractions.push({
    timestamp: Date.now(),
    sentiment: sentimentAnalysis.sentiment,
    confidence: sentimentAnalysis.confidence,
    message: userMessage.substring(0, 50) + (userMessage.length > 50 ? '...' : '')
  });

  // Keep only last 10 interactions
  if (recentInteractions.length > 10) {
    recentInteractions.splice(0, recentInteractions.length - 10);
  }

  // Calculate new running sentiment average (weighted toward recent interactions)
  const weights = recentInteractions.map((_, index) => Math.pow(1.2, index)); // More recent = higher weight
  const weightedSum = recentInteractions.reduce((sum, interaction, index) => 
    sum + (interaction.sentiment * weights[index]), 0);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const newSentimentScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

  // Determine attitude level based on sentiment score and interaction count
  let newAttitude = 'neutral';
  const count = userContext.interactionCount + 1; // +1 because we're about to increment

  if (newSentimentScore <= -0.4) {
    newAttitude = 'hostile';
  } else if (newSentimentScore <= -0.2) {
    newAttitude = 'cautious'; 
  } else if (newSentimentScore >= 0.4 && count >= 50) {
    newAttitude = 'familiar';
  } else if (newSentimentScore >= 0.2 && count >= 10) {
    newAttitude = 'friendly';
  } else if (newSentimentScore >= 0.1) {
    newAttitude = 'neutral'; // Slightly positive but not enough for friendly
  }
  // else stays neutral

  // Update database
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

// ── ENHANCED MEMORY SYSTEM ────────────────────────────────────────────────────
async function storeConversationMemory(userId, channelId, userMessage, botResponse, sentimentScore) {
  await pool.query(`
    INSERT INTO conversation_memories (user_id, channel_id, user_message, bot_response, sentiment_score, timestamp)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [userId, channelId, userMessage, botResponse, sentimentScore, Date.now()]);

  // Clean up old memories (keep last 20 per user)
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

  return rows.reverse(); // Return chronological order
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
  updateUserAttitudeWithAI,  // NEW: AI-powered sentiment analysis
  analyzeMessageSentiment,   // Export for testing
  storeConversationMemory,
  getRecentMemories
};