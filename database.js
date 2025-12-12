const Database = require('better-sqlite3');
const db = new Database('./data/ravedad.db');

// Initialize Tables with CURRENT Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    credits INTEGER DEFAULT 10,
    lifetime_points INTEGER DEFAULT 0,
    daily_points INTEGER DEFAULT 0,
    last_active TEXT,
    listen_start INTEGER DEFAULT 0,
    listen_song_id INTEGER DEFAULT 0,
    extra_submits INTEGER DEFAULT 0,
    suspended_until INTEGER DEFAULT 0,
    suspend_reason TEXT
  );

  CREATE TABLE IF NOT EXISTS songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    url TEXT,
    description TEXT,
    tags TEXT,
    upvotes INTEGER DEFAULT 0,
    views INTEGER DEFAULT 0,
    message_id TEXT,
    channel_id TEXT,
    title TEXT,
    artist_name TEXT,
    timestamp INTEGER
  );

  CREATE TABLE IF NOT EXISTS reviews (
    user_id TEXT,
    song_id INTEGER,
    timestamp INTEGER,
    PRIMARY KEY (user_id, song_id)
  );

  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id INTEGER,
    voter_id TEXT,
    type TEXT,
    timestamp INTEGER,
    amount INTEGER DEFAULT 1
  );
`);

module.exports = db;
