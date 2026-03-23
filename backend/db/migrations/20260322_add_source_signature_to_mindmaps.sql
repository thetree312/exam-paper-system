ALTER TABLE mindmaps
  ADD COLUMN IF NOT EXISTS source_signature VARCHAR(255) NULL;

DROP INDEX IF EXISTS idx_mindmaps_scope;

CREATE INDEX IF NOT EXISTS idx_mindmaps_scope
  ON mindmaps (tenant_id, workroom_id, source_type, source_id, source_signature, kind, is_active);
