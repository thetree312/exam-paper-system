CREATE TABLE IF NOT EXISTS workspaces (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    name VARCHAR(255) NOT NULL,
    topic VARCHAR(255) NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE workrooms
    ADD COLUMN IF NOT EXISTS workspace_id BIGINT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_name = 'workrooms'
          AND constraint_name = 'fk_workrooms_workspace_id'
    ) THEN
        ALTER TABLE workrooms
            ADD CONSTRAINT fk_workrooms_workspace_id
            FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
            ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_workspaces_tenant_user_updated
    ON workspaces (tenant_id, user_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_workrooms_workspace_id
    ON workrooms (workspace_id);
