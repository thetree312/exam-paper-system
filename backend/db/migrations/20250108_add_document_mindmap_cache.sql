-- Add mind map cache fields to documents table
ALTER TABLE documents
  ADD COLUMN mindmap_cache LONGTEXT NULL,
  ADD COLUMN mindmap_generated_at DATETIME NULL;
