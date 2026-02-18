CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS album_items (
  id TEXT PRIMARY KEY,
  album_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  image_id TEXT NOT NULL,
  thumb_key TEXT NOT NULL,
  preview_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (album_id) REFERENCES albums(id),
  UNIQUE (album_id, image_id)
);

CREATE TABLE IF NOT EXISTS album_progress (
  user_id TEXT NOT NULL,
  album_id TEXT NOT NULL,
  image_id TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, album_id),
  FOREIGN KEY (album_id) REFERENCES albums(id)
);
