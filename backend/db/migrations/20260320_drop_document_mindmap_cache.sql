ALTER TABLE documents
  DROP COLUMN IF EXISTS mindmap_cache,
  DROP COLUMN IF EXISTS mindmap_generated_at;
