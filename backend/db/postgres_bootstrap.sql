-- =====================================================================
--  exam_paper PostgreSQL bootstrap script (cloud-friendly, idempotent)
-- =====================================================================

-- 1) Create application database (run under superuser, e.g. postgres)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'exam_paper') THEN
        EXECUTE
            'CREATE DATABASE exam_paper
             WITH OWNER = current_user
                  ENCODING = ''UTF8''
                  LC_COLLATE = ''C''
                  LC_CTYPE = ''C''
                  TEMPLATE = template0';
    END IF;
END
$$ LANGUAGE plpgsql;

-- 2) Connect to the database before continuing (psql syntax)
\connect exam_paper

-- 3) Optional extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 4) Reusable helper: auto-update updated_at columns
CREATE OR REPLACE FUNCTION trg_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 5) Enum types mirroring business states
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_status') THEN
        CREATE TYPE subscription_status AS ENUM ('trialing','active','past_due','canceled');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'file_source_type') THEN
        CREATE TYPE file_source_type AS ENUM ('image','pdf','word');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'extraction_status') THEN
        CREATE TYPE extraction_status AS ENUM ('pending','processing','done','failed');
    END IF;
END
$$;

-- 6) Core tables -------------------------------------------------------

CREATE TABLE IF NOT EXISTS tenants (
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    code        VARCHAR(64)  NOT NULL,
    status      SMALLINT     NOT NULL DEFAULT 1,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_tenant_code UNIQUE (code)
);

CREATE TABLE IF NOT EXISTS plans (
    id                     BIGSERIAL PRIMARY KEY,
    code                   VARCHAR(64)  NOT NULL,
    name                   VARCHAR(100) NOT NULL,
    max_agent_tokens_month INTEGER     NOT NULL DEFAULT 0,
    max_agent_sessions_day INTEGER     NOT NULL DEFAULT 0,
    features               JSONB       NOT NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_plan_code UNIQUE (code)
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id                   BIGSERIAL PRIMARY KEY,
    tenant_id            BIGINT      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    plan_id              BIGINT      NOT NULL REFERENCES plans(id)   ON DELETE RESTRICT,
    status               subscription_status NOT NULL DEFAULT 'trialing',
    current_period_start TIMESTAMPTZ NOT NULL,
    current_period_end   TIMESTAMPTZ NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    INDEX idx_subscriptions_tenant (tenant_id)
);

CREATE TABLE IF NOT EXISTS users (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email         VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name  VARCHAR(100) NOT NULL,
    role          VARCHAR(50)  NOT NULL DEFAULT 'member',
    status        SMALLINT     NOT NULL DEFAULT 1,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_user_tenant_email UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS social_accounts (
    id                  BIGSERIAL PRIMARY KEY,
    tenant_id           BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id             BIGINT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    provider            VARCHAR(32)  NOT NULL,
    provider_account_id VARCHAR(255) NOT NULL,
    access_token        VARCHAR(512),
    refresh_token       VARCHAR(512),
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT uk_social_provider UNIQUE (tenant_id, provider, provider_account_id)
);

CREATE TABLE IF NOT EXISTS files (
    id             BIGSERIAL PRIMARY KEY,
    tenant_id      BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    uploader_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
    original_name  VARCHAR(255) NOT NULL,
    storage_path   VARCHAR(512) NOT NULL,
    preview_path   VARCHAR(512),
    mime_type      VARCHAR(100) NOT NULL,
    file_size      BIGINT NOT NULL,
    source_type    file_source_type NOT NULL,
    status         SMALLINT NOT NULL DEFAULT 1,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS extraction_sessions (
    id         BIGSERIAL PRIMARY KEY,
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    file_id    BIGINT NOT NULL REFERENCES files(id)   ON DELETE CASCADE,
    status     extraction_status NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    INDEX idx_sessions_tenant (tenant_id)
);

CREATE TABLE IF NOT EXISTS documents (
    id             BIGSERIAL PRIMARY KEY,
    tenant_id      BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    owner_user_id  BIGINT REFERENCES users(id)               ON DELETE SET NULL,
    file_id        BIGINT REFERENCES files(id)               ON DELETE SET NULL,
    session_id     BIGINT REFERENCES extraction_sessions(id) ON DELETE SET NULL,
    title          VARCHAR(255) NOT NULL DEFAULT '未命名试卷',
    status         VARCHAR(50)  NOT NULL DEFAULT 'draft',
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    INDEX idx_documents_tenant (tenant_id)
);

CREATE TABLE IF NOT EXISTS questions (
    id             BIGSERIAL PRIMARY KEY,
    tenant_id      BIGINT NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
    document_id    BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    sequence_index INTEGER NOT NULL DEFAULT 0,
    page           INTEGER,
    content        TEXT    NOT NULL,
    legend_images  JSONB   NOT NULL DEFAULT '[]'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    INDEX idx_questions_document (document_id)
);

CREATE TABLE IF NOT EXISTS extracted_items (
    id             BIGSERIAL PRIMARY KEY,
    tenant_id      BIGINT NOT NULL REFERENCES tenants(id)            ON DELETE CASCADE,
    session_id     BIGINT NOT NULL REFERENCES extraction_sessions(id) ON DELETE CASCADE,
    sequence_index INTEGER NOT NULL,
    content_html   TEXT    NOT NULL,
    content_plain  TEXT,
    question_type  VARCHAR(50),
    confidence     NUMERIC(5,2),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    INDEX idx_items_tenant (tenant_id),
    INDEX idx_items_session (session_id)
);

CREATE TABLE IF NOT EXISTS agent_sessions (
    id                   BIGSERIAL PRIMARY KEY,
    tenant_id            BIGINT NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
    user_id              BIGINT NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
    document_id          BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    view_id              VARCHAR(64)  NOT NULL,
    thread_id            VARCHAR(128),
    title                VARCHAR(255),
    last_message_preview TEXT,
    message_count        INTEGER NOT NULL DEFAULT 0,
    status               VARCHAR(32) NOT NULL DEFAULT 'active',
    archived             BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at           TIMESTAMPTZ,
    INDEX idx_agent_sessions_tenant (tenant_id)
);

CREATE TABLE IF NOT EXISTS agent_messages (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id)      ON DELETE CASCADE,
    session_id  BIGINT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    role        VARCHAR(32) NOT NULL,
    content     TEXT        NOT NULL,
    token_usage INTEGER,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    INDEX idx_agent_messages_session (session_id)
);

-- 7) Apply updated_at triggers ------------------------------------------------
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT table_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'updated_at'
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated_at ON %I', r.table_name, r.table_name);
        EXECUTE format(
            'CREATE TRIGGER trg_%s_updated_at
             BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at()',
            r.table_name, r.table_name
        );
    END LOOP;
END
$$;
