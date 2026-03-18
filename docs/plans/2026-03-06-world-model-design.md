# Multi-Turn Agent World Model Design

**Date:** 2026-03-06  
**Status:** Approved design draft

## Goal

Build a unified runtime world model for the assistant graph so ORC, runtime, tools, and trace all operate on the same environment model instead of separate prompt-only state fragments.

## Why

Current behavior shows that environment facts, tool semantics, runtime observations, and trace language are not expressed in one shared model. The result is:

- ORC sees environment state but does not consistently turn it into decision context
- tool execution results remain technical outputs instead of world changes
- multi-turn continuity is weak because attention and recent changes are not modeled explicitly
- trace exposes process fragments instead of showing how the world changed

This design fixes the problem at the runtime model layer rather than by adding case-specific routing rules.

## Scope

This design covers:

- shared runtime data model
- object ontology
- relation ontology
- runtime snapshot model
- recent change model
- node responsibilities across `context_init`, `execution_runtime`, `orc_loop`, `tool_registry`, and trace
- migration sequence from current fragmented state

This design does not yet cover:

- implementation of retrieval planning / agentic RAG
- frontend rendering details beyond trace data contract
- full legacy field deletion in one step

---

## 1. World Model As First-Class Runtime State

The world model must become a first-class state structure in the assistant graph rather than a prompt formatting trick.

Add three top-level fields to graph state:

- `world_model`
- `runtime_snapshot`
- `recent_changes`

These serve different purposes:

- `world_model`: stable ontology and relation vocabulary
- `runtime_snapshot`: current actionable slice of the environment
- `recent_changes`: compact delta of high-impact changes across recent turns and recent tool actions

This separation prevents prompt bloat and avoids mixing stable structure with transient observations.

---

## 2. Ontology: Unified Object Model

All runtime-visible entities are represented under four top-level kinds:

### 2.1 `resource`
Original or directly referenceable resources.

Examples:
- uploaded document
- image
- video
- audio
- web page
- knowledge item

### 2.2 `structure`
Organized, derived, or indexed structure over resources.

Examples:
- question page
- segment
- outline
- collection
- index entry
- timeline slice

### 2.3 `artifact`
Workspace products created by the system or the agent.

Examples:
- question card
- flashcard
- mindmap
- summary
- draft
- annotation

### 2.4 `operation`
Process objects representing meaningful actions in the system.

Examples:
- retrieve
- focus
- mutate
- generate
- import

### 2.5 Shared Object Fields
Every object uses the same base schema:

```json
{
  "id": "...",
  "kind": "resource|structure|artifact|operation",
  "type": "...",
  "subtype": "...",
  "title": "...",
  "origin": "uploaded|imported|derived|created|retrieved|external|unknown",
  "status": "available|empty|pending|partial|failed|archived",
  "visibility": "active|inactive|hidden",
  "updated_at": "..."
}
```

### 2.6 Why `origin` Matters
Object definitions must not encode a fixed lineage assumption. For example, a question card may be derived from a source file, but it may also be created directly in the workspace. `origin` captures that without forcing business-specific exceptions into the ontology.

---

## 3. Ontology: Unified Relation Model

Objects alone are not enough. The agent needs explicit relations to understand what came from where, what is currently relevant, and what actions changed the environment.

The first relation set is:

- `derived_from`
- `contains`
- `references`
- `focuses_on`
- `produced_by`
- `acts_on`

### 3.1 Relation Schema

```json
{
  "source_id": "...",
  "target_id": "...",
  "relation": "...",
  "strength": 1.0,
  "status": "active|stale|failed",
  "updated_at": "..."
}
```

### 3.2 Why These Relations

- `derived_from`: captures lineage without hardcoding it into object definitions
- `contains`: captures membership and container structure
- `references`: links answers, cards, notes, and evidence without forcing derivation
- `focuses_on`: captures current attention target and multi-turn continuity
- `produced_by`: makes generated objects traceable to operations
- `acts_on`: records what an operation actually targeted

This relation set is intentionally small. It is enough to support reasoning, trace, and later extension without overfitting to one workflow.

---

## 4. Runtime Snapshot Model

`runtime_snapshot` is not a database dump. It is the compact, current, actionable world slice ORC should reason over.

It has four sections:

```json
{
  "inventory_summary": {},
  "active_window": {
    "objects": [],
    "relations": []
  },
  "attention_state": {
    "focused_objects": [],
    "focused_domains": [],
    "open_questions": [],
    "stalled_paths": []
  },
  "available_capabilities": []
}
```

### 4.1 `inventory_summary`
Global compressed counts and availability.

Purpose:
- preserve environment awareness
- avoid linear token growth with object count

Example:

```json
{
  "resource": {"document": 50, "image": 12},
  "structure": {"question_page": 0, "segment": 900},
  "artifact": {"question_card": 100, "flashcard": 20, "mindmap": 2}
}
```

### 4.2 `active_window`
Only the small set of most relevant objects and relations for the current request and ongoing work.

Purpose:
- provide action anchors
- support multi-turn continuity
- prevent prompt overload

This window must be explicitly size-limited.

### 4.3 `attention_state`
This is the key continuity mechanism.

Purpose:
- represent what the agent is currently attending to
- represent unresolved parts of the task
- record paths that are stalled or low-yield

