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
    // Create table if it doesn't exist
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

    const displayName = interaction.member?.displayName || interaction.user.username;
    const channelId = interaction.channel.id;
    const topics = extractTopics(interaction.options.getString('request'));

    await pool.query(`
        INSERT INTO user_preferences (user_id, display_name, interaction_count, channels, recent_topics)
        VALUES ($1, $2, 1, ARRAY[$3], $4)
        ON CONFLICT (user_id) 
        DO UPDATE SET
            display_name = EXCLUDED.display_name,
            interaction_count = user_preferences.interaction_count + 1,
            last_seen = CURRENT_TIMESTAMP,
            channels = array_remove(array_append(user_preferences.channels, $3), NULL),
            recent_topics = array_remove(array_append(user_preferences.recent_topics, $4), NULL),
            updated_at = CURRENT_TIMESTAMP
    `, [userId, displayName, channelId, topics]);
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

async function updateNegativeBehavior(userId, negativeType, severity = 1) {
    // Ensure user_preferences table has the negative tracking columns
    await pool.query(`
        ALTER TABLE user_preferences 
        ADD COLUMN IF NOT EXISTS negative_score DECIMAL(3,2) DEFAULT 0.0,
        ADD COLUMN IF NOT EXISTS hostile_interactions INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_negative_interaction TIMESTAMP DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS negative_patterns TEXT[] DEFAULT ARRAY[]::TEXT[]
    `);
    
    // Update or create user record with negative behavior
    await pool.query(`
        INSERT INTO user_preferences (user_id, negative_score, hostile_interactions, last_negative_interaction, negative_patterns)
        VALUES ($1, $2, 1, CURRENT_TIMESTAMP, ARRAY[$3])
        ON CONFLICT (user_id) 
        DO UPDATE SET
            negative_score = LEAST(1.0, user_preferences.negative_score + $2),
            hostile_interactions = user_preferences.hostile_interactions + 1,  
            last_negative_interaction = CURRENT_TIMESTAMP,
            negative_patterns = array_remove(array_append(user_preferences.negative_patterns, $3), NULL),
            updated_at = CURRENT_TIMESTAMP
    `, [userId, severity, negativeType]);
}

async function decayNegativeScore(userId) {
    // Reduce negative score over time for users who behave better
    await pool.query(`
        UPDATE user_preferences 
        SET negative_score = GREATEST(0.0, negative_score - 0.1),
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $1 AND negative_score > 0
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
};
