CREATE TABLE IF NOT EXISTS file_page_layout_cache (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    file_id BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    content_hash VARCHAR(64) NOT NULL,
    page_no INTEGER NOT NULL,
    model VARCHAR(100) NOT NULL,
    schema_version VARCHAR(32) NOT NULL DEFAULT 'v1',
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    lease_owner VARCHAR(128) NULL,
    lease_expires_at TIMESTAMPTZ NULL,
    request_started_at TIMESTAMPTZ NULL,
    generated_at TIMESTAMPTZ NULL,
    error TEXT NULL,
    source_asset_ref TEXT NOT NULL,
    transport_kind VARCHAR(32) NOT NULL DEFAULT 'data_url',
    layout_json TEXT NULL,
    blocks_json TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_file_page_layout_cache_identity
        UNIQUE (tenant_id, content_hash, page_no, model, schema_version)
);

CREATE INDEX IF NOT EXISTS idx_file_page_layout_cache_file_page
    ON file_page_layout_cache (file_id, page_no);

CREATE INDEX IF NOT EXISTS idx_file_page_layout_cache_status_lease
    ON file_page_layout_cache (status, lease_expires_at);
