CREATE TABLE IF NOT EXISTS rag_retrieval_runs (
    id BIGSERIAL PRIMARY KEY,
    worker_id VARCHAR(64) NOT NULL,
    tenant_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    workroom_id BIGINT NULL,
    tool_name VARCHAR(64) NOT NULL,
    query_text TEXT NULL,
    object_refs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(16) NOT NULL DEFAULT 'ok',
    error_message TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_retrieval_runs_scope_time
    ON rag_retrieval_runs (tenant_id, user_id, workroom_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rag_retrieval_runs_worker
    ON rag_retrieval_runs (worker_id);

CREATE INDEX IF NOT EXISTS idx_rag_retrieval_runs_tool_status
    ON rag_retrieval_runs (tool_name, status, created_at DESC);

CREATE TABLE IF NOT EXISTS rag_profiles (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    profile_name VARCHAR(64) NOT NULL,
    profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_id, profile_name)
);

CREATE INDEX IF NOT EXISTS idx_rag_profiles_scope
    ON rag_profiles (tenant_id, user_id, is_active, updated_at DESC);

CREATE TABLE IF NOT EXISTS rag_eval_runs (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    workroom_id BIGINT NULL,
    profile_name VARCHAR(64) NOT NULL,
    eval_set_name VARCHAR(128) NOT NULL,
    metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_eval_runs_scope_time
    ON rag_eval_runs (tenant_id, user_id, workroom_id, created_at DESC);
