# GLM Layout KB Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild document ingestion so uploaded sources can be parsed into page-level GLM layout blocks before KB embedding, while preserving existing preview UX, existing page/text-image binding semantics, and a zero-refactor switch from local base64 transport to production short URLs.

**Architecture:** Keep the current upload -> preview -> KB pipeline, but split ingestion into explicit stages: preview generation, page-layout parsing, block materialization, and embedding. Introduce a shared asset-reference abstraction plus a GLM page-layout cache/job layer so both KB ingestion and the existing question-card OCR pipeline can reuse the same page-level layout output. Enforce a global GLM concurrency gate of `2`, and resolve image transport lazily at model-call time so local development can use base64 while production can switch to HTTP/HTTPS URLs without schema or business-logic changes.

**Tech Stack:** FastAPI, Celery, PostgreSQL, SQLAlchemy, Redis, PyMuPDF, PIL, existing GLM-OCR API client, pgvector.

---

## 1. Requirements Summary

### Functional

- Preserve current upload and preview behavior in [backend/app/routers/files.py](/D:/Exam-paper/backend/app/routers/files.py).
- Preserve current KB retrieval semantics that bind text and image evidence by page/unit in [backend/app/services/kb/rag_service.py](/D:/Exam-paper/backend/app/services/kb/rag_service.py).
- Add GLM-based page-layout parsing before final KB embedding for supported sources.
- Reuse the same page-layout cache for KB and future reuse by the GLM question-card pipeline in [backend/app/glm_ocr/service.py](/D:/Exam-paper/backend/app/glm_ocr/service.py).
- Store asset references, not base64 payloads, in DB.
- Resolve model-facing image transport lazily so local dev can emit `data:image/...` while production can emit short HTTP URLs.

### Non-Functional

- Respect GLM platform concurrency limit `2`.
- Avoid repeated GLM calls for the same file/page/model/schema-version.
- Avoid full-document base64 upload when preview page images already exist.
- Keep degraded mode available: preview and page-level KB stay usable if GLM is backlogged or fails.
- Keep schema backward-compatible with current KB reads.

### Constraints

- Real DB already contains `file_ocr_cache`, `kb_sources`, `kb_source_pages`, `kb_chunks`, `kb_chunk_embeddings`, `kb_ingest_jobs`, `kb_units`, `kb_unit_embeddings`.
- Current `file_ocr_cache` only supports completed-result caching, not in-flight leasing.
- Current upload flow creates duplicate `files` rows for identical `content_hash`; do not assume file-level dedupe exists.
- Current embedding path already lazily converts local image refs to base64 in [backend/app/services/qwen_client.py](/D:/Exam-paper/backend/app/services/qwen_client.py).

## 2. High-Level Architecture

```text
upload request
  -> files + extraction_sessions
  -> preview_queue
     -> preview PNG/JPEG generation
     -> session.preview_ready
     -> orchestrator_queue
        -> decide if GLM page-layout is needed
        -> enqueue page_layout jobs per page
           -> acquire global GLM semaphore (max=2)
           -> resolve page asset transport URL/base64
           -> call GLM layout_parsing on page image
           -> store page-layout cache + block manifests
        -> materialize KB layout units/chunks
        -> embed_queue
           -> embedding service
           -> kb_* writes
```

## 3. Key Decisions

### ADR-1: Use page-image GLM parsing, not full-document GLM parsing

- Decision: Parse preview page images one page at a time instead of sending the full PDF/Word document to GLM.
- Why:
  - Matches official optimization guidance to prefer image-based calls and page splitting for faster processing.
  - Avoids repeated full-document base64 payload creation.
  - Makes retry and cache granularity page-level.
- Trade-off:
  - More task orchestration.
  - Need explicit page-level cache schema.

### ADR-2: Preserve page/unit binding, add block-level relations under it

- Decision: Keep current page bundle and unit semantics, then add block-level binding keys and relation metadata under those units.
- Why:
  - Current retrieval already depends on page/unit binding rather than free-floating image chunks.
  - Minimizes retrieval regressions.
