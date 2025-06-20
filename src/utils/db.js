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

module.exports = {
  pool,
  init,
  getBalance,
  getTopBalances,
  updateBalance,
};
