CREATE TABLE IF NOT EXISTS album_external_links (
  id TEXT PRIMARY KEY,
  album_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (album_id) REFERENCES albums(id)
);

CREATE INDEX IF NOT EXISTS idx_album_external_links_album_created
ON album_external_links (album_id, created_at);
