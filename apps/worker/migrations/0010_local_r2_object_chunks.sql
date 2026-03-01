CREATE TABLE IF NOT EXISTS local_r2_object_chunks (
  key TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content BLOB NOT NULL,
  content_type TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (key, chunk_index)
);
