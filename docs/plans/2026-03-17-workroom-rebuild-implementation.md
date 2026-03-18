# Workroom Rebuild Implementation Plan

> Superseded by [2026-03-18-workspace-workroom-implementation.md](D:/Exam-paper/docs/plans/2026-03-18-workspace-workroom-implementation.md). This document reflects the older assumption that workroom is the post-login landing page.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild `workroom` as the authenticated main workspace, persist left/center/right panel state, and make the frontend land on a workroom home page based on the approved design direction.

**Architecture:** Add a dedicated backend `workroom` module with repository/service/router layers over the existing PostgreSQL tables, then lift `workroom` into the frontend global state and route login-success users into a redesigned workroom shell. Keep the current preview/editor/agent internals reusable inside the new shell instead of rewriting them all at once.

**Tech Stack:** FastAPI, SQLAlchemy ORM + SQL text queries, React, Zustand, TypeScript, TailwindCSS

---

## Current Execution Status

Completed in this round:

- Added backend ORM coverage for `workrooms`, `workroom_source_bindings`, `workroom_runtime_states`, `workroom_panel_artifacts`
- Added `workroom_id` fields back onto `documents`, `agent_sessions`, `extraction_sessions`
- Implemented modular backend workroom layers:
  - `backend/app/services/workroom/repository.py`
  - `backend/app/services/workroom/service.py`
  - `backend/app/routers/workroom.py`
- Mounted workroom router in `backend/main.py`
- Updated file upload flow to accept `workroom_id`, bind uploaded files into the active workroom, and persist extraction-session linkage
- Added frontend workroom types, Zustand state, API client, and `useWorkroom` hydration hook
- Reworked login-success shell so authenticated users land in `WorkroomHomeShell`
- Added left-side workroom timeline UI based on the approved design direction
- Passed `workroom_id` through upload, agent, and grading request paths

Verified in this round:

- `backend\.venv\Scripts\python -m compileall backend/app backend/main.py`

Blocked in this round:

- Frontend full `npm run build` is still blocked by a large set of pre-existing TypeScript errors outside the workroom slice, including agent workspace, flashcard, markdown rendering, question renderer, and editor modules
- Workroom-specific compile regressions introduced during this round were partially fixed, but full frontend green build still requires paying down those older type errors

### Task 1: Restore backend data model coverage

**Files:**
- Modify: `backend/app/models.py`
- Modify: `backend/app/schemas.py`
- Test: `backend/tests/services/test_workroom_service.py`

**Step 1: Write the failing test**

Write a test that imports the workroom service and verifies model-backed fields like `Document.workroom_id` and `ExtractionSession.workroom_id` exist and can be referenced.

**Step 2: Run test to verify it fails**

Run: `PYTHONPATH=backend backend\.venv\Scripts\python -m pytest backend/tests/services/test_workroom_service.py -v`
Expected: FAIL with missing model attributes or missing workroom classes.

**Step 3: Write minimal implementation**

Add ORM coverage for:

- `Document.workroom_id`
- `AgentSession.workroom_id`
- `ExtractionSession.workroom_id`
- `Workroom`
- `WorkroomSourceBinding`
- `WorkroomRuntimeState`
- `WorkroomPanelArtifact`

Add Pydantic schemas for current-workroom, runtime-state, source-binding, and artifact responses.

**Step 4: Run test to verify it passes**

Run: `PYTHONPATH=backend backend\.venv\Scripts\python -m pytest backend/tests/services/test_workroom_service.py -v`
Expected: PASS

### Task 2: Build modular backend workroom repository and service

**Files:**
- Create: `backend/app/services/workroom/__init__.py`
- Create: `backend/app/services/workroom/types.py`
- Create: `backend/app/services/workroom/repository.py`
- Create: `backend/app/services/workroom/service.py`
- Test: `backend/tests/services/test_workroom_service.py`

**Step 1: Write the failing test**

Add tests for:

- get-or-create current workroom
- get runtime state
- upsert runtime state
- list source bindings
- bind source file idempotently
- upsert current panel artifact

**Step 2: Run test to verify it fails**

Run: `PYTHONPATH=backend backend\.venv\Scripts\python -m pytest backend/tests/services/test_workroom_service.py -v`
Expected: FAIL with missing repository/service classes.

**Step 3: Write minimal implementation**

Implement a modular service that:

- creates a default active workroom if none exists
- reads and writes `workroom_runtime_states`
- binds files into `workroom_source_bindings`
- stores current artifacts into `workroom_panel_artifacts`
- returns DTO-friendly payloads

**Step 4: Run test to verify it passes**

Run: `PYTHONPATH=backend backend\.venv\Scripts\python -m pytest backend/tests/services/test_workroom_service.py -v`
Expected: PASS

### Task 3: Expose backend workroom API

**Files:**
- Create: `backend/app/routers/workroom.py`
- Modify: `backend/main.py`
- Test: `backend/tests/routers/test_workroom_router.py`

**Step 1: Write the failing test**

Add API tests for:

- `GET /api/workrooms/current`
- `GET /api/workrooms/{id}/state`
- `PUT /api/workrooms/{id}/state`
- `GET /api/workrooms/{id}/sources`
- `POST /api/workrooms/{id}/sources`

**Step 2: Run test to verify it fails**

Run: `PYTHONPATH=backend backend\.venv\Scripts\python -m pytest backend/tests/routers/test_workroom_router.py -v`
Expected: FAIL with 404 or router import errors.

**Step 3: Write minimal implementation**

Create a new router that:

- resolves current workroom from `tenant_id` + `user_id`
- exposes runtime-state read/write
- exposes active source bindings
- exposes source binding mutation

