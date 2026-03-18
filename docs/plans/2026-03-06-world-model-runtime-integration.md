# World Model Runtime Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Introduce a unified world model into the assistant graph so ORC, runtime execution, tool semantics, and trace all operate on the same environment model.

**Architecture:** Add a first-class world model state layer with bounded runtime snapshots and recent world changes, then migrate context construction, tool execution writeback, ORC prompt assembly, and trace semantics onto it in phases. Preserve runtime behavior during migration by treating legacy fields as temporary source material rather than long-term ORC language.

**Tech Stack:** Python, LangGraph-style assistant graph state, existing backend services and tool registry, pytest

---

### Task 1: Add world model state schema

**Files:**
- Modify: `backend/app/assistant_graph/state.py`
- Test: `backend/tests/assistant_graph/test_state_world_model.py`

**Step 1: Write the failing test**

Create tests that assert state helpers or defaults expose:
- `world_model`
- `runtime_snapshot`
- `recent_changes`

Include assertions for required nested keys such as `inventory_summary`, `active_window`, and `attention_state`.

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/assistant_graph/test_state_world_model.py -v`
Expected: FAIL because fields are undefined or missing.

**Step 3: Write minimal implementation**

Update `state.py` to define canonical schema defaults for:
- `world_model`
- `runtime_snapshot`
- `recent_changes`

Do not yet wire business logic into them.

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/assistant_graph/test_state_world_model.py -v`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/assistant_graph/state.py backend/tests/assistant_graph/test_state_world_model.py
git commit -m "feat: add assistant world model state schema"
```

### Task 2: Build world snapshot in context init

**Files:**
- Modify: `backend/app/assistant_graph/nodes/context_init.py`
- Test: `backend/tests/assistant_graph/nodes/test_context_init_world_snapshot.py`

**Step 1: Write the failing test**

Add a fixture state with source files, empty workspace views, and non-empty inventory metadata. Assert that `context_init` produces:
- bounded `inventory_summary`
- empty or small `active_window`
- initialized `attention_state`

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/assistant_graph/nodes/test_context_init_world_snapshot.py -v`
Expected: FAIL because snapshot is not produced.

**Step 3: Write minimal implementation**

In `context_init.py`:
- map current state into `inventory_summary`
- initialize `active_window.objects` and `active_window.relations`
- initialize `attention_state` with empty focused objects/domains and open questions derived from user request when available

Keep legacy fields intact for now.

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/assistant_graph/nodes/test_context_init_world_snapshot.py -v`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/assistant_graph/nodes/context_init.py backend/tests/assistant_graph/nodes/test_context_init_world_snapshot.py
git commit -m "feat: build runtime world snapshot in context init"
```

### Task 3: Switch ORC context assembly to snapshot summary

**Files:**
- Modify: `backend/app/assistant_graph/nodes/orc_loop.py`
- Test: `backend/tests/assistant_graph/nodes/test_orc_loop_world_snapshot_prompt.py`

**Step 1: Write the failing test**

Assert ORC context assembly includes:
- `runtime_snapshot.inventory_summary`
- `runtime_snapshot.attention_state`
- `recent_changes`

Assert direct legacy field exposure is reduced or no longer primary in the assembled prompt payload.

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/assistant_graph/nodes/test_orc_loop_world_snapshot_prompt.py -v`
Expected: FAIL because ORC prompt still depends mainly on fragmented fields.

**Step 3: Write minimal implementation**

Refactor `orc_loop.py` prompt assembly so ORC consumes a world snapshot summary instead of raw state fragments as primary language.

Do not remove all legacy fields yet if still needed for compatibility, but demote them from primary decision context.

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/assistant_graph/nodes/test_orc_loop_world_snapshot_prompt.py -v`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/assistant_graph/nodes/orc_loop.py backend/tests/assistant_graph/nodes/test_orc_loop_world_snapshot_prompt.py
git commit -m "refactor: drive orc prompt from world snapshot"
```

### Task 4: Write back tool outcomes as world changes

**Files:**
- Modify: `backend/app/assistant_graph/nodes/execution_runtime.py`
- Test: `backend/tests/assistant_graph/nodes/test_execution_runtime_world_changes.py`

**Step 1: Write the failing test**

Add cases for:
- successful KB evidence retrieval
- empty workspace read
- focus mutation or object creation

Assert each produces meaningful `recent_changes` entries and updates `attention_state` where appropriate.

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/assistant_graph/nodes/test_execution_runtime_world_changes.py -v`
Expected: FAIL because runtime does not yet write world change semantics.

**Step 3: Write minimal implementation**

