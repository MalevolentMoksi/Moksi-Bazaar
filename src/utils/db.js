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
    [userId, 1000]
  );
  return 1000;
}

// Update (or insert) a user's balance
async function updateBalance(userId, newBalance) {
  await pool.query(
    `INSERT INTO balances (user_id, balance) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance`,
    [userId, newBalance]
  );
}

module.exports = { init, getBalance, updateBalance };
