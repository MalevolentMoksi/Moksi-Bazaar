// CLEAN DB.JS - Refactored and Streamlined
// Remove all duplicate and obsolete functions, keep only what's needed

const { Pool, types } = require('pg');

// Parse BIGINT as JS Number
types.setTypeParser(types.builtins.INT8, v => parseInt(v, 10));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── TABLE INITIALIZATION ──────────────────────────────────────────────────────
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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversation_memories (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_message TEXT,
      bot_response TEXT,
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

// ── BALANCE FUNCTIONS ─────────────────────────────────────────────────────────
async function getBalance(userId) {
  const { rows } = await pool.query(
    'SELECT balance FROM balances WHERE user_id = $1', [userId]
  );

  if (rows.length) return rows[0].balance;

  // Seed new player with 10,000
  const seed = 10000;
  await pool.query(
    'INSERT INTO balances (user_id, balance) VALUES ($1, $2)', [userId, seed]
  );
  return seed;
}

async function updateBalance(userId, newBalance) {
  await pool.query(
    `INSERT INTO balances (user_id, balance) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance`,
    [userId, newBalance]
  );
}

async function getTopBalances(limit = 10) {
  const { rows } = await pool.query(
    'SELECT user_id, balance FROM balances ORDER BY balance DESC LIMIT $1',
    [limit]
  );
  return rows;
}

// ── BLACKLIST FUNCTIONS ───────────────────────────────────────────────────────
async function isUserBlacklisted(userId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM speak_blacklist WHERE user_id = $1', [userId]
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
  await pool.query('DELETE FROM speak_blacklist WHERE user_id = $1', [userId]);
}

// ── SETTINGS FUNCTIONS ────────────────────────────────────────────────────────
async function getSettingState(key) {
  const { rows } = await pool.query(
    'SELECT state FROM settings WHERE setting = $1', [key]
  );
  return rows.length > 0 ? rows[0].state : null;
}

// ── SIMPLIFIED USER CONTEXT ───────────────────────────────────────────────────
async function getUserContext(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM user_preferences WHERE user_id = $1', [userId]
  );

  if (rows.length === 0) {
    return {
      isNewUser: true,
      attitudeLevel: 'neutral',
      interactionCount: 0
    };
  }

  return {
    isNewUser: false,
    attitudeLevel: rows[0].attitude_level,
    interactionCount: rows[0].interaction_count,
    displayName: rows[0].display_name,
    lastSeen: rows[0].last_seen
  };
}

// ── SIMPLIFIED USER PREFERENCE UPDATES ────────────────────────────────────────
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

// ── SIMPLIFIED RELATIONSHIP TRACKING ──────────────────────────────────────────
async function updateUserAttitude(userId, sentimentScore) {
  let newAttitude = 'neutral';

  // Simple attitude calculation based on interaction count and sentiment
  const userContext = await getUserContext(userId);
  const count = userContext.interactionCount || 0;

  if (sentimentScore < -0.5) {
    newAttitude = 'hostile';
  } else if (sentimentScore < -0.2) {
    newAttitude = 'cautious'; 
  } else if (sentimentScore > 0.3 && count >= 50) {
    newAttitude = 'familiar';
  } else if (sentimentScore > 0.1 && count >= 10) {
    newAttitude = 'friendly';
  }

  await pool.query(
    'UPDATE user_preferences SET attitude_level = $2, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1',
    [userId, newAttitude]
  );
}

// ── SIMPLIFIED MEMORY SYSTEM ──────────────────────────────────────────────────
async function storeConversationMemory(userId, channelId, userMessage, botResponse) {
  await pool.query(`
    INSERT INTO conversation_memories (user_id, channel_id, user_message, bot_response, timestamp)
    VALUES ($1, $2, $3, $4, $5)
  `, [userId, channelId, userMessage, botResponse, Date.now()]);

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
    SELECT user_message, bot_response, timestamp
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
  updateUserAttitude,
  storeConversationMemory,
  getRecentMemories
};