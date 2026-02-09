-- Add canonical answer fields for questions to support flashcards and unified answer handling
ALTER TABLE questions
    ADD COLUMN IF NOT EXISTS canonical_answer TEXT NULL,
    ADD COLUMN IF NOT EXISTS answer_status VARCHAR(32) NULL,
    ADD COLUMN IF NOT EXISTS answer_source VARCHAR(32) NULL;
