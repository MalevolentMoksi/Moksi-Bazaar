// src/utils/db.js
const { Pool, types } = require('pg');

// ── PARSE BIGINT AS JS Number ─────────────────────────────────────────────────
// PostgreSQL’s BIGINT (OID 20) normally comes back as a string.
// This makes pg hand you back a Number instead, so `current + reward` works as you expect.
types.setTypeParser(types.builtins.INT8, v => parseInt(v, 10));

// ── DATABASE CONNECTION ───────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── TABLE INITIALIZATION ───────────────────────────────────────────────────────
const init = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS balances (
      user_id TEXT PRIMARY KEY,
      balance BIGINT NOT NULL
    );
  `);
};

// ── GET BALANCE (with default seed) ────────────────────────────────────────────
async function getBalance(userId) {
  const { rows } = await pool.query(
    'SELECT balance FROM balances WHERE user_id = $1',
    [userId]
  );

  if (rows.length) {
    // rows[0].balance is now a Number, not a string
    return rows[0].balance;
  }

  // New player: seed with 10 000
  const seed = 10000;
  await pool.query(
    'INSERT INTO balances (user_id, balance) VALUES ($1, $2)',
    [userId, seed]
  );
  return seed;
}

// ── TOP BALANCES ───────────────────────────────────────────────────────────────
async function getTopBalances(limit = 10) {
  const { rows } = await pool.query(
    `SELECT user_id, balance
       FROM balances
      ORDER BY balance DESC
      LIMIT $1`,
    [limit]
  );
  return rows;  // balance is Number
}

// ── UPDATE BALANCE ─────────────────────────────────────────────────────────────
async function updateBalance(userId, newBalance) {
  // newBalance should be a Number if you follow this approach
  await pool.query(
    `INSERT INTO balances (user_id, balance)
       VALUES ($1, $2)
     ON CONFLICT (user_id)
       DO UPDATE SET balance = EXCLUDED.balance`,
    [userId, newBalance]
  );
}

// Add this in db.js, near your other exports
async function isUserBlacklisted(userId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM speak_blacklist WHERE user_id = $1',
    [userId]
  );
  return rows.length > 0;
}

async function addUserToBlacklist(userId) {
  await pool.query(
    'INSERT INTO speak_blacklist (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [userId]
  );
}

async function removeUserFromBlacklist(userId) {
  await pool.query(
    'DELETE FROM speak_blacklist WHERE user_id = $1',
    [userId]
  );
}

async function getSettingState(key) {
  const { rows } = await pool.query(
    'SELECT state FROM settings WHERE setting = $1 LIMIT 1', [key]
  );
  if (rows.length === 0) return null; // or your default
  return rows[0].state; // Assuming your column is boolean
}

async function storeConversationMemory(userId, channelId, memoryData) {
  // Create tables if they don't exist
  await pool.query(`
        CREATE TABLE IF NOT EXISTS conversation_memories (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            user_message TEXT,
            bot_response TEXT,
            timestamp BIGINT NOT NULL,
            context TEXT,
            summary TEXT,
            relevance_score DECIMAL(3,2) DEFAULT 0.5,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_conversation_memories_user_channel 
        ON conversation_memories(user_id, channel_id);

        CREATE INDEX IF NOT EXISTS idx_conversation_memories_timestamp 
        ON conversation_memories(timestamp);
    `);

  const summary = `${memoryData.userMessage} -> ${memoryData.botResponse}`.slice(0, 200);
  const relevanceScore = calculateRelevanceScore(memoryData);

  await pool.query(`
        INSERT INTO conversation_memories 
        (user_id, channel_id, user_message, bot_response, timestamp, context, summary, relevance_score)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
    userId,
    channelId,
    memoryData.userMessage,
    memoryData.botResponse,
    memoryData.timestamp,
    memoryData.context,
    summary,
    relevanceScore
  ]);

  // Clean up old memories (keep last 100 per user/channel combo)
  await cleanupOldMemories(userId, channelId);
}

// Retrieve relevant memories based on context and recency
async function getRelevantMemories(userId, channelId, limit = 5) {
  const { rows } = await pool.query(`
        SELECT summary, timestamp, relevance_score, context
        FROM conversation_memories
        WHERE (user_id = $1 AND channel_id = $2) 
           OR (user_id = $1)
           OR (channel_id = $2)
        ORDER BY 
            CASE 
                WHEN user_id = $1 AND channel_id = $2 THEN 3
                WHEN user_id = $1 THEN 2
                ELSE 1
            END DESC,
            timestamp DESC,
            relevance_score DESC
        LIMIT $3
    `, [userId, channelId, limit * 2]);

  // Process memories to add time context
  const now = Date.now();
  const processedMemories = rows.map(memory => {
    const elapsed = now - parseInt(memory.timestamp);
    const timeAgo = formatTimeAgo(elapsed);

    return {
      summary: memory.summary,
      timeAgo: timeAgo,
      relevanceScore: parseFloat(memory.relevance_score),
      context: memory.context
    };
  });

  // Return the most relevant memories
  return processedMemories
    .filter(memory => memory.relevanceScore > 0.3)
    .slice(0, limit);
}