This prevents the agent from re-deriving its own state from raw tool outputs every loop.

### 4.4 `available_capabilities`
Summarizes which capabilities or tool families are currently available in the loop.

Purpose:
- decouple raw tool list from decision context
- give ORC a concise capability view

---

## 5. Recent Changes Model

`recent_changes` is not a raw event log. It is a compact list of high-impact changes that matter for future reasoning.

Schema:

```json
{
  "change_type": "...",
  "object_ids": [],
  "caused_by_operation": "...",
  "result": "...",
  "impact": "..."
}
```

Examples:

```json
{
  "change_type": "retrieval_result",
  "object_ids": ["op_retrieve_21", "doc_1054"],
  "caused_by_operation": "read_kb_evidence",
  "result": "evidence_found",
  "impact": "kb_domain_now_has_answerable_evidence"
}
```

```json
{
  "change_type": "workspace_read_attempt",
  "object_ids": ["op_read_11"],
  "caused_by_operation": "read_workspace_index",
  "result": "no_objects_found",
  "impact": "workspace_question_path_stalled"
}
```

Only the last 3-5 high-impact changes should be preserved in prompt-visible form.

---

## 6. Token Budget Strategy

The design must remain stable under large workrooms, such as 50 source files and 100 question cards.

The control strategy is:

### 6.1 Inventory is aggregate only
No detailed object lists in `inventory_summary`.

### 6.2 Active window is bounded
Recommended first limits:
- `resource`: 2-3
- `structure`: 2-3
- `artifact`: 2-3
- `operation`: 1-2

Total active objects target: 8-10.

### 6.3 Relations are local to the active window
Only relations directly relevant to active objects are included.

### 6.4 Recent changes are bounded
Only 3-5 high-impact changes.

### 6.5 Detailed object retrieval remains on-demand
Detailed data stays in runtime storage or tool-accessible stores, not in ORC context.

Target prompt-visible footprint for world context:
- normal: 300-700 tokens
- upper bound for heavy sessions: under 1,000 tokens

---

## 7. Code Mapping To Current System

### 7.1 `backend/app/assistant_graph/state.py`
Add formal state definitions for:
- `world_model`
- `runtime_snapshot`
- `recent_changes`

This file becomes the canonical schema boundary.

### 7.2 `backend/app/assistant_graph/nodes/context_init.py`
Responsibilities:
- initialize `world_model`
- build `runtime_snapshot.inventory_summary`
- build initial `active_window`
- initialize `attention_state`

This node should stop acting like a prompt-state formatter and instead become the environment snapshot builder.

### 7.3 `backend/app/assistant_graph/nodes/execution_runtime.py`
Responsibilities:
- translate tool execution results into object updates, relation updates, and `recent_changes`
- update `attention_state`
- convert technical outcomes into world impacts

This is where tool outputs become world updates instead of remaining isolated execution metadata.

### 7.4 `backend/app/assistant_graph/nodes/orc_loop.py`
Responsibilities:
- consume `runtime_snapshot` and `recent_changes`
- stop relying on fragmented state fields as the primary ORC language

ORC should reason over the current world slice, not raw engineering state.

### 7.5 `backend/app/assistant_graph/tool_registry.py`
Responsibilities:
- attach tools to world model semantics
- declare what kind of objects a tool reads, writes, produces, or acts on

Suggested extra semantic fields per tool:
- `reads_kinds`
- `writes_kinds`
- `produces_kinds`
- `acts_on_domains`

This is not workflow routing. It is ontology alignment.

### 7.6 Trace Layer
Trace should render world changes and attention shifts rather than raw technical prompt fragments.

Trace should be driven by:
- `attention_state`
- `recent_changes`
- selected action impacts

---

## 8. Migration Plan

Migration should be phased, not big-bang.

### Phase 1: Schema Introduction
- add `world_model`, `runtime_snapshot`, `recent_changes`
- do not remove all legacy fields yet

### Phase 2: Snapshot Build
- generate initial snapshot from current state in `context_init`
- keep old fields only as source material

### Phase 3: ORC Consumption
- switch ORC prompt assembly to consume snapshot summary
- reduce direct reliance on fragmented legacy fields

### Phase 4: Runtime Writeback
- make `execution_runtime` write changes into world state
- upgrade tool result interpretation into world changes and impacts

### Phase 5: Tool Ontology Alignment
- update tool registry metadata to align tools with object and domain semantics

### Phase 6: Trace Alignment
- render from world change semantics instead of prompt engineering fragments

### Phase 7: Legacy Cleanup
- remove or demote fragmented fields that should no longer be ORC-facing language

---

## 9. Success Criteria

The design is successful when:

1. ORC reasons over objects, domains, and changes instead of fragmented status bits
2. Multi-turn continuity is represented explicitly through `attention_state` and `recent_changes`
3. Tool failures update the world view as path impacts, not just raw error codes
4. New business object types can be added mostly as `subtype` extensions without redesigning the core model
5. Trace explains how the world changed instead of showing rigid technical scaffolding

---

## 10. Known Risks

- Migration complexity is real because current state language is fragmented
- Dual-language drift is likely during migration if legacy fields remain ORC-facing for too long
- Tool semantics must be aligned with ontology or the model will still drift conceptually

These risks are acceptable because the existing architecture already shows the cost of not having a shared runtime environment model.
