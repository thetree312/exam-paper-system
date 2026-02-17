-- Create database
CREATE DATABASE IF NOT EXISTS exam_paper
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE exam_paper;

-- Tenants table
CREATE TABLE IF NOT EXISTS tenants (
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name         VARCHAR(100)    NOT NULL,
    code         VARCHAR(64)     NOT NULL,
    status       TINYINT         NOT NULL DEFAULT 1,
    created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_tenant_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Plans table
CREATE TABLE IF NOT EXISTS plans (
    id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    code                    VARCHAR(64)     NOT NULL,
    name                    VARCHAR(100)    NOT NULL,
    max_agent_tokens_month  INT             NOT NULL DEFAULT 0,
    max_agent_sessions_day  INT             NOT NULL DEFAULT 0,
    features                JSON            NOT NULL,
    created_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_plan_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
    id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id             BIGINT UNSIGNED NOT NULL,
    plan_id               BIGINT UNSIGNED NOT NULL,
    status                ENUM('trialing','active','past_due','canceled') NOT NULL DEFAULT 'trialing',
    current_period_start  DATETIME        NOT NULL,
    current_period_end    DATETIME        NOT NULL,
    created_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_subscriptions_tenant (tenant_id),
    CONSTRAINT fk_subscriptions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT fk_subscriptions_plan FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Documents table
CREATE TABLE IF NOT EXISTS documents (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    owner_user_id BIGINT UNSIGNED NULL,
    file_id       BIGINT UNSIGNED NULL,
    session_id    BIGINT UNSIGNED NULL,
    title         VARCHAR(255)    NOT NULL DEFAULT '未命名试卷',
    status        VARCHAR(50)     NOT NULL DEFAULT 'draft',
    created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_documents_tenant (tenant_id),
    CONSTRAINT fk_documents_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT fk_documents_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_documents_file FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE SET NULL,
    CONSTRAINT fk_documents_session FOREIGN KEY (session_id) REFERENCES extraction_sessions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Questions table
CREATE TABLE IF NOT EXISTS questions (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id       BIGINT UNSIGNED NOT NULL,
    document_id     BIGINT UNSIGNED NOT NULL,
    sequence_index  INT             NOT NULL DEFAULT 0,
    page            INT             NULL,
    content         MEDIUMTEXT      NOT NULL,
    legend_images   JSON            NOT NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_questions_document (document_id),
    CONSTRAINT fk_questions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT fk_questions_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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

-- Agent sessions table
CREATE TABLE IF NOT EXISTS agent_sessions (
    id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id            BIGINT UNSIGNED NOT NULL,
    user_id              BIGINT UNSIGNED NOT NULL,
    document_id          BIGINT UNSIGNED NOT NULL,
    view_id              VARCHAR(64)     NOT NULL,
    thread_id            VARCHAR(128)    NULL,
    title                VARCHAR(255)    NULL,
    last_message_preview MEDIUMTEXT      NULL,
    message_count        INT             NOT NULL DEFAULT 0,
    status               VARCHAR(32)     NOT NULL DEFAULT 'active',
    archived             TINYINT(1)      NOT NULL DEFAULT 0,
    created_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at           DATETIME        NULL,
    PRIMARY KEY (id),
    KEY idx_agent_sessions_tenant (tenant_id),
    CONSTRAINT fk_agent_sessions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT fk_agent_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_agent_sessions_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Agent messages table
CREATE TABLE IF NOT EXISTS agent_messages (
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id    BIGINT UNSIGNED NOT NULL,
    session_id   BIGINT UNSIGNED NOT NULL,
    role         VARCHAR(32)     NOT NULL,
    content      MEDIUMTEXT      NOT NULL,
    token_usage  INT             NULL,
    created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_agent_messages_session (session_id),
    CONSTRAINT fk_agent_messages_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT fk_agent_messages_session FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id      BIGINT UNSIGNED NOT NULL,
    email          VARCHAR(255)    NOT NULL,
    password_hash  VARCHAR(255)    NOT NULL,
    display_name   VARCHAR(100)    NOT NULL,
    role           VARCHAR(50)     NOT NULL DEFAULT 'member',
    status         TINYINT         NOT NULL DEFAULT 1,
    created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_user_tenant_email (tenant_id, email),
    CONSTRAINT fk_users_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Social accounts table (for WeChat/Google login binding)
CREATE TABLE IF NOT EXISTS social_accounts (
    id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id            BIGINT UNSIGNED NOT NULL,
    user_id              BIGINT UNSIGNED NOT NULL,
    provider             VARCHAR(32)     NOT NULL,
    provider_account_id  VARCHAR(255)    NOT NULL,
    access_token         VARCHAR(512)    NULL,
    refresh_token        VARCHAR(512)    NULL,
    created_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_social_provider (tenant_id, provider, provider_account_id),
    CONSTRAINT fk_social_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT fk_social_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Files table
CREATE TABLE IF NOT EXISTS files (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id       BIGINT UNSIGNED NOT NULL,
    uploader_id     BIGINT UNSIGNED NULL,
    original_name   VARCHAR(255)    NOT NULL,
    storage_path    VARCHAR(512)    NOT NULL,
    preview_path    VARCHAR(512)    NULL,
    mime_type       VARCHAR(100)    NOT NULL,
    file_size       BIGINT          NOT NULL,
    source_type     ENUM('image','pdf','word') NOT NULL,
    status          TINYINT         NOT NULL DEFAULT 1,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_files_tenant (tenant_id),
    CONSTRAINT fk_files_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT fk_files_uploader FOREIGN KEY (uploader_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Extraction sessions table
CREATE TABLE IF NOT EXISTS extraction_sessions (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id       BIGINT UNSIGNED NOT NULL,
    user_id         BIGINT UNSIGNED NOT NULL,
    file_id         BIGINT UNSIGNED NOT NULL,
    status          ENUM('pending','processing','done','failed') NOT NULL DEFAULT 'pending',
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_sessions_tenant (tenant_id),
    CONSTRAINT fk_sessions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_sessions_file FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Extracted items table
CREATE TABLE IF NOT EXISTS extracted_items (
    id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id         BIGINT UNSIGNED NOT NULL,
    session_id        BIGINT UNSIGNED NOT NULL,
    sequence_index    INT             NOT NULL,
    content_html      MEDIUMTEXT      NOT NULL,
    content_plain     MEDIUMTEXT      NULL,
    question_type     VARCHAR(50)     NULL,
    confidence        DECIMAL(5,2)    NULL,
    created_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_items_tenant (tenant_id),
    KEY idx_items_session (session_id),
    CONSTRAINT fk_items_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT fk_items_session FOREIGN KEY (session_id) REFERENCES extraction_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