- Trade-off:
  - First version block relationships stay heuristic rather than fully semantic.

### ADR-3: Store `asset_ref`, resolve transport lazily

- Decision: Persist only stable asset references in DB, and compute model-facing `data:image/...` or `https://...` at call time.
- Why:
  - Eliminates base64 storage blow-up.
  - Gives zero-business-logic migration path from local base64 to production short URLs.
- Trade-off:
  - Requires a centralized resolver abstraction.

### ADR-4: Separate GLM orchestration from KB embedding

- Decision: Add explicit GLM layout job stages instead of burying GLM calls inside `KBIngestService`.
- Why:
  - Existing `kb_ingest_jobs` only tracks `ingest`.
  - Platform concurrency limit `2` requires separate queueing and state.
- Trade-off:
  - More state-machine code.

## 4. Data Model Changes

### 4.1 Add page-layout cache/job table

Create a new table `file_page_layout_cache` instead of overloading `file_ocr_cache`.

Reason:
- `file_ocr_cache` is document-level and active-version based.
- New work is page-level and needs in-flight lease semantics.

Suggested columns:
- `id`
- `tenant_id`
- `file_id`
- `content_hash`
- `page_no`
- `model`
- `schema_version`
- `status` (`pending`, `running`, `completed`, `failed`)
- `lease_owner`
- `lease_expires_at`
- `request_started_at`
- `generated_at`
- `error`
- `source_asset_ref`
- `transport_kind` (`data_url`, `http_url`)
- `layout_json`
- `blocks_json`
- `created_at`
- `updated_at`

Indexes:
- unique active identity on `(tenant_id, content_hash, page_no, model, schema_version)`
- lookup by `(file_id, page_no)`
- lookup by `(status, lease_expires_at)`

### 4.2 Add KB block relation support

Prefer extending `kb_units`/`kb_chunks` metadata instead of creating brand-new top-level relation tables in v1.

Add metadata fields in `metadata_json`:
- `asset_ref`
- `layout_unit_key`
- `parent_unit_key`
- `relation_type`
- `block_label`
- `bbox_norm`
- `bbox_abs`
- `layout_page_cache_id`
- `transport_version`

### 4.3 Extend `kb_ingest_jobs`

Do not replace the table. Reuse `stage`.

New stages:
- `preview`
- `layout_schedule`
- `layout_parse`
- `layout_materialize`
- `embed`

## 5. File And Module Plan

### Task 1: Add the new DB schema for page-layout cache

**Files:**
- Create: `backend/db/migrations/20260328_add_file_page_layout_cache.sql`
- Modify: [backend/app/models.py](/D:/Exam-paper/backend/app/models.py)
- Test: `backend/tests/services/test_page_layout_cache_manager.py`

**Step 1: Write the failing test**

Add tests for:
- unique identity by `tenant_id + content_hash + page_no + model + schema_version`
- lease acquisition
- completed-result reuse

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_page_layout_cache_manager.py -v`

**Step 3: Write minimal implementation**

- Add ORM model `FilePageLayoutCache`
- Add migration SQL

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_page_layout_cache_manager.py -v`

**Step 5: Commit**

`git commit -m "feat: add page-level GLM layout cache table"`

### Task 2: Introduce a shared asset reference resolver

**Files:**
- Create: `backend/app/services/assets.py`
- Modify: [backend/app/services/qwen_client.py](/D:/Exam-paper/backend/app/services/qwen_client.py)
- Modify: [backend/app/agent/tools/knowledge_evidence.py](/D:/Exam-paper/backend/app/agent/tools/knowledge_evidence.py)
- Modify: [backend/app/glm_ocr/service.py](/D:/Exam-paper/backend/app/glm_ocr/service.py)
- Test: `backend/tests/services/test_asset_resolver.py`

**Step 1: Write the failing test**

