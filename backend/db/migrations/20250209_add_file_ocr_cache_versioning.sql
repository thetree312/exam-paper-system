-- Add versioning + active flags for file_ocr_cache to support multi-version caching
ALTER TABLE file_ocr_cache
    ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- Backfill any NULLs just in case
UPDATE file_ocr_cache SET version = 1 WHERE version IS NULL;
UPDATE file_ocr_cache SET is_active = TRUE WHERE is_active IS NULL;

-- Drop legacy unique constraint on (tenant_id, content_hash)
ALTER TABLE file_ocr_cache
    DROP CONSTRAINT IF EXISTS uq_file_ocr_cache_tenant_hash;
DROP INDEX IF EXISTS uq_file_ocr_cache_tenant_hash;

-- Enforce single active cache entry per tenant/hash/model via partial unique index
CREATE UNIQUE INDEX IF NOT EXISTS uq_file_ocr_cache_active
    ON file_ocr_cache (tenant_id, content_hash, model)
    WHERE is_active = TRUE;
