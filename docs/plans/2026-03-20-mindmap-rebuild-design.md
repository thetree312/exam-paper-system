# Mindmap Rebuild Design

**Goal:** Rebuild the mindmap feature as an independent subsystem with a single canonical data model, Mind Elixir as the editor engine, and no compatibility-mode transition paths.

**Status:** Approved for implementation in-place.

## 1. Decision

The current mindmap implementation will be replaced, not evolved.

This rebuild adopts the following hard rules:

- `mindmaps` is the only formal persistence for mindmap content.
- `workroom_runtime_states` and `workroom_panel_artifacts` only store workroom and panel UI state.
- `documents.mindmap_cache` is deprecated immediately and must not be read or written by the new implementation.
- The frontend editor engine is `mind-elixir`; `reactflow` is removed from the mindmap feature.
- The canonical domain model is tree-first, not graph-canvas-first.

## 2. Verified Existing Database Structure

The current schema already provides the core persistence primitives needed for the rebuild.

### 2.1 Formal mindmap storage

Existing table: `mindmaps`

Source:
- [backend/db/migrations/20250112_create_mindmaps_table.sql](/d:/Exam-paper/backend/db/migrations/20250112_create_mindmaps_table.sql)
- [backend/app/models.py](/d:/Exam-paper/backend/app/models.py#L325)

Relevant columns:
- `tenant_id`
- `created_by_user_id`
- `source_type`
- `source_id`
- `kind`
- `title`
- `graph_json`
- `version`
- `is_active`

Conclusion:
- Reuse this table as the single formal storage for mindmap content.
- Do not create a second mindmap content table.

### 2.2 Deprecated duplicate storage

Existing field: `documents.mindmap_cache`

Source:
- [backend/app/models.py](/d:/Exam-paper/backend/app/models.py#L267)

Conclusion:
- This field duplicates the responsibility of `mindmaps.graph_json`.
- The new implementation must not read or write it.
- Cleanup migration may physically drop it later, but behavioral deprecation starts now.

### 2.3 Workroom runtime state

Existing tables:
- `workroom_runtime_states`
- `workroom_panel_artifacts`

Source:
- [backend/app/models.py](/d:/Exam-paper/backend/app/models.py#L749)
- [backend/app/models.py](/d:/Exam-paper/backend/app/models.py#L771)
- [backend/app/services/workroom/repository.py](/d:/Exam-paper/backend/app/services/workroom/repository.py)

Conclusion:
- Reuse these tables for current panel selection, viewport, expanded nodes, and selected node state.
- Do not store full mindmap content here.

## 3. Problems in the Current Implementation

### 3.1 No clean module boundary

The frontend has a `features/mindmap` directory, but the backend still depends on legacy agent router definitions.

Source:
- [backend/app/routers/mindmap.py](/d:/Exam-paper/backend/app/routers/mindmap.py)

Problem:
- `backend/app/routers/mindmap.py` imports `MindMapRequest`, `MindMapResponse`, and `_generate_mindmap_core` from the old agent router.
- This prevents mindmap from being a first-class subsystem.

### 3.2 View library drives the data model

Source:
- [frontend/src/features/mindmap/components/MindMapFlow.tsx](/d:/Exam-paper/frontend/src/features/mindmap/components/MindMapFlow.tsx)

Problem:
- The current implementation manually computes layout, edge routing, branch sides, and depth semantics inside the React Flow adapter.
- The app is effectively maintaining its own custom graph editor layer.

### 3.3 Duplicate persistence paths

Source:
- [backend/app/routers/agent_v2.py](/d:/Exam-paper/backend/app/routers/agent_v2.py)
- [backend/app/agent/router.py](/d:/Exam-paper/backend/app/agent/router.py)
- [backend/app/routers/mindmap.py](/d:/Exam-paper/backend/app/routers/mindmap.py)

Problem:
- Old routes still persist to `documents.mindmap_cache`.
- Newer routes persist to `mindmaps.graph_json`.
- This creates split truth and raises migration risk.

## 4. Target Architecture

The rebuilt system has four explicit layers.

### 4.1 Domain layer

Canonical object:

```ts
type MindMapDocument = {
  id: string
  version: number
  source: {
    type: 'exam_document' | 'uploaded_file'
    id: number
  }
  kind: 'knowledge'
  title?: string | null
  root: MindMapNodeTree
  relations: MindMapRelation[]
  meta: {
    hasQuestionRefs: boolean
    generatedBy: 'llm' | 'manual'
    updatedAt: string
  }
}

type MindMapNodeTree = {
  id: string
  topic: string
  summary?: string
  side?: 'left' | 'right'
  questionRefs?: Array<{
    questionId?: number
    sequenceIndex?: number
    page?: number | null
  }>
  children: MindMapNodeTree[]
}

type MindMapRelation = {
  id: string
  from: string
  to: string
  label?: string
}
```

Rules:
- Tree is primary structure.
- `relations` is optional supplemental cross-link data.
- Layout coordinates are not part of formal content.

### 4.2 Backend module layer

Target module layout:

- `backend/app/services/mindmap/__init__.py`
- `backend/app/services/mindmap/schemas.py`
- `backend/app/services/mindmap/repository.py`
- `backend/app/services/mindmap/service.py`
- `backend/app/services/mindmap/generation.py`
- `backend/app/routers/mindmap.py`

Responsibilities:
- repository: read/write `mindmaps`
- service: lifecycle, versioning, current active map lookup
- generation: build new `MindMapDocument` from source text/questions
- router: API boundary only

### 4.3 Frontend feature layer

Target module layout:

- `frontend/src/features/mindmap/domain/`
- `frontend/src/features/mindmap/api/`
- `frontend/src/features/mindmap/editor/`
- `frontend/src/features/mindmap/panel/`

Responsibilities:
- domain: canonical types and conversions
- api: backend requests
- editor: Mind Elixir adapter
- panel: toolbar, inspector, panel shell

### 4.4 Workroom integration layer

Persist only active panel state to:
- `workroom_runtime_states.center_panel_state_json`
- `workroom_panel_artifacts` with:
  - `artifact_type = 'mindmap_panel'`
  - `artifact_ref_id = 'current'`

Payload example:

```json
{
  "mindmapId": 12,
  "sourceType": "uploaded_file",
  "sourceId": 1058,
  "selectedNodeId": "node_7",
  "expandedNodeIds": ["node_1", "node_3"],
  "view": {
    "scale": 1,
    "x": 0,
    "y": 0
  }
}
```

## 5. API Design

The rebuilt API surface is:

### 5.1 Generate

`POST /api/mindmaps/generate`

Input:
- `tenant_id`
- `user_id`
- `source_type`
- `source_id`
- `kind`
- `force`

Behavior:
- If `force = false`, return current active mindmap if one exists.
- Otherwise generate a new version, activate it, and return it.

### 5.2 Get current

`GET /api/mindmaps/current`

Query:
- `tenant_id`
- `source_type`
- `source_id`
- `kind`

Behavior:
- Return current active mindmap for the source.

### 5.3 Save full content

`PUT /api/mindmaps/{mindmap_id}`

Behavior:
- Full replacement save of canonical content.
- No partial graph patch endpoint in the first version.

### 5.4 Persist panel state

`PUT /api/workrooms/{workroom_id}/artifacts/mindmap_panel/current`

Behavior:
- Save panel UI state only.

## 6. Database Policy

### 6.1 Reuse

Keep and reuse:
- `mindmaps`
- `workroom_runtime_states`
- `workroom_panel_artifacts`

### 6.2 Deprecate

Stop using immediately:
- `documents.mindmap_cache`

### 6.3 Migration policy

Implementation migration tasks:
- remove all reads/writes of `documents.mindmap_cache`
- remove old mindmap save/generate routes under agent routers
- ensure current `mindmaps` row is the only authoritative content

Recommended follow-up migration:
- add a partial uniqueness rule or equivalent application invariant for one active row per source
- optionally drop `documents.mindmap_cache` in a later schema cleanup migration

## 7. Frontend Editor Strategy

Mind Elixir will be integrated as the editor runtime.

Official references:
- https://docs.mind-elixir.com/docs/getting-started/quick-start
- https://docs.mind-elixir.com/zh-Hans/docs/guides/data-export
- https://docs.mind-elixir.com/docs/guides/node-data

Key usage model:
- mount editor into a fixed-height container
- initialize with canonical tree converted to Mind Elixir `nodeData`
- listen to operations through editor bus
- export content with `getData()`
- replace content with `refresh(data)`

The React layer must not reimplement layout or edge routing.

## 8. Implementation Plan

### Phase A: Formalize the new domain

- add backend mindmap schemas independent of agent router
- add frontend canonical types under `features/mindmap/domain`
- define canonical conversion helpers

### Phase B: Rebuild backend persistence

- replace router internals with dedicated repository/service
- generate and save only canonical documents
- remove document cache usage from mindmap code paths

### Phase C: Replace frontend engine

- remove React Flow-based editor implementation
- add Mind Elixir adapter component
- wire editor output back to canonical save

### Phase D: Rebind workroom state

- save active panel state in `workroom_panel_artifacts`
- keep workroom runtime snapshot limited to current selection context

### Phase E: Cleanup

- remove old mindmap types and obsolete flow components
- stop routing through old agent mindmap APIs

## 9. Risks

### 9.1 Tree-generation quality

The LLM currently emits node and edge lists. The new generator must produce a clean tree with stable parent-child semantics or post-process into one.

### 9.2 Old callers

Any frontend or backend caller still bound to `nodes + edges + root_id` will break once the new canonical API lands. This is acceptable because the decision is to rebuild, not preserve compatibility.

### 9.3 Workroom state misuse

If full mindmap content is written into workroom artifacts again, the system will regress into duplicate truth. This must be avoided by code review and schema ownership discipline.

## 10. Immediate Build Scope

This implementation session will do the following:

- create this design as the formal rebuild document
- implement a dedicated backend mindmap service/module
- switch the main frontend mindmap panel away from React Flow to Mind Elixir
- remove old cache-based logic from the active mindmap path

Out of scope for this session:
- historical data migration scripts
- old endpoint compatibility shims
- import of legacy saved `nodes + edges` payloads after the cutover