Test matrix:
- local asset ref -> `data:image/...` in dev mode
- http URL asset ref -> passthrough
- future production mode -> short URL passthrough
- no DB/base64 persistence side effects

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_asset_resolver.py -v`

**Step 3: Write minimal implementation**

Add `AssetResolver` API:
- `resolve_for_model(asset_ref: str) -> str`
- `resolve_for_storage(asset_ref: str) -> Path | str`
- `build_public_url(asset_ref: str) -> str | None`

Config flags:
- `ASSET_TRANSPORT_MODE=base64|public_url|signed_url`
- `PUBLIC_ASSET_BASE_URL`

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_asset_resolver.py -v`

**Step 5: Commit**

`git commit -m "feat: add asset resolver for base64 and URL transport"`

### Task 3: Add page-layout cache manager with lease semantics

**Files:**
- Create: `backend/app/services/page_layout_cache_manager.py`
- Modify: [backend/app/models.py](/D:/Exam-paper/backend/app/models.py)
- Test: `backend/tests/services/test_page_layout_cache_manager.py`

**Step 1: Write the failing test**

Test:
- first worker acquires page lease
- second worker cannot acquire same page lease while live
- expired lease can be reclaimed
- completed page cache is reusable

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_page_layout_cache_manager.py -v`

**Step 3: Write minimal implementation**

Methods:
- `get_completed(...)`
- `try_acquire(...)`
- `mark_completed(...)`
- `mark_failed(...)`

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_page_layout_cache_manager.py -v`

**Step 5: Commit**

`git commit -m "feat: add page-layout cache manager with leasing"`

### Task 4: Split preview-stage and GLM-stage orchestration

**Files:**
- Modify: [backend/app/tasks.py](/D:/Exam-paper/backend/app/tasks.py)
- Modify: [backend/app/celery_app.py](/D:/Exam-paper/backend/app/celery_app.py)
- Modify: [backend/app/config.py](/D:/Exam-paper/backend/app/config.py)
- Test: `backend/tests/services/test_ingestion_orchestration.py`

**Step 1: Write the failing test**

Test expected flow:
- preview task does not call GLM directly
- preview completion enqueues orchestrator
- orchestrator emits page-layout jobs
- `kb_ingest_jobs.stage` reflects stage transitions

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_ingestion_orchestration.py -v`

**Step 3: Write minimal implementation**

Add tasks:
- `schedule_layout_for_file`
- `parse_layout_for_page`
- `materialize_kb_for_file`

Queues:
- `exam_preview`
- `exam_glm_layout`
- `exam_embed`

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_ingestion_orchestration.py -v`

**Step 5: Commit**

`git commit -m "feat: split preview, layout, and embed orchestration"`

### Task 5: Add a global GLM concurrency gate

**Files:**
- Create: `backend/app/services/glm_rate_limiter.py`
- Modify: [backend/app/tasks.py](/D:/Exam-paper/backend/app/tasks.py)
- Modify: [backend/app/config.py](/D:/Exam-paper/backend/app/config.py)
- Test: `backend/tests/services/test_glm_rate_limiter.py`

**Step 1: Write the failing test**

Test:
- max concurrent leases = 2
- blocked jobs do not call GLM
- lease release on success and failure

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_glm_rate_limiter.py -v`

**Step 3: Write minimal implementation**

Use Redis-backed semaphore, not process-local lock.

Config:
- `GLM_LAYOUT_MAX_CONCURRENCY=2`
- `GLM_LAYOUT_LEASE_SECONDS=180`

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_glm_rate_limiter.py -v`

**Step 5: Commit**

`git commit -m "feat: enforce global GLM layout concurrency limit"`

### Task 6: Implement page-image GLM parsing service

**Files:**
- Create: `backend/app/services/page_layout_service.py`
- Modify: [backend/app/glm_ocr/service.py](/D:/Exam-paper/backend/app/glm_ocr/service.py)
- Test: `backend/tests/services/test_page_layout_service.py`

**Step 1: Write the failing test**

Test:
- takes page image asset ref, not whole document
- resolves transport lazily
- normalizes `bbox_norm` and `bbox_abs`
- materializes block manifests with stable keys

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_page_layout_service.py -v`

**Step 3: Write minimal implementation**

Add methods:
- `parse_page(...)`
- `normalize_block(...)`
- `build_block_asset_ref(...)`

Block manifest shape:
- `layout_unit_key`
- `block_label`
- `bbox_norm`
- `bbox_abs`
- `content`
- `crop_asset_ref`

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_page_layout_service.py -v`

