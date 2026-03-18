-- RAG multimodal: page_image chunk may not have a textual block index.
-- Make kb_chunks.block_index nullable to align schema with current chunk model.

ALTER TABLE kb_chunks
    ALTER COLUMN block_index DROP NOT NULL;

