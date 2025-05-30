// src/utils/db.js
const { Pool } = require('pg');
// Use SSL for Railway Postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize the balances table if it doesn't exist
const init = async () => {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS balances (
       user_id   TEXT PRIMARY KEY,
       balance   INTEGER NOT NULL
     );`
  );
};

// Get the balance for a user, creating a new entry with 1000 if absent
async function getBalance(userId) {
  const { rows } = await pool.query(
    'SELECT balance FROM balances WHERE user_id = $1',
    [userId]
  );
  if (rows.length) return rows[0].balance;
  // New player: seed with 1000
  await pool.query(
    'INSERT INTO balances (user_id, balance) VALUES ($1, $2)',
    [userId, 10000]
  );
  return 10000;
}

// Get the top N balances across *all* users
async function getTopBalances(limit = 10) {
  const { rows } = await pool.query(
    `SELECT user_id, balance
       FROM balances
      ORDER BY balance DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}


// Update (or insert) a user's balance
async function updateBalance(userId, newBalance) {
  await pool.query(
    `INSERT INTO balances (user_id, balance) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance`,
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
