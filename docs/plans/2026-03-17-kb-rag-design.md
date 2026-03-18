# Preview-Backed RAG Knowledge Base Design

## Goal

Upgrade the backend behind the existing left preview pane so uploaded PDF, Word, and image files are ingested into the RAG knowledge base, while the frontend preview behavior remains unchanged.

The preview pane stays a preview pane in UI terms. The backend changes its semantics from "preview-only source" to "knowledge-backed source". Agent retrieval must be able to infer and return the correct preview page image for a query without relying on the existing OCR service.

## Constraints

- Supported source types in this phase: PDF, Word, image.
- Do not modify current preview UX or polling flow.
- Do not use the current OCR service for knowledge-base ingestion.
- Document processing must use Python libraries and existing preview assets.
- Use PostgreSQL + pgvector only.
- Use a single embedding model only: `tongyi-embedding-vision-flash`.
- Code must be modular and maintainable, not scattered across existing router files.

## Existing Assets To Reuse

- Existing upload and preview pipeline in [backend/app/routers/files.py](/D:/Exam-paper/backend/app/routers/files.py).
- Existing text extraction cache in [backend/app/services/fulltext_service.py](/D:/Exam-paper/backend/app/services/fulltext_service.py).
- Existing database tables:
  - `kb_sources`
  - `kb_source_pages`
  - `kb_chunks`
  - `kb_chunk_embeddings`
  - `kb_ingest_jobs`
  - `workroom_source_bindings`
  - `files`
  - `fulltext_blocks`
- Existing embedding client in [backend/app/services/qwen_client.py](/D:/Exam-paper/backend/app/services/qwen_client.py).

## Architecture

### 1. Separation Of Concerns

Create a dedicated knowledge-base module under `backend/app/services/kb/` with these responsibilities:

- `types.py`: typed dataclasses and payload contracts.
- `repository.py`: all reads and writes to `kb_*` tables.
- `chunk_builders.py`: deterministic text chunk and page-image row generation.
- `extractors/`: source-specific extraction for PDF, Word, image.
- `embedding_service.py`: normalized calls to `QwenEmbeddingClient`.
- `rate_limiter.py`: global RPM and TPM enforcement for embedding traffic.
- `ingest_service.py`: orchestration for one source ingest job.
- `retrieval_service.py`: retrieval, dynamic weighting, and page bundle assembly.
- `query_intent.py` or `reranker.py`: text/image weighting heuristics.

Routers and agent code call the KB services. They must not own KB SQL or embedding logic.

### 2. Data Model Usage

Reuse current `kb_*` tables instead of inventing a second schema.

- `kb_sources`: one logical knowledge source per uploaded file bound to a workroom.
- `kb_source_pages`: page-level preview linkage and lightweight page summaries.
- `kb_chunks`: both text chunks and page-image chunks live here.
- `kb_chunk_embeddings`: vector rows for both text and image chunks.
- `kb_ingest_jobs`: async ingest status, retries, and error recording.

Required chunk conventions:

- `chunk_type='fulltext'` for text blocks.
- `chunk_type='page_image'` for whole-page preview image records.
- `metadata_json.modality` is `text` or `image`.
- `page_no` is mandatory whenever the source has page semantics.

### 3. Ingest Pipeline

The upload flow remains unchanged. Knowledge-base ingest is attached behind it.

Pipeline per source:

1. Resolve or create `kb_source`.
2. Read source metadata from `files`.
3. Extract text with Python libraries only.
4. Discover or reuse existing preview page images.
5. Build deterministic text chunks and page-image chunks.
6. Deduplicate by content hash and source version.
7. Embed with model-rate limiting.
8. Persist chunks, embeddings, and page metadata.
9. Mark `kb_ingest_jobs` complete or failed.

Source rules:

- PDF:
  - Extract text using PyMuPDF.
  - Reuse existing preview PNG pages.
  - Create text chunks and one `page_image` chunk per preview page.
- Word:
  - Extract paragraphs and tables using `python-docx`.
  - Reuse existing preview assets if available from the current preview pipeline.
  - If no page-aligned preview exists, still ingest text chunks and mark missing page-image coverage in metadata.
- Image:
  - No OCR.
  - Create one `page_image` chunk for the whole image.
  - Optional `preview_text` remains empty unless local non-OCR metadata extraction exists.

### 4. Retrieval Model

Retrieval returns page bundles, not raw chunk lists.

Flow:

1. Embed the query once using `tongyi-embedding-vision-flash`.
2. Search text lane and image lane separately in `kb_chunk_embeddings`.
3. Dynamically weight lanes based on query intent.
4. Merge by `file_id + page_no`.
5. Assemble a page bundle:
   - `file_id`
   - `source_id`
   - `page_no`
   - `text_chunks`
   - `primary_image`
   - `preview_image_path`
   - `source_refs`

Dynamic weighting policy:

- Default: text-priority with image support.
- Increase image weight for queries containing terms such as:
  - 图
  - 图表
  - 曲线
  - 坐标
  - 示意图
  - 截图
  - 第X页图
  - 看这页图

This meets the product goal: the agent can infer which preview page image to send based on retrieved context and page grouping.

## Performance And Concurrency

### Embedding Limits

Target model limits from current provider settings:

- RPM: 600
- TPM: 200000

Engineering response:

- Global embedding limiter, not per-request local throttling.
- Enforce both request budget and token budget.
- Queue work rather than burst into 429.
- Exponential backoff on 429/5xx.
- Reject oversized single text inputs before request construction.

### Work Partitioning

- File-level ingest concurrency: bounded.
- Source-internal extraction concurrency: low.
- Embedding concurrency: separately bounded by limiter.

Recommended initial settings:

- `INGEST_MAX_FILE_CONCURRENCY = 3`
- `INGEST_MAX_EMBED_CONCURRENCY = 4`
- `INGEST_EMBED_BATCH_SIZE_TEXT = 10`
- `INGEST_EMBED_BATCH_SIZE_IMAGE = 4`

### IO Strategy

- Reuse existing preview files instead of regenerating them.
- Reuse `fulltext_blocks` if already extracted.
- Avoid rereading the same file more than once per ingest version.
- Use batching for DB writes.

### Database Performance

- Bulk insert `kb_chunks`.
- Bulk insert `kb_chunk_embeddings`.
- Add or verify vector ANN indexes on `kb_chunk_embeddings.embedding`.
- Scope every query by tenant and relevant source bindings first.

## Failure Modes

- Missing preview pages for Word:
  - Do not fail the whole source.
  - Ingest text lane and mark degraded image coverage.
- Empty text extraction:
  - Still ingest page-image chunks if previews exist.
- Embedding throttled:
  - Keep job in retryable embedding state.
- Duplicate source reingest:
  - Compare `content_hash` and version before reinserting.

## Testing Strategy

- Unit tests for chunk builders.
- Unit tests for PDF/Word/image extractors.
- Unit tests for retrieval weighting.
- Unit tests for page bundle grouping.
- Repository tests for idempotent writes.
- Integration tests for upload-to-kb-source binding.
- Agent-facing tests to verify retrieval returns same-page image support.

## Delivery Phases

1. KB module foundation and repository.
2. Ingest pipeline for PDF, Word, image.
3. Retrieval service and page bundles.
4. Agent integration.
5. Operational tuning and verification.
