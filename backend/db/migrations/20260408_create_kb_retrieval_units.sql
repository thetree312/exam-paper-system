CREATE TABLE IF NOT EXISTS kb_retrieval_units (
    id BIGSERIAL PRIMARY KEY,
    source_id BIGINT NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
    tenant_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    unit_key VARCHAR(128) NOT NULL,
    anchor_node_id BIGINT NULL REFERENCES kb_evidence_nodes(id) ON DELETE SET NULL,
    page_no_start INTEGER NULL,
    page_no_end INTEGER NULL,
    title VARCHAR(255) NULL,
    search_text TEXT NULL,
    text_content TEXT NULL,
    has_visual BOOLEAN NOT NULL DEFAULT FALSE,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    content_hash VARCHAR(64) NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_id, unit_key)
);

CREATE INDEX IF NOT EXISTS idx_kb_retrieval_units_scope
    ON kb_retrieval_units (tenant_id, user_id, source_id, id);

CREATE INDEX IF NOT EXISTS idx_kb_retrieval_units_search_text_trgm
    ON kb_retrieval_units
    USING gin (lower(coalesce(search_text, '')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_kb_retrieval_units_search_text_tsv
    ON kb_retrieval_units
    USING gin (to_tsvector('simple', coalesce(search_text, '')));

CREATE TABLE IF NOT EXISTS kb_retrieval_unit_embeddings (
    id BIGSERIAL PRIMARY KEY,
    unit_id BIGINT NOT NULL REFERENCES kb_retrieval_units(id) ON DELETE CASCADE,
    source_id BIGINT NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
    tenant_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    model_name VARCHAR(128) NOT NULL,
    dim INTEGER NOT NULL,
    embedding vector(768) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_retrieval_unit_embeddings_scope
    ON kb_retrieval_unit_embeddings (tenant_id, user_id, unit_id);

CREATE INDEX IF NOT EXISTS idx_kb_retrieval_unit_embeddings_vector_ivfflat
    ON kb_retrieval_unit_embeddings
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

CREATE TABLE IF NOT EXISTS kb_retrieval_unit_node_map (
    id BIGSERIAL PRIMARY KEY,
    source_id BIGINT NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
    unit_id BIGINT NOT NULL REFERENCES kb_retrieval_units(id) ON DELETE CASCADE,
    node_id BIGINT NOT NULL REFERENCES kb_evidence_nodes(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (unit_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_kb_retrieval_unit_node_map_source
    ON kb_retrieval_unit_node_map (source_id, unit_id, node_id);
