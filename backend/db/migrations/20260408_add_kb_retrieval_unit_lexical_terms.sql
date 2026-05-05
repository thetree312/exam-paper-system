ALTER TABLE kb_retrieval_units
ADD COLUMN IF NOT EXISTS lexical_doc_len INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS kb_retrieval_unit_lexical_terms (
    source_id BIGINT NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
    unit_id BIGINT NOT NULL REFERENCES kb_retrieval_units(id) ON DELETE CASCADE,
    term TEXT NOT NULL,
    tf INTEGER NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (unit_id, term)
);

CREATE INDEX IF NOT EXISTS idx_kb_retrieval_unit_lexical_terms_source_term
ON kb_retrieval_unit_lexical_terms (source_id, term);

CREATE INDEX IF NOT EXISTS idx_kb_retrieval_unit_lexical_terms_unit_id
ON kb_retrieval_unit_lexical_terms (unit_id);
