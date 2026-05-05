CREATE TABLE IF NOT EXISTS kb_evidence_nodes (
    id BIGSERIAL PRIMARY KEY,
    source_id BIGINT NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
    node_key VARCHAR(128) NOT NULL,
    node_type VARCHAR(32) NOT NULL DEFAULT 'text',
    page_no_start INTEGER NULL,
    page_no_end INTEGER NULL,
    title VARCHAR(255) NULL,
    text_content TEXT NULL,
    asset_ref TEXT NULL,
    token_count INTEGER NOT NULL DEFAULT 0,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    content_hash VARCHAR(64) NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_id, node_key)
);

CREATE INDEX IF NOT EXISTS idx_kb_evidence_nodes_source_page
    ON kb_evidence_nodes (source_id, page_no_start, id);

CREATE INDEX IF NOT EXISTS idx_kb_evidence_nodes_source_created
    ON kb_evidence_nodes (source_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_kb_evidence_nodes_search_text_trgm
    ON kb_evidence_nodes
    USING gin (lower(coalesce(title, '') || ' ' || coalesce(text_content, '')) gin_trgm_ops);

CREATE TABLE IF NOT EXISTS kb_evidence_node_embeddings (
    id BIGSERIAL PRIMARY KEY,
    node_id BIGINT NOT NULL REFERENCES kb_evidence_nodes(id) ON DELETE CASCADE,
    tenant_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    model_name VARCHAR(128) NOT NULL,
    embed_kind VARCHAR(16) NOT NULL,
    dim INTEGER NOT NULL,
    embedding vector(768) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_evidence_node_embeddings_tenant_user_node
    ON kb_evidence_node_embeddings (tenant_id, user_id, node_id);

CREATE INDEX IF NOT EXISTS idx_kb_evidence_node_embeddings_tenant_user_kind_model
    ON kb_evidence_node_embeddings (tenant_id, user_id, embed_kind, model_name);

CREATE INDEX IF NOT EXISTS idx_kb_evidence_node_embeddings_vector_ivfflat
    ON kb_evidence_node_embeddings
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

CREATE TABLE IF NOT EXISTS kb_evidence_edges (
    id BIGSERIAL PRIMARY KEY,
    source_id BIGINT NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
    from_node_id BIGINT NOT NULL REFERENCES kb_evidence_nodes(id) ON DELETE CASCADE,
    to_node_id BIGINT NOT NULL REFERENCES kb_evidence_nodes(id) ON DELETE CASCADE,
    edge_type VARCHAR(32) NOT NULL,
    weight DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_id, from_node_id, to_node_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_kb_evidence_edges_source
    ON kb_evidence_edges (source_id, id);

CREATE INDEX IF NOT EXISTS idx_kb_evidence_edges_from_type
    ON kb_evidence_edges (from_node_id, edge_type, to_node_id);

CREATE INDEX IF NOT EXISTS idx_kb_evidence_edges_to_type
    ON kb_evidence_edges (to_node_id, edge_type, from_node_id);
