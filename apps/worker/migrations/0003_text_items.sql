ALTER TABLE album_items ADD COLUMN item_type TEXT NOT NULL DEFAULT 'image';
ALTER TABLE album_items ADD COLUMN content_key TEXT;
ALTER TABLE album_items ADD COLUMN content_mime TEXT;
ALTER TABLE album_items ADD COLUMN original_name TEXT;