Include the router in `backend/main.py`.

**Step 4: Run test to verify it passes**

Run: `PYTHONPATH=backend backend\.venv\Scripts\python -m pytest backend/tests/routers/test_workroom_router.py -v`
Expected: PASS

### Task 4: Bind uploaded files into workroom

**Files:**
- Modify: `backend/app/routers/files.py`
- Modify: `backend/app/tasks.py`
- Modify: `backend/app/services/workroom/service.py`
- Test: `backend/tests/routers/test_files_workroom_binding.py`

**Step 1: Write the failing test**

Add a test that uploads a file with `workroom_id`, creates an extraction session, and confirms the file gets bound into `workroom_source_bindings`.

**Step 2: Run test to verify it fails**

Run: `PYTHONPATH=backend backend\.venv\Scripts\python -m pytest backend/tests/routers/test_files_workroom_binding.py -v`
Expected: FAIL because upload does not bind files to workroom.

**Step 3: Write minimal implementation**

Update upload flow to:

- accept `workroom_id`
- persist it onto `ExtractionSession`
- bind the uploaded `file_id` into the active workroom
- keep preview generation unchanged

**Step 4: Run test to verify it passes**

Run: `PYTHONPATH=backend backend\.venv\Scripts\python -m pytest backend/tests/routers/test_files_workroom_binding.py -v`
Expected: PASS

### Task 5: Lift workroom into frontend global state

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/store/appStore.ts`
- Create: `frontend/src/services/workroomApi.ts`
- Create: `frontend/src/hooks/useWorkroom.ts`
- Test: `frontend` typecheck/build

**Step 1: Add frontend types**

Define types for:

- current workroom
- workroom runtime state
- workroom source binding

**Step 2: Add store state**

Persist:

- current workroom
- runtime state snapshot
- loading/error status

**Step 3: Add API client and hook**

Implement:

- fetch current workroom on login restore
- fetch current state and sources
- upsert state patches

**Step 4: Verify**

Run: `npm run build` in `frontend`
Expected: build succeeds with new types and imports.

### Task 6: Redesign login-success landing page as workroom shell

**Files:**
- Modify: `frontend/src/App.tsx`
- Create: `frontend/src/components/WorkroomHomeShell.tsx`
- Create: `frontend/src/components/WorkroomSourceTimeline.tsx`
- Create: `frontend/src/components/WorkroomQuestionDeck.tsx`
- Modify: `frontend/src/style.css`

**Step 1: Implement layout shell**

Build a `workroom` home layout with these surfaces:

- left: knowledge/source timeline inspired by the approved design mockups
- center: current workspace shell entry point
- right: agent drawer integration

**Step 2: Preserve current tools**

Reuse existing:

- preview/upload logic
- editor workspace shell
- agent chat drawer

Do not rewrite them from scratch.

**Step 3: Apply the approved visual direction**

Use the design mockup as visual guide:

- editorial light theme
- timeline-like source area
- refined card deck
- workroom as main product surface after login

**Step 4: Verify**

Run: `npm run build`
Expected: frontend build succeeds and login path renders the new workroom shell.

### Task 7: Persist workroom runtime from frontend interactions

**Files:**
- Modify: `frontend/src/hooks/useFileUpload.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/hooks/useAgentChat.ts`
- Modify: `frontend/src/components/EditorWorkspaceShell.tsx`
- Modify: `frontend/src/components/PreviewPaneShell.tsx`

**Step 1: Persist left panel state**

On file upload, tab select, and session polling:

- write `active_file_id`
- write `active_tab_index`
- write `active_extraction_session_id`

**Step 2: Persist center state**

On workspace view change and document change:

- write `active_workspace_document_id`
- write `workspace_view`
- upsert `mindmap_state/current`
- upsert `flashcard_state/current`

**Step 3: Persist right state**

On agent drawer open/close and session/view changes:

- write `agent_view_id`
- write `active_agent_session_id` when available

**Step 4: Verify**

Run: `npm run build`
Expected: no type errors and no missing hook dependencies.

### Task 8: Restore workroom hydration on load

**Files:**
- Modify: `frontend/src/hooks/useWorkroom.ts`
- Modify: `frontend/src/App.tsx`

**Step 1: Read persisted state on login**

On authenticated load:

- resolve current workroom
- load runtime state
- seed store defaults

**Step 2: Rehydrate visible UI**

Restore:

- active tab index
- active file/session if still present
- workspace view
- agent drawer open state

**Step 3: Verify**

Manual verification:

1. Login
2. Upload file
3. Switch workspace view
4. Open agent drawer
5. Refresh page
Expected: workroom restores the previous state.

### Task 9: Run verification

**Files:**
- No code changes

**Step 1: Backend tests**

Run:

`$env:PYTHONPATH='backend'; backend\.venv\Scripts\python -m pytest backend/tests/services/test_workroom_service.py backend/tests/routers/test_workroom_router.py backend/tests/routers/test_files_workroom_binding.py`

Expected: PASS

**Step 2: Backend compile**

Run:

`backend\.venv\Scripts\python -m compileall backend/app`

Expected: PASS

**Step 3: Frontend build**

Run:

`npm run build`

Expected: PASS

### Task 10: Defer KB integration explicitly

**Files:**
- Modify later: `backend/app/services/kb/*`
- Modify later: `backend/app/agent/tools/knowledge_evidence.py`

Do not start this task during workroom rebuild. Once Tasks 1-9 are stable, connect `workroom_source_bindings.source_id` to KB ingest/retrieval in a separate phase.
