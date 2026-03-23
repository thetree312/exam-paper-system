# Mindmap Quality Rebuild Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement Phase 1 of the mindmap quality rebuild: add user-selectable mindmap mode, carry it through the request path, and replace the single-pass single-document generator with a two-stage outline-to-mindmap pipeline.

**Architecture:** Keep the existing mindmap service and storage model, but extend the request/document meta to carry `mode`. Replace the current one-pass generation prompt with two prompts for single-document generation: `Doc Outline` then `Mindmap Expand`. Do not implement multi-document merge in this phase; leave that for Phase 2 while keeping data shapes extensible.

**Tech Stack:** React, TypeScript, FastAPI, Pydantic, SQLAlchemy, existing Qwen client, pytest

---

### Task 1: Add shared mode types and transport fields

**Files:**
- Modify: `backend/app/services/mindmap/schemas.py`
- Modify: `frontend/src/features/mindmap/domain/types.ts`
- Modify: `frontend/src/features/mindmap/api/mindmapApi.ts`

**Step 1: Write the failing test**

Add backend schema tests asserting:
- generate request accepts `knowledge_structure` and `exam_review`
- document meta can round-trip `mode`

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_mindmap_service.py -k mode -v`
Expected: FAIL because mode fields do not exist yet.

**Step 3: Write minimal implementation**

- Add `MindMapMode = Literal["knowledge_structure", "exam_review"]`
- Add `mode` to generate request and persisted document metadata
- Add corresponding TypeScript union and API payload wiring

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_mindmap_service.py -k mode -v`
Expected: PASS

### Task 2: Add frontend mode selector and request wiring

**Files:**
- Modify: `frontend/src/features/mindmap/MindMapPanel.tsx`
- Modify: `frontend/src/features/mindmap/components/MindMapToolbar.tsx`
- Modify: `frontend/src/locales/en/common.json`
- Modify: `frontend/src/locales/zh/common.json`

**Step 1: Write the failing test**

Add or extend component tests so the generate action sends the currently selected mode.

**Step 2: Run test to verify it fails**

Run: `npm --prefix frontend test -- MindMapPanel`
Expected: FAIL because there is no mode selector or request field.

**Step 3: Write minimal implementation**

- Add a compact two-option mode switch in the toolbar or panel header
- Persist local mode state per panel context
- Pass mode into `generateMindMap`
- Localize labels in both languages

**Step 4: Run test to verify it passes**

Run: `npm --prefix frontend test -- MindMapPanel`
Expected: PASS

### Task 3: Implement single-document Doc Outline stage

**Files:**
- Modify: `backend/app/services/mindmap/generation.py`
- Modify: `backend/app/services/mindmap/service.py`
- Test: `backend/tests/services/test_mindmap_service.py`

**Step 1: Write the failing test**

Add a service test that mocks Qwen and asserts:
- first stage parses an outline structure
- second stage is not yet involved in this test
- mode is injected into the stage prompt

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_mindmap_service.py::test_single_document_outline_stage -v`
Expected: FAIL because outline stage does not exist.

**Step 3: Write minimal implementation**

- Introduce `DocOutline` intermediate schema
- Add prompt builder and parser for outline generation
- Keep file-upload path as the default source ingestion path where available

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_mindmap_service.py::test_single_document_outline_stage -v`
Expected: PASS

### Task 4: Implement Mindmap Expand stage from outline

**Files:**
- Modify: `backend/app/services/mindmap/generation.py`
- Modify: `backend/app/services/mindmap/service.py`
- Test: `backend/tests/services/test_mindmap_service.py`

**Step 1: Write the failing test**

Add a service test that mocks two LLM replies and asserts:
- stage one returns outline JSON
- stage two returns mindmap draft JSON
- final stored document uses stage-two draft

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_mindmap_service.py::test_single_document_two_stage_generation -v`
Expected: FAIL because generation is currently single-pass.

**Step 3: Write minimal implementation**

- Add expand prompt builder and parser
- Pipe outline result into second-stage generation
- Persist debug artifacts for both outline and final draft

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_mindmap_service.py::test_single_document_two_stage_generation -v`
Expected: PASS

### Task 5: Remove low-quality fallback for the new path

**Files:**
- Modify: `backend/app/services/mindmap/service.py`
- Test: `backend/tests/services/test_mindmap_service.py`

**Step 1: Write the failing test**

Add a test asserting the new single-document path does not silently degrade to `Page 1 / Snippet 1` style trees when stage generation fails.

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/services/test_mindmap_service.py::test_new_pipeline_does_not_fallback_to_placeholder_tree -v`
Expected: FAIL because current fallback still returns placeholder output.

**Step 3: Write minimal implementation**

- Gate fallback behavior by pipeline version
- For the new mode-aware path, raise a controlled generation error instead of returning placeholder trees

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/services/test_mindmap_service.py::test_new_pipeline_does_not_fallback_to_placeholder_tree -v`
Expected: PASS

### Task 6: Verify the Phase 1 slice

**Files:**
- Modify: `docs/plans/2026-03-22-mindmap-quality-rebuild-design.md`
- Modify: `docs/plans/2026-03-22-mindmap-quality-rebuild-implementation.md`

**Step 1: Run backend tests**

Run: `pytest backend/tests/services/test_mindmap_service.py -v`
Expected: PASS for the targeted mindmap service tests.

**Step 2: Run frontend validation**

Run: `npm --prefix frontend run build`
Expected: build may still fail on unrelated pre-existing TypeScript issues; if so, record them explicitly and verify touched files are type-safe by inspection.

**Step 3: Update docs**

- Mark Phase 1 completion status
- Record what remains for Phase 2: multi-document outline merge, concurrency pool, and file lifecycle controls

