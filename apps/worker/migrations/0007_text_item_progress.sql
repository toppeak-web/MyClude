CREATE TABLE IF NOT EXISTS text_item_progress (
  user_id TEXT NOT NULL,
  album_id TEXT NOT NULL,
  image_id TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, album_id, image_id),
  FOREIGN KEY (album_id) REFERENCES albums(id)
);
