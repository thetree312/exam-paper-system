# Semantic Group RAG Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild KB retrieval around semantic groups so multimodal evidence is ingested and retrieved as coherent document regions rather than isolated layout blocks.

**Architecture:** Keep `kb_chunks` as atomic OCR/layout blocks for citation and highlighting. Add `kb_semantic_groups` plus membership and embedding tables as the primary retrieval layer. Ingestion will build groups from structural layout signals, and retrieval will search groups first and expand back to member chunks for evidence packs.

**Tech Stack:** FastAPI backend, SQLAlchemy, PostgreSQL, pgvector, pytest

---

### Task 1: Add failing tests for semantic group building

**Files:**
- Modify: `backend/tests/services/test_kb_chunk_builders.py`

**Step 1: Write the failing test**

Add tests that assert:
- adjacent text + image + trailing text blocks on one page can be assembled into one semantic group
- a text block at page end and a continuation text block at next-page top can be assembled into one multi-page semantic group

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_kb_chunk_builders.py -q`
Expected: FAIL because semantic group builders do not exist yet.

**Step 3: Write minimal implementation**

Implement semantic-group builder dataclasses and builder functions in KB chunk builders.

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_kb_chunk_builders.py -q`
Expected: PASS

### Task 2: Add failing tests for ingest persistence of semantic groups

**Files:**
- Modify: `backend/tests/services/test_kb_ingest_service.py`

**Step 1: Write the failing test**

Add a test asserting `KBIngestService.ingest_file()` writes:
- chunk rows
- semantic group rows
- semantic group memberships
- semantic group embeddings

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_kb_ingest_service.py -q`
Expected: FAIL because repository calls do not exist yet.

**Step 3: Write minimal implementation**

Add repository and ingest-service methods for semantic groups and wire them into ingestion.

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_kb_ingest_service.py -q`
Expected: PASS

### Task 3: Add failing tests for semantic-group retrieval

**Files:**
- Modify: `backend/tests/services/test_rag_service.py`

**Step 1: Write the failing test**

Add tests asserting:
- group-first search returns semantic groups rather than isolated units
- expanding a matched group returns member chunks including related image members

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_rag_service.py -q`
Expected: FAIL because semantic-group retrieval methods do not exist yet.

**Step 3: Write minimal implementation**

Implement semantic-group search and expansion in `RAGService`.

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_rag_service.py -q`
Expected: PASS

### Task 4: Add failing tests for KB tool integration

**Files:**
- Modify: `backend/tests/services/test_knowledge_evidence.py`

**Step 1: Write the failing test**

Add tests asserting KB evidence/snippet tools:
- accept group refs
- expand group members into snippet/image evidence
- preserve chunk-level citation candidates

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_knowledge_evidence.py -q`
Expected: FAIL because tools still only understand unit/chunk refs.

**Step 3: Write minimal implementation**

Switch knowledge-evidence tools to semantic-group-first lookup with chunk-level citation output.

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_knowledge_evidence.py -q`
Expected: PASS

### Task 5: Add schema and repository support

**Files:**
- Create: `backend/db/migrations/20260329_add_kb_semantic_groups.sql`
- Modify: `backend/app/services/kb/types.py`
- Modify: `backend/app/services/kb/repository.py`

**Steps**
- add schema for semantic groups, memberships, and embeddings
- add dataclasses for group rows and memberships
- add repository replace/get methods for groups and expanded members

### Task 6: Implement group building and retrieval cutover

**Files:**
- Modify: `backend/app/services/kb/chunk_builders.py`
- Modify: `backend/app/services/kb/ingest_service.py`
- Modify: `backend/app/services/kb/rag_service.py`
- Modify: `backend/app/agent/tools/knowledge_evidence.py`

**Steps**
- build semantic groups from layout/text chunks using structural grouping
- persist groups and embeddings during ingestion
- switch candidate search/read flows to semantic groups
- keep chunk-level anchors for citations and preview/highlighting

### Task 7: Verify end-to-end behavior

**Files:**
- Reuse tests above

**Steps**
- run focused pytest suite
- inspect failures
- report exact status with evidence
