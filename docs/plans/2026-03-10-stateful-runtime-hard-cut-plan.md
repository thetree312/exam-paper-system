# Stateful Runtime Hard-Cut Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current ORC input/recovery path with a runtime-held, checkpointer-friendly model-view boundary that no longer feeds engineering summaries back into the model.

**Architecture:** Keep the existing LangGraph graph and Postgres checkpointer, but hard-cut the model-visible boundary. `context_init` will only prepare runtime state, `agent_observation` becomes a single model-view serializer, `orc_loop` will consume only that model view plus real tool results, and `persist` will stop generating continuation prompt summaries. This aligns the codebase more closely with LangGraph persistence principles: thread-scoped state stays in the runtime, not in prompt reassembly.

**Tech Stack:** Python, LangGraph, PostgresSaver, pytest

---

### Task 1: Lock the New Boundary in Tests

**Files:**
- Modify: `backend/tests/assistant_graph/test_context_init_world_snapshot.py`
- Modify: `backend/tests/assistant_graph/test_orc_single_step_loop.py`
- Modify: `backend/tests/assistant_graph/test_persist_continuation_summary.py`
- Modify: `backend/tests/assistant_graph/test_router_source_binding_and_human_io.py`

**Step 1: Write the failing tests**

- Assert `context_init_node()` no longer writes `agent_observation`, `active_observation_buffer`, `current_intent`, `source_semantics`, or `context_budget_meta`.
- Assert ORC user payload is built from the single model-view serializer and no longer depends on `state["agent_observation"]`.
- Assert `persist_node()` stores continuation data without `continuation_summary_v1`.
- Assert continuation seed extraction still works when only raw loaded tools and tool search history exist.

**Step 2: Run tests to verify they fail**

Run:
```bash
.\.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_context_init_world_snapshot.py tests/assistant_graph/test_orc_single_step_loop.py tests/assistant_graph/test_persist_continuation_summary.py tests/assistant_graph/test_router_source_binding_and_human_io.py -q
```

**Step 3: Confirm the failures are boundary-related**

- Missing/extra fields in `context_init`
- ORC still reading legacy observation state
- Persist still emitting continuation summary

---

### Task 2: Replace `agent_observation` with a Single Model View

**Files:**
- Modify: `backend/app/assistant_graph/agent_observation.py`
- Modify: `backend/tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py`

**Step 1: Write the failing tests**

- Add/adjust tests so the module exports `build_model_view()` and `serialize_agent_input()`.
- Assert `build_model_view()` includes:
  - `user_question`
  - `workspace`
  - `sources`
  - `visual`
  - `evidence`
  - `last_tool_result`
- Assert it excludes:
  - `attention_state`
  - `recent_changes`
  - `current_intent`
  - `execution_observation`

**Step 2: Run tests to verify they fail**

Run:
```bash
.\.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py tests/assistant_graph/test_orc_single_step_loop.py -q
```

**Step 3: Write minimal implementation**

- Rename the public boundary concept from `build_agent_observation()` to `build_model_view()`.
- Build the view directly from runtime state and task results.
- Add `last_tool_result` from the latest tool result instead of `active_observation_buffer`.
- Keep `serialize_agent_input()` as the only serializer.

---

### Task 3: Hard-Cut `context_init` and `orc_loop`

**Files:**
- Modify: `backend/app/assistant_graph/nodes/context_init.py`
- Modify: `backend/app/assistant_graph/nodes/orc_loop.py`

**Step 1: Write the failing tests**

- Assert `context_init_node()` only prepares runtime state and does not materialize model-facing summary fields.
- Assert `orc_loop` builds context from `build_model_view(state)` on demand.
- Assert `_build_orc_context()` no longer carries `agent_observation` or `active_observation_buffer`.
- Assert tool loop user content is derived from `last_tool_result` deltas instead of active observation buffers.

**Step 2: Run tests to verify they fail**

Run:
```bash
.\.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_context_init_world_snapshot.py tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py tests/assistant_graph/test_orc_single_step_loop.py -q
```

**Step 3: Write minimal implementation**

- Remove `build_agent_observation()` calls from `context_init` and `execution_runtime`.
- Stop writing:
  - `agent_observation`
  - `active_observation_buffer`
  - `current_intent`
  - `source_semantics`
  - `context_budget_meta`
- In `orc_loop`, replace cached observation state with `build_model_view(state)`.
- Replace incremental observation buffering with `last_tool_result` extraction from `task_results`.

---

### Task 4: Downgrade `persist` to Persistence Only

**Files:**
- Modify: `backend/app/assistant_graph/nodes/persist.py`
- Modify: `backend/app/services/agent_runtime_bootstrap_service.py`
- Modify: `backend/tests/assistant_graph/test_persist_continuation_summary.py`
- Modify: `backend/tests/assistant_graph/test_router_source_binding_and_human_io.py`

**Step 1: Write the failing tests**

- Assert `persist_node()` no longer writes `continuation_summary_v1`.
- Assert it still writes:
  - `continuation_loaded_tools`
  - `continuation_tool_search_history`
- Assert runtime bootstrap can resume from those raw fields without the old summary blob.

**Step 2: Run tests to verify they fail**

Run:
```bash
.\.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_persist_continuation_summary.py tests/assistant_graph/test_router_source_binding_and_human_io.py -q
```

**Step 3: Write minimal implementation**

- Remove `_build_continuation_summary()` from the persist flow.
- Persist only raw continuation metadata needed for recovery, not prompt-facing explanation.
- Relax bootstrap extraction so summary absence is valid.

---

### Task 5: Strip Execution-Runtime Backflow and Verify

**Files:**
- Modify: `backend/app/assistant_graph/nodes/execution_runtime.py`
- Modify: `backend/tests/assistant_graph/test_execution_runtime_world_changes.py`
- Modify: `backend/tests/assistant_graph/test_workspace_assets_runtime.py`

**Step 1: Write the failing tests**

- Assert `execution_runtime_node()` does not rebuild model-view caches.
- Assert world changes can remain internal runtime state without being converted into model-facing summaries.
- Keep `execution_observation` only if still needed for internal diagnostics; do not rely on it for ORC input.

**Step 2: Run tests to verify they fail**

Run:
```bash
.\.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_execution_runtime_world_changes.py tests/assistant_graph/test_workspace_assets_runtime.py -q
```

**Step 3: Write minimal implementation**

- Remove observation cache rebuilds from `execution_runtime`.
- Keep raw `task_results`, `recent_changes`, and `runtime_snapshot` for runtime/checkpointer use.
- Ensure ORC no longer reads runtime summaries.

---

### Task 6: Full Verification

**Files:**
- No code changes required

**Step 1: Run focused suites**

```bash
.\.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_context_init_world_snapshot.py tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py tests/assistant_graph/test_orc_single_step_loop.py tests/assistant_graph/test_persist_continuation_summary.py tests/assistant_graph/test_router_source_binding_and_human_io.py tests/assistant_graph/test_execution_runtime_world_changes.py -q
```

**Step 2: Run full graph suite**

```bash
.\.venv\Scripts\python.exe -m pytest tests/assistant_graph -q
```

**Step 3: Record remaining failures exactly**

- If failures remain, classify them as:
  - intentional compatibility breaks
  - unrelated pre-existing failures
  - regressions from the hard cut