Refactor tool result post-processing so execution outcomes produce:
- change records with `impact`
- updated `attention_state`
- bounded `recent_changes`

Keep old task result structures if still required downstream, but make world changes the new semantic source.

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/assistant_graph/nodes/test_execution_runtime_world_changes.py -v`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/assistant_graph/nodes/execution_runtime.py backend/tests/assistant_graph/nodes/test_execution_runtime_world_changes.py
git commit -m "feat: map tool outcomes to world changes"
```

### Task 5: Align tool registry with ontology metadata

**Files:**
- Modify: `backend/app/assistant_graph/tool_registry.py`
- Test: `backend/tests/assistant_graph/test_tool_registry_world_metadata.py`

**Step 1: Write the failing test**

Assert every ORC-exposed tool defines semantic metadata such as:
- `reads_kinds`
- `writes_kinds`
- `produces_kinds`
- `acts_on_domains`

Assert metadata values come from shared ontology terms rather than ad hoc strings.

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/assistant_graph/test_tool_registry_world_metadata.py -v`
Expected: FAIL because tool entries do not yet define ontology metadata.

**Step 3: Write minimal implementation**

Update `tool_registry.py` entries to declare ontology-aligned semantics.

Avoid adding routing rules. Only align tool descriptions and metadata with the world model.

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/assistant_graph/test_tool_registry_world_metadata.py -v`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/assistant_graph/tool_registry.py backend/tests/assistant_graph/test_tool_registry_world_metadata.py
git commit -m "refactor: align tool registry with world ontology"
```

### Task 6: Move trace semantics onto world changes

**Files:**
- Modify: trace-related backend files that assemble ORC/runtime trace events
- Test: `backend/tests/assistant_graph/test_trace_world_change_events.py`

**Step 1: Write the failing test**

Assert trace payloads are driven by:
- `attention_state`
- `recent_changes`
- action impact summaries

Assert trace no longer leaks technical prompt scaffolding as the main content.

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/assistant_graph/test_trace_world_change_events.py -v`
Expected: FAIL because trace still reflects technical event fragments.

**Step 3: Write minimal implementation**

Refactor trace assembly to derive human-facing trace semantics from world model deltas and attention changes.

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/assistant_graph/test_trace_world_change_events.py -v`
Expected: PASS

**Step 5: Commit**

```bash
git add <trace files> backend/tests/assistant_graph/test_trace_world_change_events.py
git commit -m "refactor: base trace on world change semantics"
```

### Task 7: Remove or demote fragmented legacy ORC-facing state

**Files:**
- Modify: `backend/app/assistant_graph/nodes/context_init.py`
- Modify: `backend/app/assistant_graph/nodes/orc_loop.py`
- Modify: `backend/app/assistant_graph/nodes/execution_runtime.py`
- Test: targeted regression tests for ORC context and runtime behavior

**Step 1: Write the failing test**

Add regression assertions that old fragmented fields are no longer the primary ORC-facing language and that world snapshot semantics remain intact across multi-turn interactions.

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/assistant_graph -k "world_snapshot or world_changes or trace_world" -v`
Expected: FAIL until legacy dependencies are removed or demoted.

**Step 3: Write minimal implementation**

Demote or delete fragmented ORC-facing state usage where the world model now fully covers the responsibility.

Be explicit about any legacy fields kept as internal runtime material only.

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/assistant_graph -k "world_snapshot or world_changes or trace_world" -v`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/assistant_graph/nodes/context_init.py backend/app/assistant_graph/nodes/orc_loop.py backend/app/assistant_graph/nodes/execution_runtime.py backend/tests/assistant_graph
git commit -m "refactor: complete world model migration"
```

### Task 8: Run focused regression verification

**Files:**
- No new product files
- Use existing tests and any request replay harness already in repo

**Step 1: Run focused backend tests**

Run the world model test set plus existing ORC/runtime suites that cover multi-turn request handling.

Suggested commands:
- `pytest backend/tests/assistant_graph -v`
- `pytest backend/tests -k "orc or runtime or trace" -v`

Expected: PASS

**Step 2: Run one request replay / integration verification**

Use the project's existing replay or simulation entrypoint for a multi-turn request with changing workspace state.

Expected:
- attention state carries across loops within a request
- recent changes affect subsequent reasoning
- world snapshot stays bounded

**Step 3: Document verification notes**

Append a short verification section to this plan or the design doc summarizing the commands used and results.

**Step 4: Commit**

```bash
git add docs/plans/2026-03-06-world-model-design.md docs/plans/2026-03-06-world-model-runtime-integration.md
git commit -m "docs: record world model integration verification"
```