**Step 5: Commit**

`git commit -m "feat: add page-image GLM layout parser"`

### Task 7: Persist crops as asset refs, not data URLs

**Files:**
- Modify: [backend/app/glm_ocr/service.py](/D:/Exam-paper/backend/app/glm_ocr/service.py)
- Modify: [backend/app/glm_ocr/router.py](/D:/Exam-paper/backend/app/glm_ocr/router.py)
- Test: `backend/tests/services/test_glm_crop_persistence.py`

**Step 1: Write the failing test**

Test:
- crop materialization writes image file
- DB metadata stores routeable asset ref
- no crop base64 is persisted

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_glm_crop_persistence.py -v`

**Step 3: Write minimal implementation**

Replace direct `_crop_block_to_data_url()` usage in KB path with persisted crop refs.
Keep question-card path compatible by allowing it to still request inline transport through `AssetResolver`.

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_glm_crop_persistence.py -v`

**Step 5: Commit**

`git commit -m "feat: persist GLM crops as asset refs"`

### Task 8: Materialize layout blocks into KB rows while preserving bindings

**Files:**
- Modify: [backend/app/services/kb/chunk_builders.py](/D:/Exam-paper/backend/app/services/kb/chunk_builders.py)
- Modify: [backend/app/services/kb/types.py](/D:/Exam-paper/backend/app/services/kb/types.py)
- Modify: [backend/app/services/kb/ingest_service.py](/D:/Exam-paper/backend/app/services/kb/ingest_service.py)
- Modify: [backend/app/services/kb/repository.py](/D:/Exam-paper/backend/app/services/kb/repository.py)
- Test: `backend/tests/services/test_kb_layout_block_builders.py`

**Step 1: Write the failing test**

Test:
- page-level unit remains intact
- block-level units/chunks are emitted under same page
- image block and neighboring text block share `layout_unit_key` or `parent_unit_key`
- page bundle output still groups correctly

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_kb_layout_block_builders.py -v`

**Step 3: Write minimal implementation**

Add new chunk/unit kinds:
- `layout_text`
- `layout_table`
- `layout_formula`
- `layout_image`

Preserve:
- `page_image`
- page-level `unit_type='page'`

Metadata must include:
- `layout_unit_key`
- `parent_unit_key`
- `relation_type`
- `asset_ref`

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_kb_layout_block_builders.py -v`

**Step 5: Commit**

`git commit -m "feat: materialize GLM layout blocks into KB rows"`

### Task 9: Update retrieval to prefer block evidence while preserving page bundles

**Files:**
- Modify: [backend/app/services/kb/rag_service.py](/D:/Exam-paper/backend/app/services/kb/rag_service.py)
- Test: `backend/tests/services/test_rag_service.py`

**Step 1: Write the failing test**

Test cases:
- block text hit returns related image block and parent page image
- page bundle still contains `text_chunks + primary_image`
- image-only hit can still recover parent text block or parent unit

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_rag_service.py -v`

**Step 3: Write minimal implementation**

Retrieval order:
- fetch block/unit candidates
- expand via `layout_unit_key/parent_unit_key`
- assemble final response as:
  - related text blocks
  - related image blocks
  - fallback page image

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_rag_service.py -v`

**Step 5: Commit**

`git commit -m "feat: bind layout blocks in KB retrieval"`

### Task 10: Add state exposure for frontend and operators

**Files:**
- Modify: [backend/app/routers/files.py](/D:/Exam-paper/backend/app/routers/files.py)
- Modify: `backend/app/schemas.py`
- Test: `backend/tests/services/test_file_session_status.py`

**Step 1: Write the failing test**

Test status progression:
- `pending`
- `processing`
- `preview_ready`
- `layout_running`
- `kb_ready`
- `degraded_ready`
- `failed`

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_file_session_status.py -v`

**Step 3: Write minimal implementation**

Expose derived ingestion state without breaking current callers.

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_file_session_status.py -v`

