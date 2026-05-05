ALTER TABLE kb_evidence_nodes
    ADD COLUMN IF NOT EXISTS search_text TEXT NULL;

UPDATE kb_evidence_nodes
SET search_text = NULLIF(
    trim(
        coalesce(title, '') || ' ' || coalesce(text_content, '')
    ),
    ''
)
WHERE search_text IS NULL;

DROP INDEX IF EXISTS idx_kb_evidence_nodes_search_text_trgm;

CREATE INDEX IF NOT EXISTS idx_kb_evidence_nodes_search_text_trgm
    ON kb_evidence_nodes
    USING gin (lower(coalesce(search_text, '')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_kb_evidence_nodes_search_text_tsv
    ON kb_evidence_nodes
    USING gin (to_tsvector('simple', coalesce(search_text, '')));
