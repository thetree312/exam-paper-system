CREATE TABLE IF NOT EXISTS question_catalogs (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    document_id BIGINT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    question_count INTEGER NOT NULL DEFAULT 0,
    catalog_json JSONB NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_question_catalog_tenant_document UNIQUE (tenant_id, document_id),
    CONSTRAINT fk_question_catalogs_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT fk_question_catalogs_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);
