// DB 어댑터: Railway 등에서 DATABASE_URL이 있으면 PostgreSQL, 없으면 로컬 SQLite 사용
const usePg = !!process.env.DATABASE_URL;

let query; // query(sql, params) -> Promise<rows>  (SQL은 PostgreSQL $1 스타일로 작성)

if (usePg) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
      ? false
      : { rejectUnauthorized: false },
  });
  query = async (sql, params = []) => {
    const res = await pool.query(sql, params);
    return res.rows;
  };
} else {
  const Database = require('better-sqlite3');
  const db = new Database(process.env.SQLITE_PATH || 'data.db');
  db.pragma('journal_mode = WAL');
  query = async (sql, params = []) => {
    // $1, $2 → ? 변환 (파라미터는 순서대로만 사용한다는 전제)
    const converted = sql.replace(/\$\d+/g, '?');
    const stmt = db.prepare(converted);
    if (stmt.reader) return stmt.all(...params);
    stmt.run(...params);
    return [];
  };
}

async function init() {
  const idCol = usePg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  await query(`CREATE TABLE IF NOT EXISTS workers (
    id ${idCol},
    username TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  await query(`CREATE TABLE IF NOT EXISTS logins (
    id ${idCol},
    worker TEXT NOT NULL,
    logged_in_at TEXT NOT NULL
  )`);
  await query(`CREATE TABLE IF NOT EXISTS sessions (
    id ${idCol},
    worker TEXT NOT NULL,
    box_qr TEXT NOT NULL,
    part_no TEXT NOT NULL,
    target_qty INTEGER,
    ok_count INTEGER NOT NULL DEFAULT 0,
    ng_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    ended_at TEXT
  )`);
  await query(`CREATE TABLE IF NOT EXISTS scans (
    id ${idCol},
    session_id INTEGER NOT NULL,
    worker TEXT NOT NULL,
    barcode TEXT NOT NULL,
    part_no TEXT NOT NULL,
    result TEXT NOT NULL,
    scanned_at TEXT NOT NULL
  )`);
}

module.exports = { query, init, usePg };
