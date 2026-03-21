ALTER TABLE mindmaps
  ADD COLUMN IF NOT EXISTS workroom_id BIGINT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_mindmaps_workroom'
      AND conrelid = 'mindmaps'::regclass
  ) THEN
    ALTER TABLE mindmaps
      ADD CONSTRAINT fk_mindmaps_workroom
      FOREIGN KEY (workroom_id) REFERENCES workrooms(id)
      ON DELETE CASCADE;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_mindmaps_source;

CREATE INDEX IF NOT EXISTS idx_mindmaps_scope
  ON mindmaps (tenant_id, workroom_id, source_type, source_id, kind, is_active);