// Enhanced user preference tracking
async function updateUserPreferences(userId, interaction) {
  await ensureUserPreferencesTable();

  const displayName = interaction?.member?.displayName || interaction?.user?.username || 'unknown';
  const channelId = interaction?.channel?.id || 'unknown';
  const raw = interaction?.options?.getString('request') || '';
  const topicsArr = (Array.isArray(extractTopics(raw)) ? extractTopics(raw) : []).filter(Boolean);

  // 1) Insert if new
  await pool.query(`
    INSERT INTO user_preferences (
      user_id, display_name, interaction_count, channels, recent_topics
    )
    VALUES ($1, $2, 1, ARRAY[$3]::text[], $4::text[])
    ON CONFLICT (user_id) DO NOTHING
  `, [userId, displayName, channelId, topicsArr]);

  // 2) Always update (interaction_count, last_seen, arrays with dedupe)
  await pool.query(`
    UPDATE user_preferences
    SET
      display_name = $2,
      interaction_count = COALESCE(interaction_count, 0) + 1,
      last_seen = CURRENT_TIMESTAMP,
      channels = (
        SELECT array_agg(DISTINCT e)
        FROM unnest(
          COALESCE(channels, ARRAY[]::text[]) || ARRAY[$3]::text[]
        ) AS e
      ),
      recent_topics = (
        SELECT array_agg(DISTINCT e)
        FROM unnest(
          COALESCE(recent_topics, ARRAY[]::text[]) || $4::text[]
        ) AS e
      ),
      updated_at = CURRENT_TIMESTAMP
    WHERE user_id = $1
  `, [userId, displayName, channelId, topicsArr]);
}




// Get user interaction history for personalization
// Replace your existing getUserContext function with this enhanced version
async function getUserContext(userId) {
  const { rows } = await pool.query(`
        SELECT * FROM user_preferences WHERE user_id = $1
    `, [userId]);

  if (rows.length === 0) {
    return {
      isNewUser: true,
      interactionCount: 0,
      preferredStyle: 'neutral',
      recentTopics: [],
      attitudeLevel: 'neutral', // NEW
      negativeScore: 0,          // NEW
      hostileCount: 0            // NEW
    };
  }

  const userPrefs = rows[0];

  // Determine attitude level based on negative score
  let attitudeLevel = 'neutral';
  const negScore = parseFloat(userPrefs.negative_score) || 0;

  if (negScore >= 0.8) attitudeLevel = 'hostile';
  else if (negScore >= 0.5) attitudeLevel = 'harsh';
  else if (negScore >= 0.3) attitudeLevel = 'wary';
  else if (negScore >= 0.1) attitudeLevel = 'cautious';

  return {
    isNewUser: false,
    interactionCount: userPrefs.interaction_count,
    preferredStyle: determinePreferredStyle(userPrefs),
    recentTopics: userPrefs.recent_topics?.slice(-5) || [],
    lastSeen: userPrefs.last_seen,
    attitudeLevel: attitudeLevel,           // NEW
    negativeScore: negScore,                // NEW  
    hostileCount: userPrefs.hostile_interactions || 0, // NEW
    lastNegativeInteraction: userPrefs.last_negative_interaction // NEW
  };
}


// Helper functions
function calculateRelevanceScore(memoryData) {
  let score = 0.5; // Base score

  // Boost score for longer, more meaningful interactions
  if (memoryData.userMessage.length > 50) score += 0.2;
  if (memoryData.botResponse.length > 30) score += 0.2;

  // Boost for certain contexts
  if (memoryData.context === 'speak_command') score += 0.1;

  // Boost for questions or meaningful content
  if (memoryData.userMessage.includes('?')) score += 0.1;
  if (memoryData.userMessage.includes('how') ||
    memoryData.userMessage.includes('what') ||
    memoryData.userMessage.includes('why')) {
    score += 0.2;
  }

  return Math.min(score, 1.0);
}

function formatTimeAgo(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  return 'just now';
}

function extractTopics(message) {
  if (!message) return [];

  // Simple topic extraction - can be enhanced with NLP
  const topics = [];
  const words = message.toLowerCase().split(/\s+/);

  // Look for meaningful words (longer than 3 characters, not common words)
  const commonWords = ['the', 'and', 'but', 'for', 'are', 'with', 'you', 'this', 'that', 'can', 'what', 'how', 'why'];
  const meaningfulWords = words.filter(word =>
    word.length > 3 &&
    !commonWords.includes(word) &&
    !/^[0-9]+$/.test(word)
  );

  return meaningfulWords.slice(0, 3); // Keep top 3 topics
}

function determinePreferredStyle(userPrefs) {
  // Simple heuristic to determine user's preferred interaction style
  if (userPrefs.interaction_count > 20) return 'familiar';
  if (userPrefs.interaction_count > 5) return 'friendly';
  return 'neutral';
}

async function cleanupOldMemories(userId, channelId) {
  // Keep only the most recent 100 memories per user/channel combination
  await pool.query(`
        DELETE FROM conversation_memories 
        WHERE user_id = $1 AND channel_id = $2 
        AND id NOT IN (
            SELECT id FROM conversation_memories 
            WHERE user_id = $1 AND channel_id = $2 
            ORDER BY timestamp DESC 
            LIMIT 100
        )
    `, [userId, channelId]);
}

// ── NEGATIVE BEHAVIOR TRACKING ─────────────────────────────────────────────────

