ALTER TABLE kb_evidence_nodes
    ADD COLUMN IF NOT EXISTS normalized_search_text TEXT NULL;

ALTER TABLE kb_retrieval_units
    ADD COLUMN IF NOT EXISTS normalized_search_text TEXT NULL;

UPDATE kb_evidence_nodes
SET normalized_search_text = lower(coalesce(search_text, ''))
WHERE normalized_search_text IS NULL;

UPDATE kb_retrieval_units
SET normalized_search_text = lower(coalesce(search_text, ''))
WHERE normalized_search_text IS NULL;

CREATE INDEX IF NOT EXISTS idx_kb_evidence_nodes_normalized_search_text_trgm
    ON kb_evidence_nodes
    USING gin (coalesce(normalized_search_text, '') gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_kb_evidence_nodes_normalized_search_text_tsv
    ON kb_evidence_nodes
    USING gin (to_tsvector('simple', coalesce(normalized_search_text, '')));

CREATE INDEX IF NOT EXISTS idx_kb_retrieval_units_normalized_search_text_trgm
    ON kb_retrieval_units
    USING gin (coalesce(normalized_search_text, '') gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_kb_retrieval_units_normalized_search_text_tsv
    ON kb_retrieval_units
    USING gin (to_tsvector('simple', coalesce(normalized_search_text, '')));
