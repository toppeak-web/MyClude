CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  novel_font_family TEXT,
  novel_theme TEXT,
  novel_font_size INTEGER,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
