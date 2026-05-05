ALTER TABLE studio_question_cards
    ADD COLUMN IF NOT EXISTS answer_content_json JSON NULL;

UPDATE studio_question_cards
SET answer_content_json = JSON_OBJECT(
    'version', 1,
    'kind', 'document',
    'blocks', JSON_ARRAY(
        JSON_OBJECT(
            'kind', 'paragraph',
            'children', JSON_ARRAY(
                JSON_OBJECT(
                    'kind', 'text',
                    'text', COALESCE(answer_text, '')
                )
            )
        )
    )
)
WHERE answer_content_json IS NULL;
