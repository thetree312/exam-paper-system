-- Retire legacy KB retrieval tables after evidence-graph migration.
-- This is intentionally destructive and should run only after code no longer depends on these tables.

DROP TABLE IF EXISTS kb_semantic_group_embeddings;
DROP TABLE IF EXISTS kb_semantic_group_members;
DROP TABLE IF EXISTS kb_semantic_groups;
DROP TABLE IF EXISTS kb_unit_embeddings;
DROP TABLE IF EXISTS kb_units;
DROP TABLE IF EXISTS kb_chunk_embeddings;
DROP TABLE IF EXISTS kb_chunks;
