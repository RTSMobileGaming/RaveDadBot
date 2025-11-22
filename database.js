const Database = require('better-sqlite3');
const db = new Database('./data/ravedad.db'); // Ensure it points to the data folder

// Initialize Tables with NEW Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    credits INTEGER DEFAULT 10,
    lifetime_points INTEGER DEFAULT 0,
    daily_points INTEGER DEFAULT 0,
    last_active TEXT
  );

  CREATE TABLE IF NOT EXISTS songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    url TEXT,
    description TEXT,
    tags TEXT,
    upvotes INTEGER DEFAULT 0,
    views INTEGER DEFAULT 0,     -- New Column
    message_id TEXT,             -- New Column
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
    timestamp INTEGER
  );
`);

module.exports = db;