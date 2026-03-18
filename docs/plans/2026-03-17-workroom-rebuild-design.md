# Workroom Rebuild Design

> Superseded by [2026-03-18-workspace-workroom-architecture.md](D:/Exam-paper/docs/plans/2026-03-18-workspace-workroom-architecture.md). This document reflects the older assumption that login lands directly in a workroom.

**Goal:** Rebuild the deleted `workroom` concept as the persistent container for file bindings, editor state, and agent workspace state before wiring knowledge-base retrieval into it.

**Status:** Design approved for implementation planning.

## 1. Context

`workroom` was partially deleted at the code level, but the concept still exists in the live PostgreSQL schema and data. The rebuild should follow the existing database model first, and only use the old design mockups as UI/interaction reference.

The old mockups under [stitch_test_paper_editor_workroom/_1/code.html](D:/Exam-paper/stitch_test_paper_editor_workroom/_1/code.html) and [stitch_test_paper_editor_workroom/_2/code.html](D:/Exam-paper/stitch_test_paper_editor_workroom/_2/code.html) show:

- a left-side knowledge/source surface
- a right-side saved-question surface
- empty and populated states for the left surface

But the database shows the real `workroom` model had already evolved beyond that into a three-surface persistent workspace.

## 2. Verified Database Facts

The following live tables exist in PostgreSQL:

- `workrooms`
- `workroom_source_bindings`
- `workroom_runtime_states`
- `workroom_panel_artifacts`

Verified row counts on 2026-03-17:

- `workrooms = 1`
- `workroom_source_bindings = 2`

Verified live rows indicate `workroom` was already in use:

- `workrooms.id = 14`
- `workroom_runtime_states.workroom_id = 14`
- `workroom_runtime_states.active_file_id = 1058`
- `workroom_runtime_states.active_extraction_session_id = 1057`

Verified persisted runtime JSON:

- left panel:
  - `{"active_file_id":1058,"active_tab_index":0,"active_extraction_session_id":1057}`
- center panel:
  - `{"ocr_items":[],"mindmap_state":{"source_file_id":1058,"workspace_document_id":null},"workspace_view":"editor","flashcard_state":{"source_file_id":1058,"workspace_document_id":null}}`
- right panel:
  - `{"agent_view_id":"view-1058-1057","is_agent_drawer_open":true}`

Verified persisted panel artifacts:

- `workspace_view/current`
- `mindmap_state/current`
- `flashcard_state/current`

## 3. Domain Model

`workroom` is not the knowledge base itself. It is the top-level container that owns:

- the set of files currently attached to the workspace
- the current active file/tab/session
- the current center workspace state
- the current right-side agent state
- panel-scoped artifacts such as mindmap and flashcard UI state

Knowledge base ingestion and retrieval should plug into `workroom` later through `workroom_source_bindings.source_id`, but that is phase two. The first rebuild phase is about restoring the container and state model.

## 4. Table Responsibilities

### 4.1 `workrooms`

Canonical workspace record.

Responsibilities:

- create/get the current user workspace
- persist name and lifecycle status
- scope all `workroom_*` child records

Do not overload this table with panel state.

### 4.2 `workroom_source_bindings`

Binding table between a workspace and uploaded source files.

Responsibilities:

- attach file(s) to a workspace
- mark source bindings active/inactive
- provide `file_id` for preview/editor/runtime usage
- later provide `source_id` for KB/RAG usage

Current meaning of columns:

- `file_id`: uploaded file bound to the workroom
- `source_id`: optional KB source pointer for later retrieval
- `is_active`: soft-active flag for current usable bindings

### 4.3 `workroom_runtime_states`

Single-row runtime snapshot for the workroom.

Responsibilities:

- active file/session pointers
- active tab index
- active workspace document pointer
- active agent session pointer
- left/center/right surface state snapshots

This table should hold the current “resume my workspace” state, not historical artifact lists.

### 4.4 `workroom_panel_artifacts`

Panel-scoped persisted artifact records.

Responsibilities:

- current `workspace_view`
- current `mindmap_state`
- current `flashcard_state`
- future `ocr_item`, `selection`, `editor_draft`, or similar panel outputs

This table is append/update oriented and should remain the extensibility layer.

## 5. Rebuild Boundary

Phase one rebuild includes:

- restoring workroom creation/loading
- restoring file binding into the current workroom
- restoring left/center/right runtime state persistence
- restoring panel artifact persistence and reload
- restoring backend APIs needed by the current frontend

Phase one explicitly does not include:

- full KB/RAG integration
- timeline/folder productization from the old mockup
- redesigning the preview pane
- replacing existing preview generation logic

## 6. Target Product Behavior

After rebuild, opening the app should restore the last active workroom state:

- active preview tab/file
- active extraction session
- current workspace view (`editor`, `mindmap`, `flashcard`)
- current right drawer visibility
- current document/mindmap/flashcard linkage

Uploading a file should:

- keep today’s preview flow working
- also bind the uploaded file into the current workroom
- update active runtime state to the new file/session/tab

Agent execution should continue using `workroom_id` as the primary scope boundary.

## 7. Frontend State Mapping

Current frontend state already exposes enough signals to map into `workroom`.

### 7.1 Left surface

Current source:

- [frontend/src/hooks/useFileUpload.ts](D:/Exam-paper/frontend/src/hooks/useFileUpload.ts)

State to persist:

- active file id
- active extraction session id
- active tab index
- current file tab set

Persistence target:

- `workroom_runtime_states.left_panel_state_json`

### 7.2 Center surface

Current sources:

