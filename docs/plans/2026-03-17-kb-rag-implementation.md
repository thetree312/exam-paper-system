# KB RAG Rebuild Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild the preview-backed RAG knowledge base for PDF, Word, and image sources using existing PostgreSQL `kb_*` tables and a single multimodal embedding model.

**Architecture:** Keep the current preview flow unchanged while rebuilding a dedicated `app.services.kb` module for ingest, retrieval, and page-bundle output. Reuse existing preview assets and `fulltext_blocks`, then expose retrieval to the agent as structured page bundles.

**Tech Stack:** FastAPI, SQLAlchemy, PostgreSQL, pgvector, Celery/task orchestration, PyMuPDF, python-docx, existing Qwen embedding client.

---

### Task 1: Rebuild KB module foundation

**Files:**
- Create: `backend/app/services/kb/__init__.py`
- Create: `backend/app/services/kb/types.py`
- Create: `backend/app/services/kb/repository.py`
- Create: `backend/app/services/kb/rate_limiter.py`
- Create: `backend/tests/services/test_kb_repository.py`

**Steps:**
1. Write failing tests for source upsert, chunk insert, and page metadata writes.
2. Run the new tests and verify failure because module files do not exist.
3. Implement typed contracts and repository functions against existing `kb_*` tables.
4. Run repository tests and fix SQL/typing issues.
5. Commit.

### Task 2: Rebuild chunk builders

**Files:**
- Create: `backend/app/services/kb/chunk_builders.py`
- Modify: `backend/tests/services/test_kb_chunk_builders.py`
- Create: `backend/tests/services/test_kb_page_image_builders.py`

**Steps:**
1. Extend tests to cover text chunking, page-image chunk creation, content hashes, and metadata shape.
2. Run tests to verify failure.
3. Implement chunk builder helpers with deterministic hashes and page-aware metadata.
4. Run tests to verify pass.
5. Commit.

### Task 3: Rebuild extractors

**Files:**
- Create: `backend/app/services/kb/extractors/__init__.py`
- Create: `backend/app/services/kb/extractors/pdf_extractor.py`
- Create: `backend/app/services/kb/extractors/word_extractor.py`
- Create: `backend/app/services/kb/extractors/image_extractor.py`
- Create: `backend/tests/services/test_kb_extractors.py`

**Steps:**
1. Write failing tests for PDF text extraction, Word paragraph/table extraction, and image preview-only extraction.
2. Run extractor tests and verify failure.
3. Implement extractors, reusing existing preview assets and `FulltextService` behavior where possible.
4. Run tests and verify pass.
5. Commit.

### Task 4: Rebuild embedding and limiter layer

**Files:**
- Create: `backend/app/services/kb/embedding_service.py`
- Modify: `backend/tests/services/test_qwen_embedding_client.py`
- Create: `backend/tests/services/test_kb_embedding_service.py`

**Steps:**
1. Write failing tests for batched text/image embedding requests and limiter behavior.
2. Run tests to verify failure.
3. Implement a KB embedding wrapper around `QwenEmbeddingClient` with bounded batching and limiter hooks.
4. Run tests and verify pass.
5. Commit.

### Task 5: Rebuild ingest orchestration

**Files:**
- Create: `backend/app/services/kb/ingest_service.py`
- Create: `backend/tests/services/test_kb_ingest_service.py`

**Steps:**
1. Write failing tests for ingesting PDF, Word, and image files into `kb_sources`, `kb_source_pages`, `kb_chunks`, and `kb_chunk_embeddings`.
2. Run tests to verify failure.
3. Implement end-to-end ingest orchestration with idempotent writes and job-state transitions.
4. Run tests and verify pass.
5. Commit.

### Task 6: Rebuild retrieval and dynamic weighting

**Files:**
- Create: `backend/app/services/kb/query_intent.py`
- Create: `backend/app/services/kb/retrieval_service.py`
- Modify: `backend/tests/services/test_rag_service.py`

**Steps:**
1. Write failing tests for dynamic text/image weighting and page bundle grouping.
2. Run tests to verify failure.
3. Implement retrieval queries against `kb_chunk_embeddings` and page-bundle assembly.
4. Run tests and verify pass.
5. Commit.

### Task 7: Integrate ingest with file source binding

**Files:**
- Modify: `backend/app/routers/files.py`
- Modify: `backend/app/tasks.py`
- Create: `backend/tests/services/test_kb_upload_integration.py`

**Steps:**
1. Write failing tests for upload completion triggering a KB ingest job behind the existing preview flow.
2. Run tests to verify failure.
3. Implement post-upload KB scheduling without changing preview behavior.
4. Run tests and verify pass.
5. Commit.

### Task 8: Integrate retrieval into agent flow

**Files:**
- Modify: `backend/app/agent/tools/knowledge_evidence.py`
- Modify: `backend/app/agent/router.py`
- Create: `backend/tests/assistant_graph/test_kb_page_bundle_retrieval.py`

**Steps:**
1. Write failing tests showing agent retrieval returns same-page image support from KB bundles.
2. Run tests to verify failure.
3. Integrate retrieval service into the agent knowledge path.
4. Run tests and verify pass.
5. Commit.

### Task 9: Verification

**Files:**
- Modify as needed from previous tasks only.

**Steps:**
1. Run targeted service tests.
2. Run targeted assistant graph tests.
3. Run `python -m compileall backend/app backend/main.py`.
4. Fix remaining issues.
5. Summarize residual risks and operational tuning needs.