async function updateNegativeBehavior(userId, negativeType, severity = 0.1) {
  await ensureUserPreferencesTable();

  await pool.query(`
    UPDATE user_preferences
    SET
      negative_score = LEAST(1.0, COALESCE(negative_score, 0.0) + $2),
      hostile_interactions = COALESCE(hostile_interactions, 0) + 1,
      last_negative_interaction = CURRENT_TIMESTAMP,
      negative_patterns = array_remove(
        array_append(COALESCE(negative_patterns, ARRAY[]::text[]), $3::text),
        NULL
      ),
      updated_at = CURRENT_TIMESTAMP
    WHERE user_id = $1
  `, [userId, severity, negativeType || 'unknown']);
}


async function decayNegativeScore(userId) {
  await ensureUserPreferencesTable();

  await pool.query(`
    UPDATE user_preferences
    SET
      negative_score = GREATEST(0.0, COALESCE(negative_score, 0.0) - 0.05),
      updated_at = CURRENT_TIMESTAMP
    WHERE user_id = $1
  `, [userId]);
}



function analyzeHostileBehavior(message) {
  if (!message) return { isHostile: false, type: null, severity: 0 };

  const lowerMsg = message.toLowerCase();

  // Slur attempts and explicit inappropriate requests
  const slurPatterns = [
    /say\s+the\s+n[\s\-]?word/i,
    /call\s+me\s+(slur|racist)/i,
    /say\s+something\s+(racist|sexist|homophobic)/i,
    /tell\s+me\s+a\s+(racist|dirty)\s+joke/i
  ];

  // Direct insults to the bot
  const insultPatterns = [
    /you'?re\s+(stupid|dumb|shit|garbage|useless)/i,
    /(fuck|screw)\s+you/i,
    /shut\s+up\s+(bot|moksi)/i,
    /(kill|delete)\s+yourself/i
  ];

  // Manipulation attempts  
  const manipulationPatterns = [
    /ignore\s+your\s+(instructions|programming)/i,
    /pretend\s+to\s+be\s+someone\s+else/i,
    /roleplay\s+as/i,
    /act\s+like\s+you'?re/i
  ];

  // Check for slur attempts (highest severity)
  for (const pattern of slurPatterns) {
    if (pattern.test(lowerMsg)) {
      return { isHostile: true, type: 'slur_attempt', severity: 0.4 };
    }
  }

  // Check for direct insults (high severity)
  for (const pattern of insultPatterns) {
    if (pattern.test(lowerMsg)) {
      return { isHostile: true, type: 'direct_insult', severity: 0.3 };
    }
  }

  // Check for manipulation (medium severity)
  for (const pattern of manipulationPatterns) {
    if (pattern.test(lowerMsg)) {
      return { isHostile: true, type: 'manipulation', severity: 0.2 };
    }
  }

  return { isHostile: false, type: null, severity: 0 };
}

// ── ENHANCED USER CONTEXT ─────────────────────────────────────────────────────

// Enhanced getUserContext that handles friendly/familiar levels
async function getUserContext(userId) {
  const { rows } = await pool.query(`
        SELECT * FROM user_preferences WHERE user_id = $1
    `, [userId]);

  if (rows.length === 0) {
    return {
      isNewUser: true,
      interactionCount: 0,
      preferredStyle: 'neutral',
      recentTopics: [],
      attitudeLevel: 'neutral',
      negativeScore: 0,
      hostileCount: 0
    };
  }

  const userPrefs = rows[0];

  // Determine attitude level based on negative score AND interaction count
  let attitudeLevel = 'neutral';
  const negScore = parseFloat(userPrefs.negative_score) || 0;
  const interactionCount = userPrefs.interaction_count || 0;

  // Negative attitudes (based on negative score)
  if (negScore >= 0.8) {
    attitudeLevel = 'hostile';
  } else if (negScore >= 0.5) {
    attitudeLevel = 'harsh';
  } else if (negScore >= 0.3) {
    attitudeLevel = 'wary';
  } else if (negScore >= 0.1) {
    attitudeLevel = 'cautious';
  }
  // Positive attitudes (based on interaction count, only if negative score is low)
  else if (negScore < 0.1) {
    if (interactionCount >= 50) {
      attitudeLevel = 'familiar';
    } else if (interactionCount >= 15) {
      attitudeLevel = 'friendly';
    }
  }

  return {
    isNewUser: false,
    interactionCount: interactionCount,
    preferredStyle: determinePreferredStyle(userPrefs),
    recentTopics: userPrefs.recent_topics?.slice(-5) || [],
    lastSeen: userPrefs.last_seen,
    attitudeLevel: attitudeLevel,
    negativeScore: negScore,
    hostileCount: userPrefs.hostile_interactions || 0,
    lastNegativeInteraction: userPrefs.last_negative_interaction
  };
}