- [frontend/src/App.tsx](D:/Exam-paper/frontend/src/App.tsx)
- `workspaceView`
- `agentDocumentId`
- OCR/editor-related items

State to persist:

- `workspace_view`
- active workspace document id
- current mindmap state
- current flashcard state
- current editor-related surface state

Persistence targets:

- `workroom_runtime_states.center_panel_state_json`
- `workroom_panel_artifacts`

### 7.3 Right surface

Current sources:

- agent drawer open/close
- `view-<fileId>-<sessionId>` view id
- active agent session id

Persistence target:

- `workroom_runtime_states.right_panel_state_json`

## 8. Backend Integration Points

Current live code already depends on `workroom` semantics in several places:

- [backend/app/agent/router.py](D:/Exam-paper/backend/app/agent/router.py)
- [backend/app/agent/assistant_graph/session_runtime.py](D:/Exam-paper/backend/app/agent/assistant_graph/session_runtime.py)
- [backend/app/agent/assistant_graph/router_runtime.py](D:/Exam-paper/backend/app/agent/assistant_graph/router_runtime.py)
- [backend/app/agent/services/agent_service.py](D:/Exam-paper/backend/app/agent/services/agent_service.py)

This means the rebuild should not invent a new model. It should restore the missing service/API layer around the already-assumed runtime contract.

## 9. Required Backend Capabilities

The rebuild needs a dedicated `workroom` service layer with these capabilities:

### 9.1 Workroom lifecycle

- get current active workroom for user
- create default workroom if absent
- rename workroom
- mark workroom status

### 9.2 Source binding

- bind uploaded file to workroom
- list active bound files
- unbind/deactivate file
- mark active file after tab switch

### 9.3 Runtime state

- get runtime state for workroom
- upsert runtime state
- patch left panel state
- patch center panel state
- patch right panel state

### 9.4 Panel artifacts

- upsert `workspace_view/current`
- upsert `mindmap_state/current`
- upsert `flashcard_state/current`
- query artifacts by workroom and active document/file

## 10. Recommended Module Layout

To avoid scattering logic, the rebuild should use a dedicated module tree:

- `backend/app/services/workroom/`
- `backend/app/services/workroom/types.py`
- `backend/app/services/workroom/repository.py`
- `backend/app/services/workroom/service.py`
- `backend/app/services/workroom/runtime_state_service.py`
- `backend/app/services/workroom/panel_artifact_service.py`
- `backend/app/routers/workroom.py`

Do not bury workroom persistence directly inside agent router or files router.

## 11. API Surface To Rebuild

Recommended endpoints:

- `GET /api/workrooms/current`
- `POST /api/workrooms/current`
- `GET /api/workrooms/{workroom_id}/state`
- `PUT /api/workrooms/{workroom_id}/state`
- `PATCH /api/workrooms/{workroom_id}/state/left`
- `PATCH /api/workrooms/{workroom_id}/state/center`
- `PATCH /api/workrooms/{workroom_id}/state/right`
- `GET /api/workrooms/{workroom_id}/sources`
- `POST /api/workrooms/{workroom_id}/sources`
- `DELETE /api/workrooms/{workroom_id}/sources/{file_id}`
- `PUT /api/workrooms/{workroom_id}/artifacts/{artifact_type}/{artifact_ref_id}`
- `GET /api/workrooms/{workroom_id}/artifacts`

The upload flow should eventually call the source-binding API or invoke equivalent backend service logic internally.

## 12. Rebuild Sequence

### Phase A: Stabilize the domain shell

- add repository/service around `workrooms`
- add repository/service around `workroom_source_bindings`
- add repository/service around `workroom_runtime_states`
- add repository/service around `workroom_panel_artifacts`

### Phase B: Restore the runtime contract

- current workroom resolution
- runtime state read/write APIs
- panel artifact read/write APIs

### Phase C: Reconnect current frontend

- app load fetches current workroom
- app load restores runtime state
- upload binds file to workroom
- tab switches update left-panel runtime state
- workspace view switches update center state/artifact
- agent drawer changes update right-panel state

### Phase D: Validate persistence

- refresh browser and verify state restoration
- open/close agent drawer and verify persistence
- switch workspace view and verify persistence
- upload file and verify binding + restoration

### Phase E: Only then connect knowledge base

- keep `file_id` as preview/editor source
- fill `source_id` after KB ingest
- let agent resolve KB sources through workroom bindings

## 13. Risks

### 13.1 Frontend currently does not pass `workroom_id`

This is the biggest real integration gap. Current upload and app state flows do not appear to carry `workroom_id` through the frontend. That must be repaired before `workroom` can become the true runtime container.

### 13.2 Existing workroom scope assertions already enforce membership

Agent routes already enforce `file_id` and `session_id` membership inside `workroom_source_bindings`. Once workroom is restored, these checks will become active again for more of the app flow. Any missing binding logic will surface immediately.

### 13.3 State duplication

`workspace_view`, `mindmap_state`, and `flashcard_state` currently appear both in runtime JSON and artifact rows. The rebuild must define a clear rule:

- runtime JSON stores active snapshot
- artifact rows store named/persisted panel payloads

Do not let them drift without a write policy.

## 14. Decision

Rebuild `workroom` from the database contract outward.

That means:

- database tables are the source of truth
- the old design mockup is only a visual/product hint
- the first milestone is a working persistent workspace container
- knowledge-base integration comes after workroom is stable

## 15. Next Step

Write a dedicated implementation plan that breaks the rebuild into:

- backend repository/service tasks
- router/API tasks
- frontend state hydration/persistence tasks
- verification tasks

That implementation plan should execute `workroom` first, and explicitly defer KB integration until the final phase.
