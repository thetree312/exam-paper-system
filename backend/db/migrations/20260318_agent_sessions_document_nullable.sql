-- 2026-03-18: allow agent session without bound studio document
-- Scenario: user enters workroom and chats before any studio document exists.
-- We keep workroom_id + view_id + user scoping, so document_id can be NULL.

BEGIN;

ALTER TABLE agent_sessions
    ALTER COLUMN document_id DROP NOT NULL;

COMMIT;