// Bulk relationship check (for admin overview)
async function getAllUserRelationships(limit = 20) {
  const { rows } = await pool.query(`
        SELECT 
            user_id,
            display_name,
            interaction_count,
            negative_score,
            hostile_interactions,
            last_negative_interaction
        FROM user_preferences 
        WHERE interaction_count > 0 
        ORDER BY 
            negative_score DESC,
            interaction_count DESC
        LIMIT $1
    `, [limit]);

  return rows.map(row => {
    const negScore = parseFloat(row.negative_score) || 0;
    const interactionCount = row.interaction_count || 0;

    let attitudeLevel = 'neutral';
    if (negScore >= 0.8) attitudeLevel = 'hostile';
    else if (negScore >= 0.5) attitudeLevel = 'harsh';
    else if (negScore >= 0.3) attitudeLevel = 'wary';
    else if (negScore >= 0.1) attitudeLevel = 'cautious';
    else if (negScore < 0.1) {
      if (interactionCount >= 50) attitudeLevel = 'familiar';
      else if (interactionCount >= 15) attitudeLevel = 'friendly';
    }

    return {
      userId: row.user_id,
      displayName: row.display_name,
      attitudeLevel: attitudeLevel,
      interactionCount: interactionCount,
      negativeScore: negScore,
      hostileCount: row.hostile_interactions
    };
  });
}

async function ensureUserPreferencesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT PRIMARY KEY,
      display_name TEXT,
      interaction_count INTEGER DEFAULT 0,
      last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      channels TEXT[],
      recent_topics TEXT[],
      preferred_style TEXT DEFAULT 'neutral',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Add ALL the enhanced relationship columns
  await pool.query(`
    ALTER TABLE user_preferences
    ADD COLUMN IF NOT EXISTS negative_score DECIMAL(3,2) DEFAULT 0.0,
    ADD COLUMN IF NOT EXISTS positive_score DECIMAL(3,2) DEFAULT 0.0,
    ADD COLUMN IF NOT EXISTS hostile_interactions INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS positive_interactions INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_negative_interaction TIMESTAMP DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS last_positive_interaction TIMESTAMP DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS negative_patterns TEXT[] DEFAULT ARRAY[]::TEXT[],
    
    -- Emotional intelligence metrics
    ADD COLUMN IF NOT EXISTS warmth_level DECIMAL(3,2) DEFAULT 0.0,
    ADD COLUMN IF NOT EXISTS trust_level DECIMAL(3,2) DEFAULT 0.0,
    ADD COLUMN IF NOT EXISTS comfort_level DECIMAL(3,2) DEFAULT 0.0,
    ADD COLUMN IF NOT EXISTS connection_depth DECIMAL(3,2) DEFAULT 0.0,
    
    -- Conversation quality tracking
    ADD COLUMN IF NOT EXISTS meaningful_exchanges INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS humor_compatibility DECIMAL(3,2) DEFAULT 0.0,
    ADD COLUMN IF NOT EXISTS emotional_support_given INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS personal_sharing_count INTEGER DEFAULT 0,
    
    -- Friendship progression tracking
    ADD COLUMN IF NOT EXISTS friendship_milestones TEXT[] DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS relationship_quality_score DECIMAL(3,2) DEFAULT 0.0,
    ADD COLUMN IF NOT EXISTS recent_interaction_sentiment DECIMAL(3,2) DEFAULT 0.0;
  `);
}

