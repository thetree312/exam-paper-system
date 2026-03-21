CREATE TABLE IF NOT EXISTS bailian_file_registry (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  local_file_id BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  provider VARCHAR(32) NOT NULL DEFAULT 'dashscope',
  purpose VARCHAR(64) NOT NULL DEFAULT 'file-extract',
  content_hash VARCHAR(64) NOT NULL,
  bailian_file_id VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  uploaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP NULL,
  error_message TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_bailian_file_registry_scope
  ON bailian_file_registry (tenant_id, local_file_id, provider, purpose, content_hash);

CREATE INDEX IF NOT EXISTS idx_bailian_file_registry_active
  ON bailian_file_registry (tenant_id, local_file_id, status, last_used_at);
