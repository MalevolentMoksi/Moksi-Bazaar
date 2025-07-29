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
};
