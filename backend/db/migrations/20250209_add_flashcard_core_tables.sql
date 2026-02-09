-- Adds flashcard concept storage, review tracking, generation jobs, and document metadata
-- Required for knowledge-point based flashcard pipeline.

ALTER TABLE documents
    ADD COLUMN page_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN long_summary_cache TEXT,
    ADD COLUMN long_summary_version VARCHAR(64);

CREATE TABLE flashcard_concepts (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    question_id BIGINT REFERENCES questions(id) ON DELETE SET NULL,
    chunk_id VARCHAR(128),
    concept_tag VARCHAR(255) NOT NULL,
    cue TEXT NOT NULL,
    answer TEXT NOT NULL,
    confidence REAL,
    source_ref JSONB,
    legend_images JSONB,
    created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_flashcard_concepts_document ON flashcard_concepts (document_id);
CREATE INDEX idx_flashcard_concepts_tenant_tag ON flashcard_concepts (tenant_id, concept_tag);

CREATE TABLE flashcard_reviews (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    card_id BIGINT NOT NULL REFERENCES flashcard_concepts(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    score SMALLINT NOT NULL,
    reviewed_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    interval_days INTEGER NOT NULL DEFAULT 0,
    next_review_at TIMESTAMP WITHOUT TIME ZONE,
    bucket SMALLINT,
    memo TEXT
);

CREATE INDEX idx_flashcard_reviews_card ON flashcard_reviews (card_id);
CREATE INDEX idx_flashcard_reviews_due ON flashcard_reviews (tenant_id, user_id, next_review_at);

CREATE TABLE flashcard_generation_jobs (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    mode VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL,
    progress SMALLINT NOT NULL DEFAULT 0,
    error_message TEXT,
    triggered_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP WITHOUT TIME ZONE
);

CREATE INDEX idx_flashcard_generation_jobs_document ON flashcard_generation_jobs (document_id);
CREATE INDEX idx_flashcard_generation_jobs_tenant ON flashcard_generation_jobs (tenant_id);