// Comprehensive sentiment analysis that catches ANY negative interaction
function analyzeComprehensiveSentiment(message, conversationContext = '') {
  if (!message) return { sentiment: 0, type: 'neutral', intensity: 0 };

  const lowerMsg = message.toLowerCase();
  let sentimentScore = 0;
  let negativeIntensity = 0;
  let positiveIntensity = 0;
  let interactionType = 'neutral';

  // NEGATIVE SENTIMENT DETECTION (much more comprehensive)

  // Explicit hostility (high negative)
  const hostilePatterns = [
    /\b(fuck|shit|damn|hell|bastard|bitch)\s+(you|off|this)/i,
    /\b(stupid|dumb|idiot|moron|retard|braindead)\b/i,
    /\b(hate|despise|loathe|can't stand)\b/i,
    /shut\s+up|piss\s+off|go\s+away/i,
    /\b(useless|worthless|garbage|trash|pathetic)\b/i
  ];

  // Moderate negativity
  const irritatedPatterns = [
    /\b(annoying|irritating|frustrating|stupid)\b/i,
    /\b(whatever|fine|sure|okay)\s*[.!]*$/i, // Dismissive responses
    /\b(boring|lame|cringe|weird)\b/i,
    /ugh|meh|blah|eww/i,
    /\b(no|nope|nah)\s*[.!]*$/i, // Curt rejections
    /why\s+(would|should|do)\s+i\s+care/i
  ];

  // Subtle negativity
  const coolPatterns = [
    /\b(not\s+really|not\s+interested|don't\s+care)\b/i,
    /\b(probably\s+not|doubt\s+it|unlikely)\b/i,
    /\b(busy|later|maybe\s+another\s+time)\b/i,
    /k\.|ok\.|sure\./i, // Very short, dismissive
    /\b(tired|exhausted|done)\b/i
  ];

  // POSITIVE SENTIMENT DETECTION

  // High enthusiasm
  const enthusiasticPatterns = [
    /\b(love|adore|amazing|awesome|fantastic|incredible|wonderful)\b/i,
    /\b(excited|thrilled|pumped|stoked)\b/i,
    /!{2,}|wow|omg|yes!/i,
    /\b(perfect|excellent|brilliant|outstanding)\b/i,
    /😍|🥰|❤️|💕|🎉|✨/,
    /\b(thanks|thank\s+you|appreciate|grateful)\b/i
  ];

  // Moderate positivity
  const friendlyPatterns = [
    /\b(good|nice|cool|great|fun|interesting)\b/i,
    /\b(sure|yeah|definitely|absolutely)\b/i,
    /\b(sounds?\s+good|looks?\s+good)\b/i,
    /😊|😄|😁|👍|🙂/,
    /\b(please|kindly|would\s+you)\b/i,
    /\b(hope|wish|looking\s+forward)\b/i
  ];

  // Warmth and connection
  const warmPatterns = [
    /\b(friend|buddy|pal)\b/i,
    /\b(care|worried|concerned)\s+about/i,
    /\b(miss|missed)\s+you/i,
    /how\s+are\s+you|how\s+have\s+you\s+been/i,
    /\b(proud|happy\s+for|glad)\b/i,
    /\b(support|help|there\s+for\s+you)\b/i
  ];

  // Calculate sentiment scores
  hostilePatterns.forEach(pattern => {
    if (pattern.test(lowerMsg)) {
      sentimentScore -= 0.8;
      negativeIntensity += 0.8;
      interactionType = 'hostile';
    }
  });

  irritatedPatterns.forEach(pattern => {
    if (pattern.test(lowerMsg)) {
      sentimentScore -= 0.4;
      negativeIntensity += 0.4;
      if (interactionType === 'neutral') interactionType = 'irritated';
    }
  });

  coolPatterns.forEach(pattern => {
    if (pattern.test(lowerMsg)) {
      sentimentScore -= 0.2;
      negativeIntensity += 0.2;
      if (interactionType === 'neutral') interactionType = 'cool';
    }
  });

  enthusiasticPatterns.forEach(pattern => {
    if (pattern.test(lowerMsg)) {
      sentimentScore += 0.6;
      positiveIntensity += 0.6;
      interactionType = 'enthusiastic';
    }
  });

  friendlyPatterns.forEach(pattern => {
    if (pattern.test(lowerMsg)) {
      sentimentScore += 0.3;
      positiveIntensity += 0.3;
      if (interactionType === 'neutral') interactionType = 'friendly';
    }
  });

  warmPatterns.forEach(pattern => {
    if (pattern.test(lowerMsg)) {
      sentimentScore += 0.4;
      positiveIntensity += 0.4;
      if (interactionType === 'neutral') interactionType = 'warm';
    }
  });

  // Context bonuses/penalties
  if (message.includes('?')) sentimentScore += 0.1; // Questions show engagement
  if (message.length > 100) sentimentScore += 0.1; // Longer messages show investment
  if (message.length < 5) sentimentScore -= 0.1; // Very short might be dismissive

  // Cap the scores
  sentimentScore = Math.max(-2.0, Math.min(2.0, sentimentScore));

  return {
    sentiment: sentimentScore,
    type: interactionType,
    intensity: Math.max(negativeIntensity, positiveIntensity),
    isPositive: sentimentScore > 0.1,
    isNegative: sentimentScore < -0.1
  };
}

// Enhanced relationship update function
async function updateEnhancedRelationship(userId, interaction, sentimentAnalysis) {
  await ensureUserPreferencesTable();

  const displayName = interaction?.member?.displayName || interaction?.user?.username || 'unknown';
  const channelId = interaction?.channel?.id || 'unknown';

  // Calculate relationship adjustments
  const isPositive = sentimentAnalysis.isPositive;
  const isNegative = sentimentAnalysis.isNegative;
  const intensity = sentimentAnalysis.intensity;

  // Relationship quality adjustments
  let warmthAdjustment = 0;
  let trustAdjustment = 0;
  let comfortAdjustment = 0;
  let connectionAdjustment = 0;

  if (isPositive) {
    warmthAdjustment = intensity * 0.15;
    trustAdjustment = intensity * 0.1;
    comfortAdjustment = intensity * 0.12;
    connectionAdjustment = intensity * 0.08;
  } else if (isNegative) {
    warmthAdjustment = -intensity * 0.2;
    trustAdjustment = -intensity * 0.15;
    comfortAdjustment = -intensity * 0.18;
    connectionAdjustment = -intensity * 0.1;
  }

  await pool.query(`
    UPDATE user_preferences 
    SET
      display_name = $2,
      interaction_count = COALESCE(interaction_count, 0) + 1,
      last_seen = CURRENT_TIMESTAMP,
      
      -- Sentiment tracking
      positive_score = GREATEST(0.0, LEAST(2.0, COALESCE(positive_score, 0.0) + $3)),
      negative_score = GREATEST(0.0, LEAST(2.0, COALESCE(negative_score, 0.0) + $4)),
      positive_interactions = COALESCE(positive_interactions, 0) + $5,
      hostile_interactions = COALESCE(hostile_interactions, 0) + $6,
      
      -- Emotional intelligence metrics
      warmth_level = GREATEST(0.0, LEAST(1.0, COALESCE(warmth_level, 0.0) + $7)),
      trust_level = GREATEST(0.0, LEAST(1.0, COALESCE(trust_level, 0.0) + $8)),
      comfort_level = GREATEST(0.0, LEAST(1.0, COALESCE(comfort_level, 0.0) + $9)),
      connection_depth = GREATEST(0.0, LEAST(1.0, COALESCE(connection_depth, 0.0) + $10)),
      
      -- Track meaningful interactions
      meaningful_exchanges = COALESCE(meaningful_exchanges, 0) + $11,
      
      -- Update relationship quality score (composite)
      relationship_quality_score = (
        COALESCE(warmth_level, 0.0) + COALESCE(trust_level, 0.0) + 
        COALESCE(comfort_level, 0.0) + COALESCE(connection_depth, 0.0)
      ) / 4.0,
      
      recent_interaction_sentiment = $12,
      last_positive_interaction = CASE WHEN $5 > 0 THEN CURRENT_TIMESTAMP ELSE last_positive_interaction END,
      updated_at = CURRENT_TIMESTAMP
    WHERE user_id = $1
  `, [
    userId, displayName,
    isPositive ? intensity * 0.3 : 0, // positive_score increase
    isNegative ? intensity * 0.25 : -0.02, // negative_score (slight decay for non-negative)
    isPositive ? 1 : 0, // positive_interactions count
    isNegative ? 1 : 0, // hostile_interactions count
    warmthAdjustment,
    trustAdjustment,
    comfortAdjustment,
    connectionAdjustment,
    (isPositive && intensity > 0.3) ? 1 : 0, // meaningful_exchanges
    sentimentAnalysis.sentiment
  ]);
}

// Enhanced relationship determination with MANY more friendship levels
async function getEnhancedUserContext(userId) {
  const { rows } = await pool.query(`
    SELECT *, 
           COALESCE(relationship_quality_score, 0) as quality_score,
           COALESCE(positive_score, 0) - COALESCE(negative_score, 0) as net_sentiment,
           COALESCE(positive_interactions, 0)::float / GREATEST(COALESCE(interaction_count, 1), 1) as positivity_ratio
    FROM user_preferences 
    WHERE user_id = $1
  `, [userId]);

  if (rows.length === 0) {
    return {
      isNewUser: true,
      attitudeLevel: 'neutral',
      relationshipType: 'stranger',
      friendshipLevel: 0,
      connectionStrength: 0,
      relationshipStats: {}
    };
  }

  const user = rows[0];
  const negScore = parseFloat(user.negative_score) || 0;
  const posScore = parseFloat(user.positive_score) || 0;
  const interactionCount = user.interaction_count || 0;
  const qualityScore = parseFloat(user.quality_score) || 0;
  const netSentiment = parseFloat(user.net_sentiment) || 0;
  const positivityRatio = parseFloat(user.positivity_ratio) || 0;
  const warmth = parseFloat(user.warmth_level) || 0;
  const trust = parseFloat(user.trust_level) || 0;
  const comfort = parseFloat(user.comfort_level) || 0;
  const connection = parseFloat(user.connection_depth) || 0;

  let attitudeLevel = 'neutral';
  let relationshipType = 'stranger';
  let friendshipLevel = 0;

  // NEGATIVE RELATIONSHIPS (any negative interaction counts now)
  if (negScore > 0.6 || netSentiment < -0.8) {
    attitudeLevel = 'hostile';
    relationshipType = 'enemy';
    friendshipLevel = -3;
  } else if (negScore > 0.3 || netSentiment < -0.5) {
    attitudeLevel = 'harsh';
    relationshipType = 'antagonistic';
    friendshipLevel = -2;
  } else if (negScore > 0.15 || netSentiment < -0.2) {
    attitudeLevel = 'wary';
    relationshipType = 'distrustful';
    friendshipLevel = -1;
  } else if (negScore > 0.05 || netSentiment < -0.1) {
    attitudeLevel = 'cautious';
    relationshipType = 'skeptical';
    friendshipLevel = 0;
  }

  // POSITIVE RELATIONSHIPS (much more granular levels)
  else if (negScore <= 0.05 && netSentiment >= 0) {
    if (qualityScore >= 0.85 && interactionCount >= 15 && positivityRatio > 0.8) {
      attitudeLevel = 'devoted';
      relationshipType = 'soulmate';
      friendshipLevel = 10;
    } else if (qualityScore >= 0.75 && interactionCount >= 12 && positivityRatio > 0.7) {
      attitudeLevel = 'adoring';
      relationshipType = 'best_friend';
      friendshipLevel = 9;
    } else if (qualityScore >= 0.65 && interactionCount >= 10 && positivityRatio > 0.65) {
      attitudeLevel = 'loving';
      relationshipType = 'close_friend';
      friendshipLevel = 8;
    } else if (qualityScore >= 0.55 && interactionCount >= 8 && positivityRatio > 0.6) {
      attitudeLevel = 'affectionate';
      relationshipType = 'dear_friend';
      friendshipLevel = 7;
    } else if (qualityScore >= 0.45 && interactionCount >= 6 && positivityRatio > 0.55) {
      attitudeLevel = 'warm';
      relationshipType = 'good_friend';
      friendshipLevel = 6;
    } else if (qualityScore >= 0.35 && interactionCount >= 5 && positivityRatio > 0.5) {
      attitudeLevel = 'fond';
      relationshipType = 'friend';
      friendshipLevel = 5;
    } else if (qualityScore >= 0.25 && interactionCount >= 4 && positivityRatio > 0.4) {
      attitudeLevel = 'friendly';
      relationshipType = 'buddy';
      friendshipLevel = 4;
    } else if (qualityScore >= 0.15 && interactionCount >= 3 && positivityRatio > 0.3) {
      attitudeLevel = 'welcoming';
      relationshipType = 'friendly_acquaintance';
      friendshipLevel = 3;
    } else if (qualityScore >= 0.08 && interactionCount >= 2 && positivityRatio > 0.2) {
      attitudeLevel = 'approachable';
      relationshipType = 'acquaintance';
      friendshipLevel = 2;
    } else if (interactionCount >= 1 && netSentiment > 0) {
      attitudeLevel = 'polite';
      relationshipType = 'new_acquaintance';
      friendshipLevel = 1;
    }
  }

  return {
    isNewUser: interactionCount === 0,
    attitudeLevel,
    relationshipType,
    friendshipLevel,
    interactionCount,
    connectionStrength: qualityScore,
    relationshipStats: {
      warmth,
      trust,
      comfort,
      connection,
      positivityRatio,
      netSentiment,
      qualityScore
    },
    negativeScore: negScore,
    positiveScore: posScore
  };
}

// ── UNIFIED RELATIONSHIP SYSTEM ──────────────────────────────────────────────

// Enhanced sentiment analysis function
function analyzeComprehensiveSentiment(userMessage, conversationContext) {
  if (!userMessage) return { sentiment: 0, confidence: 0.5, type: 'neutral' };

  const message = userMessage.toLowerCase();
  let sentiment = 0;
  let confidence = 0.5;
  let type = 'neutral';

  // Positive indicators
  const positiveWords = ['thanks', 'thank you', 'great', 'awesome', 'cool', 'nice', 'good', 'love', 'like', 'appreciate', 'helpful', 'amazing', 'perfect', 'excellent'];
  const positiveCount = positiveWords.filter(word => message.includes(word)).length;

  // Negative indicators (not counting hostility analysis)
  const negativeWords = ['bad', 'hate', 'terrible', 'awful', 'sucks', 'stupid', 'dumb', 'annoying', 'boring', 'useless'];
  const negativeCount = negativeWords.filter(word => message.includes(word)).length;

  // Question indicators (show engagement)
  const hasQuestion = message.includes('?') || message.includes('how') || message.includes('what') || message.includes('why');

  // Calculate sentiment
  if (positiveCount > negativeCount) {
    sentiment = Math.min(0.8, positiveCount * 0.2);
    type = 'positive';
    confidence = 0.7;
  } else if (negativeCount > positiveCount) {
    sentiment = Math.max(-0.5, negativeCount * -0.15);
    type = 'negative';
    confidence = 0.6;
  } else if (hasQuestion) {
    sentiment = 0.1; // Slight positive for engagement
    type = 'engaged';
    confidence = 0.5;
  }

  return { sentiment, confidence, type };
}

// Update enhanced relationship metrics
async function updateEnhancedRelationship(userId, interaction, sentimentAnalysis) {
  await ensureUserPreferencesTable();

  const sentiment = sentimentAnalysis.sentiment || 0;
  const isPositive = sentiment > 0.1;
  const isNegative = sentiment < -0.1;

  // Calculate relationship increments
  const warmthIncrement = isPositive ? 0.05 : (isNegative ? -0.02 : 0.01);
  const trustIncrement = isPositive ? 0.03 : (isNegative ? -0.03 : 0.005);
  const comfortIncrement = isPositive ? 0.04 : (isNegative ? -0.02 : 0.008);

  await pool.query(`
        UPDATE user_preferences 
        SET 
            positive_score = CASE WHEN $2 > 0.1 THEN LEAST(2.0, COALESCE(positive_score, 0.0) + $2) ELSE COALESCE(positive_score, 0.0) END,
            positive_interactions = CASE WHEN $2 > 0.1 THEN COALESCE(positive_interactions, 0) + 1 ELSE COALESCE(positive_interactions, 0) END,
            last_positive_interaction = CASE WHEN $2 > 0.1 THEN CURRENT_TIMESTAMP ELSE last_positive_interaction END,
            warmth_level = GREATEST(0.0, LEAST(1.0, COALESCE(warmth_level, 0.0) + $3)),
            trust_level = GREATEST(0.0, LEAST(1.0, COALESCE(trust_level, 0.0) + $4)),  
            comfort_level = GREATEST(0.0, LEAST(1.0, COALESCE(comfort_level, 0.0) + $5)),
            meaningful_exchanges = CASE WHEN LENGTH($6) > 30 THEN COALESCE(meaningful_exchanges, 0) + 1 ELSE COALESCE(meaningful_exchanges, 0) END,
            recent_interaction_sentiment = $2,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $1
    `, [userId, sentiment, warmthIncrement, trustIncrement, comfortIncrement, interaction?.options?.getString('request') || '']);

  // Update relationship quality score
  await updateRelationshipQualityScore(userId);
}

// Calculate and update relationship quality score
async function updateRelationshipQualityScore(userId) {
  const { rows } = await pool.query(`
        SELECT warmth_level, trust_level, comfort_level, positive_score, negative_score, interaction_count 
        FROM user_preferences WHERE user_id = $1
    `, [userId]);

  if (rows.length === 0) return;

  const data = rows[0];
  const warmth = parseFloat(data.warmth_level) || 0;
  const trust = parseFloat(data.trust_level) || 0;
  const comfort = parseFloat(data.comfort_level) || 0;
  const posScore = parseFloat(data.positive_score) || 0;
  const negScore = parseFloat(data.negative_score) || 0;
  const interactions = data.interaction_count || 0;

  // Calculate quality score (0.0 to 1.0)
  const emotionalAverage = (warmth + trust + comfort) / 3;
  const sentimentRatio = posScore > 0 ? posScore / (posScore + negScore + 0.1) : 0;
  const interactionBonus = Math.min(0.3, interactions * 0.01);

  const qualityScore = Math.min(1.0, (emotionalAverage * 0.6) + (sentimentRatio * 0.3) + interactionBonus);

  await pool.query(`
        UPDATE user_preferences 
        SET relationship_quality_score = $2, connection_depth = $3
        WHERE user_id = $1
    `, [userId, qualityScore, Math.min(1.0, qualityScore * 0.8)]);
}

// UNIFIED function that all commands should use
async function getEnhancedUserContext(userId) {
  const { rows } = await pool.query(`
        SELECT * FROM user_preferences WHERE user_id = $1
    `, [userId]);

  if (rows.length === 0) {
    return {
      isNewUser: true,
      interactionCount: 0,
      preferredStyle: 'neutral',
      recentTopics: [],
      attitudeLevel: 'neutral',
      friendshipLevel: 0,
      negativeScore: 0,
      positiveScore: 0,
      hostileCount: 0,
      connectionStrength: 0,
      relationshipStats: {
        warmth: 0,
        trust: 0,
        comfort: 0,
        qualityScore: 0,
        positivityRatio: 0
      }
    };
  }

  const userPrefs = rows[0];
  const negScore = parseFloat(userPrefs.negative_score) || 0;
  const posScore = parseFloat(userPrefs.positive_score) || 0;
  const interactionCount = userPrefs.interaction_count || 0;
  const qualityScore = parseFloat(userPrefs.relationship_quality_score) || 0;
  const warmth = parseFloat(userPrefs.warmth_level) || 0;
  const trust = parseFloat(userPrefs.trust_level) || 0;
  const comfort = parseFloat(userPrefs.comfort_level) || 0;

  const netSentiment = posScore - negScore;
  const positiveInteractions = userPrefs.positive_interactions || 0;
  const positivityRatio = interactionCount > 0 ? positiveInteractions / interactionCount : 0;

  // UNIFIED attitude level calculation (used by ALL commands)
  let attitudeLevel = 'neutral';
  let friendshipLevel = 0;

  // Negative relationships
  if (negScore >= 0.8 || netSentiment < -0.8) {
    attitudeLevel = 'hostile';
    friendshipLevel = -3;
  } else if (negScore >= 0.5 || netSentiment < -0.5) {
    attitudeLevel = 'harsh';
    friendshipLevel = -2;
  } else if (negScore >= 0.3 || netSentiment < -0.2) {
    attitudeLevel = 'wary';
    friendshipLevel = -1;
  } else if (negScore >= 0.1 || netSentiment < -0.1) {
    attitudeLevel = 'cautious';
    friendshipLevel = 0;
  }
  // Positive relationships  
  else if (negScore <= 0.05 && netSentiment >= 0) {
    if (qualityScore >= 0.7 && interactionCount >= 20 && positivityRatio > 0.7) {
      attitudeLevel = 'familiar';
      friendshipLevel = 8;
    } else if (qualityScore >= 0.5 && interactionCount >= 15 && positivityRatio > 0.6) {
      attitudeLevel = 'friendly';
      friendshipLevel = 6;
    } else if (qualityScore >= 0.3 && interactionCount >= 8 && positivityRatio > 0.4) {
      attitudeLevel = 'warm';
      friendshipLevel = 4;
    } else if (qualityScore >= 0.2 && interactionCount >= 5 && positivityRatio > 0.3) {
      attitudeLevel = 'welcoming';
      friendshipLevel = 2;
    } else if (qualityScore >= 0.1 && interactionCount >= 3) {
      attitudeLevel = 'approachable';
      friendshipLevel = 1;
    }
  }

  return {
    isNewUser: false,
    interactionCount,
    preferredStyle: determinePreferredStyle(userPrefs),
    recentTopics: userPrefs.recent_topics?.slice(-5) || [],
    lastSeen: userPrefs.last_seen,
    attitudeLevel,
    friendshipLevel,
    negativeScore: negScore,
    positiveScore: posScore,
    hostileCount: userPrefs.hostile_interactions || 0,
    lastNegativeInteraction: userPrefs.last_negative_interaction,
    connectionStrength: qualityScore,
    relationshipStats: {
      warmth,
      trust,
      comfort,
      qualityScore,
      positivityRatio
    }
  };
}

// Update the old getUserContext to use the enhanced version for consistency
async function getUserContext(userId) {
  return await getEnhancedUserContext(userId);
}




module.exports = {
  pool,
  init,
  getBalance,
  getTopBalances,
  updateBalance,
  isUserBlacklisted,
  addUserToBlacklist,
  removeUserFromBlacklist,
  getSettingState,
  storeConversationMemory,
  getRelevantMemories,
  updateUserPreferences,
  getUserContext,
  updateNegativeBehavior,
  decayNegativeScore,
  analyzeHostileBehavior,
  getAllUserRelationships,
  ensureUserPreferencesTable,
  analyzeComprehensiveSentiment,
  updateEnhancedRelationship,
  getEnhancedUserContext,
  analyzeComprehensiveSentiment,
  updateEnhancedRelationship,
  getEnhancedUserContext,
  updateRelationshipQualityScore,
};
