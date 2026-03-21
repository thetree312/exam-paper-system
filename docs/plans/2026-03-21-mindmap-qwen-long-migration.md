# Mindmap Qwen-Long Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate mindmap generation from `qwen-flash` text snippets to `qwen-long` file-backed document understanding, while keeping the SaaS application’s own storage as the source of truth.

**Architecture:** The application will keep user files in its own storage and upload them to Bailian on demand through a backend-managed file cache layer. Mindmap generation will reuse cached Bailian `file_id`s when possible and call `qwen-long` with `fileid://...` references for both single-document and multi-document mindmaps.

**Tech Stack:** FastAPI, SQLAlchemy, PostgreSQL, DashScope OpenAI-compatible file API, Qwen-Long, existing `File` / `MindMap` domain models

---

### Task 1: Add persistent Bailian file registry

**Files:**
- Create: `backend/db/migrations/20260321_create_bailian_file_registry.sql`
- Modify: `backend/app/models.py`
- Test: `backend/tests/services/test_bailian_file_service.py`

**Step 1: Write the failing test**

Write a test that expects a persisted mapping record for one local file to contain:
- tenant scope
- local `file_id`
- `content_hash`
- Bailian `file_id`
- upload status / timestamps

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_bailian_file_service.py -v`
Expected: FAIL because model/table does not exist yet.

**Step 3: Write minimal implementation**

Add a new table/model:
- `bailian_file_registry`
- one row per locally stored file version
- no workroom-specific duplication

Suggested columns:
- `id`
- `tenant_id`
- `local_file_id`
- `provider`
- `purpose`
- `content_hash`
- `bailian_file_id`
- `status`
- `uploaded_at`
- `last_used_at`
- `deleted_at`
- `error_message`
- `created_at`
- `updated_at`

Constraints:
- unique `(tenant_id, local_file_id, provider, purpose, content_hash)`

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_bailian_file_service.py -v`
Expected: PASS for schema-level behavior.

**Step 5: Commit**

```bash
git add backend/db/migrations/20260321_create_bailian_file_registry.sql backend/app/models.py backend/tests/services/test_bailian_file_service.py
git commit -m "feat: add bailian file registry model"
```

### Task 2: Add DashScope file API support to the Qwen client

**Files:**
- Modify: `backend/app/config.py`
- Modify: `backend/app/services/qwen_client.py`
- Test: `backend/tests/services/test_qwen_client_files.py`

**Step 1: Write the failing test**

Write tests for:
- building the DashScope files endpoint URL
- producing `multipart/form-data` upload requests
- deleting / retrieving file metadata

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_qwen_client_files.py -v`
Expected: FAIL because file API methods do not exist.

**Step 3: Write minimal implementation**

Add:
- `ALIBABA_MODEL_QWEN_LONG` config
- `QwenClient.upload_file(path, purpose="file-extract")`
- `QwenClient.get_file(file_id)`
- `QwenClient.delete_file(file_id)`

Rules:
- backend only
- local file path input only
- no frontend exposure of Bailian credentials

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_qwen_client_files.py -v`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/config.py backend/app/services/qwen_client.py backend/tests/services/test_qwen_client_files.py
git commit -m "feat: add dashscope file api client methods"
```

### Task 3: Add backend Bailian file cache service

**Files:**
- Create: `backend/app/services/bailian_file_service.py`
- Test: `backend/tests/services/test_bailian_file_service.py`

**Step 1: Write the failing test**

Write tests for:
- reusing an existing active Bailian mapping when `content_hash` is unchanged
- uploading only when mapping is missing or stale
- resolving absolute local paths from `File.storage_path`

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_bailian_file_service.py -v`
Expected: FAIL because service does not exist.

**Step 3: Write minimal implementation**

Service behavior:
- take `tenant_id` + local `file_id`
- read local file record
- compute/confirm content hash
- look up an active Bailian mapping
- upload on demand
- persist returned `bailian_file_id`
- update `last_used_at`

Do not yet wire it into mindmap generation in this task.

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_bailian_file_service.py -v`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/services/bailian_file_service.py backend/tests/services/test_bailian_file_service.py
git commit -m "feat: add bailian file cache service"
```

### Task 4: Add qwen-long mindmap input contract

**Files:**
- Modify: `backend/app/services/mindmap/service.py`
- Modify: `backend/app/services/mindmap/generation.py`
- Test: `backend/tests/services/test_mindmap_service.py`

**Step 1: Write the failing test**

Write tests that expect the mindmap service to:
- choose `qwen-long` for file-backed generation
- build messages that reference `fileid://...`
- keep the draft/canonical pipeline unchanged after model output

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_mindmap_service.py -v`
Expected: FAIL because mindmap generation still consumes page snippets.

**Step 3: Write minimal implementation**

Change the file-backed generation path to:
- resolve or upload Bailian `file_id`
- send `fileid://...` to `qwen-long`
- preserve the existing `Draft -> Binding -> Canonical` stages

Fallback:
- keep the current block-based fallback only when file upload or `qwen-long` fails

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_mindmap_service.py -v`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/services/mindmap/service.py backend/app/services/mindmap/generation.py backend/tests/services/test_mindmap_service.py
git commit -m "feat: switch file-backed mindmap generation to qwen-long"
```

### Task 5: Add lifecycle and cleanup hooks

**Files:**
- Modify: `backend/app/services/bailian_file_service.py`
- Modify: `backend/app/routers/files.py`
- Test: `backend/tests/services/test_bailian_file_service.py`

**Step 1: Write the failing test**

Write tests that expect:
- deleting a local file can mark/delete its Bailian cache record
- stale Bailian mappings can be marked deleted without losing local source files

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_bailian_file_service.py -v`
Expected: FAIL because cleanup hooks do not exist.

**Step 3: Write minimal implementation**

Implement:
- registry status transitions
- best-effort remote delete
- safe fallback when remote file already does not exist

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_bailian_file_service.py -v`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/services/bailian_file_service.py backend/app/routers/files.py backend/tests/services/test_bailian_file_service.py
git commit -m "feat: add bailian file cleanup lifecycle"
```

Plan complete and saved to `docs/plans/2026-03-21-mindmap-qwen-long-migration.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

**Which approach?**
