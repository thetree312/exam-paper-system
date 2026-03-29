CREATE TABLE IF NOT EXISTS kb_semantic_groups (
    id BIGSERIAL PRIMARY KEY,
    source_id BIGINT NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
    group_key VARCHAR(128) NOT NULL,
    group_type VARCHAR(32) NOT NULL DEFAULT 'text_flow',
    page_no_start INTEGER NULL,
    page_no_end INTEGER NULL,
    title VARCHAR(255) NULL,
    text_content TEXT NULL,
    primary_image_path TEXT NULL,
    token_count INTEGER NOT NULL DEFAULT 0,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    content_hash VARCHAR(64) NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_id, group_key)
);

CREATE INDEX IF NOT EXISTS idx_kb_semantic_groups_source_page
    ON kb_semantic_groups (source_id, page_no_start, id);

CREATE INDEX IF NOT EXISTS idx_kb_semantic_groups_source_created
    ON kb_semantic_groups (source_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS kb_semantic_group_members (
    id BIGSERIAL PRIMARY KEY,
    group_id BIGINT NOT NULL REFERENCES kb_semantic_groups(id) ON DELETE CASCADE,
    chunk_id BIGINT NOT NULL REFERENCES kb_chunks(id) ON DELETE CASCADE,
    member_role VARCHAR(32) NOT NULL DEFAULT 'body',
    member_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (group_id, chunk_id)
);

CREATE INDEX IF NOT EXISTS idx_kb_semantic_group_members_group_order
    ON kb_semantic_group_members (group_id, member_order, id);

CREATE INDEX IF NOT EXISTS idx_kb_semantic_group_members_chunk
    ON kb_semantic_group_members (chunk_id, group_id);

CREATE TABLE IF NOT EXISTS kb_semantic_group_embeddings (
    id BIGSERIAL PRIMARY KEY,
    group_id BIGINT NOT NULL REFERENCES kb_semantic_groups(id) ON DELETE CASCADE,
    tenant_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    model_name VARCHAR(128) NOT NULL,
    embed_kind VARCHAR(16) NOT NULL,
    dim INTEGER NOT NULL,
    embedding vector(768) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_semantic_group_embeddings_tenant_user_group
    ON kb_semantic_group_embeddings (tenant_id, user_id, group_id);

CREATE INDEX IF NOT EXISTS idx_kb_semantic_group_embeddings_tenant_user_kind_model
    ON kb_semantic_group_embeddings (tenant_id, user_id, embed_kind, model_name);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'idx_kb_semantic_group_embeddings_vector_ivfflat'
    ) THEN
        EXECUTE 'CREATE INDEX idx_kb_semantic_group_embeddings_vector_ivfflat
                 ON kb_semantic_group_embeddings
                 USING ivfflat (embedding vector_cosine_ops)
                 WITH (lists = 100)';
    END IF;
END $$;