**Step 5: Commit**

`git commit -m "feat: expose staged ingestion status"`

### Task 11: Add migration-safe transport switching for production

**Files:**
- Modify: [backend/app/services/assets.py](/D:/Exam-paper/backend/app/services/assets.py)
- Modify: [backend/app/config.py](/D:/Exam-paper/backend/app/config.py)
- Test: `backend/tests/services/test_asset_resolver.py`

**Step 1: Write the failing test**

Test config switch:
- base64 mode works with local files
- public URL mode returns `https://...`
- no DB data rewrite required

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_asset_resolver.py -v`

**Step 3: Write minimal implementation**

Support:
- `ASSET_TRANSPORT_MODE=base64`
- `ASSET_TRANSPORT_MODE=public_url`
- `PUBLIC_ASSET_BASE_URL=https://cdn.example.com`

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_asset_resolver.py -v`

**Step 5: Commit**

`git commit -m "feat: support URL-based image transport without DB migration"`

### Task 12: Backfill and verification

**Files:**
- Create: `backend/scripts/backfill_page_layout_cache.py`
- Create: `backend/scripts/backfill_kb_layout_blocks.py`
- Modify: `backend/DEV_NOTES.md`
- Test: `backend/tests/services/test_backfill_scripts.py`

**Step 1: Write the failing test**

Test:
- backfill skips already completed cache rows
- backfill reuses existing preview assets
- backfill is idempotent

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_backfill_scripts.py -v`

**Step 3: Write minimal implementation**

Backfill order:
- identify eligible files by `content_hash`
- populate page-layout cache
- materialize KB layout blocks

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_backfill_scripts.py -v`

**Step 5: Commit**

`git commit -m "feat: add backfill scripts for page-layout cache and KB blocks"`

## 6. Performance Strategy

- Use preview page images as GLM inputs instead of full documents.
- Add a lightweight GLM transport derivative per page:
  - `pageX.glm.jpg`
  - optional cached `pageX.glm.json`
- Never store base64 in DB.
- Only resolve base64 or URL at model boundary.
- Enforce GLM global concurrency `2`.
- Use page-level cache identity so repeated uploads with same `content_hash` can reuse work.
- Keep embedding on a separate queue from GLM.

## 7. Failure Modes And Mitigations

- Duplicate uploads with same content hash:
  - mitigated by page-layout cache identity and leases
- GLM 429 / provider outage:
  - keep preview + page-level KB as degraded mode
- Crop or bbox mismatch:
  - keep full page image fallback in retrieval
- Production asset hosting not ready:
  - default resolver remains `base64`
- Relation heuristics wrong:
  - page-level bundle remains source of truth fallback

## 8. Verification Commands

- `pytest backend/tests/services/test_page_layout_cache_manager.py -v`
- `pytest backend/tests/services/test_asset_resolver.py -v`
- `pytest backend/tests/services/test_glm_rate_limiter.py -v`
- `pytest backend/tests/services/test_page_layout_service.py -v`
- `pytest backend/tests/services/test_kb_layout_block_builders.py -v`
- `pytest backend/tests/services/test_rag_service.py -v`
- `pytest backend/tests/services/test_file_session_status.py -v`
- `pytest backend/tests/services/test_backfill_scripts.py -v`

## 9. Rollout Plan

1. Ship schema and resolver first behind flags.
2. Enable page-layout cache + leasing with GLM tasks disabled.
3. Enable GLM page parsing for image uploads only.
4. Enable GLM page parsing for small PDFs.
5. Enable full retrieval binding logic.
6. Run backfill for selected high-value files.
7. Switch production transport mode to `public_url` when static hosting is available.

## 10. Open Questions

- Should page-layout cache identity include `preview_render_version` in addition to `schema_version`?
- Do we need a separate relation table in v2 if page-internal heuristics prove too weak?
- Should repeated `files` rows with same `content_hash` eventually be deduped at upload time, or is cache-level reuse sufficient?

