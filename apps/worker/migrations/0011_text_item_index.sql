CREATE TABLE IF NOT EXISTS text_item_index_progress (
  user_id TEXT NOT NULL,
  album_id TEXT NOT NULL,
  image_id TEXT NOT NULL,
  byte_index INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, album_id, image_id)
);
