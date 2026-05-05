CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_kb_chunks_content_trgm
    ON kb_chunks
    USING gin (lower(content) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_kb_semantic_groups_search_text_trgm
    ON kb_semantic_groups
    USING gin (lower(coalesce(title, '') || ' ' || coalesce(text_content, '')) gin_trgm_ops);
