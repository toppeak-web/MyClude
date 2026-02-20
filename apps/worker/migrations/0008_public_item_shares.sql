CREATE TABLE IF NOT EXISTS public_item_shares (
  token TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  album_id TEXT NOT NULL,
  image_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_public_item_shares_expires
ON public_item_shares (expires_at);
