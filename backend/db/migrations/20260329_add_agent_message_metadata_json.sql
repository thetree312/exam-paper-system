ALTER TABLE agent_messages
    ADD COLUMN IF NOT EXISTS metadata_json JSON NULL;
