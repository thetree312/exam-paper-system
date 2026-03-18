DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'workroom_runtime_states'
          AND column_name = 'active_workspace_document_id'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'workroom_runtime_states'
          AND column_name = 'active_studio_document_id'
    ) THEN
        ALTER TABLE workroom_runtime_states
            RENAME COLUMN active_workspace_document_id TO active_studio_document_id;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'workroom_panel_artifacts'
          AND column_name = 'workspace_document_id'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'workroom_panel_artifacts'
          AND column_name = 'studio_document_id'
    ) THEN
        ALTER TABLE workroom_panel_artifacts
            RENAME COLUMN workspace_document_id TO studio_document_id;
    END IF;
END $$;
