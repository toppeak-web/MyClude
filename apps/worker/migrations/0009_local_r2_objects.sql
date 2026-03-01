CREATE TABLE IF NOT EXISTS local_r2_objects (
  key TEXT PRIMARY KEY,
  content BLOB NOT NULL,
  content_type TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
