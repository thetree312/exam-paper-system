# LangGraph Agent Runtime Rebuild Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current pseudo-agent loop with a real state-first LangGraph runtime that persists structured observations, enforces stop conditions, and maintains stable session continuity.

**Architecture:** Collapse the current split runtime into one typed LangGraph state, one graph, and one tool execution contract. The new graph should explicitly separate context hydration, model planning, tool execution, observation integration, continuation decisions, and final response synthesis. Session continuity and streaming stay outside the graph, but they must consume and persist the same runtime state instead of rebuilding shadow state.

**Governing Standard:** See [agentic-runtime-acceptance.md](d:/Exam-paper/docs/architecture/agentic-runtime-acceptance.md). Any implementation that lets engineering code decide the main next action, or that fabricates cognition trace from backend/runtime steps, fails review.

**Tech Stack:** FastAPI, LangGraph, LangChain message/tool primitives, Postgres checkpointer, pytest

---

### Task 1: Freeze the target architecture in code comments and tests

**Files:**
- Modify: `backend/tests/assistant_graph/test_agent_graph_runtime.py`
- Modify: `backend/tests/assistant_graph/test_state_world_model.py`
- Create: `backend/tests/assistant_graph/test_agent_session_runtime_contract.py`

**Step 1: Write failing graph contract tests**

Add tests that assert the new graph contains these nodes:
- `hydrate_context`
- `plan_or_answer`
- `execute_tools`
- `integrate_observations`
- `decide_next`
- `finalize`

Also assert the old assumptions are gone:
- no node pair limited to `reason/act/observe`
- no routing rule based only on `tool_calls`

**Step 2: Write failing state contract tests**

Add tests that assert the runtime state exposes structured fields such as:
- `messages`
- `tool_requests`
- `tool_results`
- `observation_log`
- `evidence_state`
- `workspace_state`
- `loop_budget`
- `halt_reason`
- `session_context`

**Step 3: Write failing session contract tests**

Add tests that assert:
- `no-doc` runs still reuse a stable `thread_id` when a session exists
- `run` and `resume` resolve the same thread/session pairing
- session continuity does not depend on `workspace_document_id`

**Step 4: Run the focused tests to confirm failure**

Run: `backend\.venv\Scripts\python.exe -m pytest backend/tests/assistant_graph/test_agent_graph_runtime.py backend/tests/assistant_graph/test_state_world_model.py backend/tests/assistant_graph/test_agent_session_runtime_contract.py -q`

Expected: FAIL because the runtime still exposes the old graph and state shape.

**Step 5: Commit**

```bash
git add backend/tests/assistant_graph/test_agent_graph_runtime.py backend/tests/assistant_graph/test_state_world_model.py backend/tests/assistant_graph/test_agent_session_runtime_contract.py
git commit -m "test: lock target langgraph runtime contracts"
```

### Task 2: Replace the split state model with one runtime state

**Files:**
- Modify: `backend/app/assistant_graph/state.py`
- Modify: `backend/app/assistant_graph/__init__.py`
- Modify: `backend/tests/assistant_graph/test_state_world_model.py`

**Step 1: Write the failing reducer-level tests**

Add tests covering:
- `messages` appends rather than replaces
- `tool_results` and `observation_log` accumulate
- `loop_budget` overwrites as a scalar
- default state hydration populates empty structured containers

**Step 2: Implement the new typed state**

Refactor `state.py` so that:
- one `AgentRuntimeState` becomes the only graph state type
- reducers are explicit for append-only collections
- environment, observations, evidence, workspace focus, and session metadata live in state
- helper functions hydrate defaults without creating an alternate shadow schema

**Step 3: Update exports to remove ambiguous aliases**

Make `__init__.py` expose the new state type and remove any naming that suggests multiple primary state models.

**Step 4: Run the state tests**

Run: `backend\.venv\Scripts\python.exe -m pytest backend/tests/assistant_graph/test_state_world_model.py -q`

Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/assistant_graph/state.py backend/app/assistant_graph/__init__.py backend/tests/assistant_graph/test_state_world_model.py
git commit -m "refactor: unify langgraph runtime state"
```

### Task 3: Replace tool wrappers with a structured tool execution contract

**Files:**
- Modify: `backend/app/assistant_graph/agent_tools.py`
- Modify: `backend/app/assistant_graph/tool_runtime.py`
- Modify: `backend/tests/assistant_graph/test_execution_runtime_world_changes.py`
- Modify: `backend/tests/assistant_graph/test_tool_registry_world_metadata.py`

**Step 1: Write failing tests for tool outputs**

Add tests that require each tool execution to return a structured record with:
- `tool_name`
- `tool_call_id`
- `status`
- `observation`
- `state_delta`
- `display_payload`

Reject implementations that only return compact JSON strings intended for `ToolMessage`.

**Step 2: Implement a single tool execution envelope**

Refactor tool execution so each tool:
- receives the full runtime state
- returns normalized structured results
- emits a model-facing payload separately from the runtime-facing state delta
- never rebuilds a partial fake state for worker calls

**Step 3: Preserve compatibility at the graph boundary only**

If legacy workers still exist, adapt them inside the tool layer, not in the graph nodes and not in the router.

**Step 4: Run focused tool tests**

Run: `backend\.venv\Scripts\python.exe -m pytest backend/tests/assistant_graph/test_execution_runtime_world_changes.py backend/tests/assistant_graph/test_tool_registry_world_metadata.py -q`

Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/assistant_graph/agent_tools.py backend/app/assistant_graph/tool_runtime.py backend/tests/assistant_graph/test_execution_runtime_world_changes.py backend/tests/assistant_graph/test_tool_registry_world_metadata.py
git commit -m "refactor: normalize agent tool execution results"
```

### Task 4: Rebuild the LangGraph topology around explicit decisions

**Files:**
- Modify: `backend/app/assistant_graph/agent_graph.py`
- Create: `backend/app/assistant_graph/graph_nodes.py`
- Modify: `backend/tests/assistant_graph/test_agent_graph_runtime.py`

**Step 1: Write failing routing tests**

Add tests for:
- direct answer path when enough evidence exists
- tool execution path when the planner requests tools
- halt path when loop budget is exhausted
- ask-user path when required context is missing

**Step 2: Implement the new node set**

Move node logic into dedicated functions:
- `hydrate_context`
- `plan_or_answer`
- `execute_tools`
- `integrate_observations`
- `decide_next`
- `finalize`

Use conditional edges or `Command` so continuation depends on runtime state, not just on raw `tool_calls`.

**Step 3: Add loop safety**

Implement:
- max iterations
- duplicate tool request detection
- empty-observation detection
- explicit `halt_reason`

**Step 4: Run graph tests**

Run: `backend\.venv\Scripts\python.exe -m pytest backend/tests/assistant_graph/test_agent_graph_runtime.py -q`

Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/assistant_graph/agent_graph.py backend/app/assistant_graph/graph_nodes.py backend/tests/assistant_graph/test_agent_graph_runtime.py
git commit -m "refactor: rebuild langgraph agent topology"
```

### Task 5: Redesign session continuity outside the graph, but against the same state model

**Files:**
- Modify: `backend/app/assistant_graph/session_runtime.py`
- Modify: `backend/app/routers/agent_v2.py`
- Modify: `backend/tests/assistant_graph/test_agent_session_runtime_contract.py`
- Modify: `backend/tests/assistant_graph/test_router_source_binding_and_human_io.py`

**Step 1: Write failing continuity tests**

Cover:
- stable `thread_id` reuse for existing sessions
- stable continuity for `no-doc`
- correct behavior for `run-stream` followed by `resume`
- no random UUID fallback when a business session already exists

**Step 2: Implement stable session resolution**

Refactor session resolution so:
- `session_id` is the primary continuity handle
- `thread_id` is derived once and reused
- `no-doc` sessions can still be persistent
- resume and run share the same resolution path

**Step 3: Update router integration**

Keep the router thin:
- resolve session/runtime context
- invoke graph
- stream graph output
- persist visible messages and structured summary fields

**Step 4: Run session and router tests**

Run: `backend\.venv\Scripts\python.exe -m pytest backend/tests/assistant_graph/test_agent_session_runtime_contract.py backend/tests/assistant_graph/test_router_source_binding_and_human_io.py -q`

Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/assistant_graph/session_runtime.py backend/app/routers/agent_v2.py backend/tests/assistant_graph/test_agent_session_runtime_contract.py backend/tests/assistant_graph/test_router_source_binding_and_human_io.py
git commit -m "refactor: stabilize agent session continuity"
```

### Task 6: Clean encoding and prompt artifacts end-to-end

**Files:**
- Modify: `backend/app/assistant_graph/agent_graph.py`
- Modify: `backend/app/assistant_graph/agent_tools.py`
- Modify: `backend/app/assistant_graph/router_runtime.py`
- Modify: `backend/tests/assistant_graph/test_agent_graph_runtime.py`
- Modify: `backend/tests/assistant_graph/test_agent_stream_trace_events.py`

**Step 1: Write failing readability tests**

Assert that:
- system prompts are valid readable Chinese or English strings
- tool descriptions are readable
- environment messages are readable
- tests no longer assert mojibake fragments

**Step 2: Replace corrupted literals**

Update runtime prompts, tool descriptions, and test fixtures to valid UTF-8 source content already stored correctly in the repository.

**Step 3: Run the readability and trace tests**

Run: `backend\.venv\Scripts\python.exe -m pytest backend/tests/assistant_graph/test_agent_graph_runtime.py backend/tests/assistant_graph/test_agent_stream_trace_events.py -q`

Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/assistant_graph/agent_graph.py backend/app/assistant_graph/agent_tools.py backend/app/assistant_graph/router_runtime.py backend/tests/assistant_graph/test_agent_graph_runtime.py backend/tests/assistant_graph/test_agent_stream_trace_events.py
git commit -m "fix: restore readable runtime prompts and trace fixtures"
```

### Task 7: Rework streaming to reflect graph state instead of ad hoc inference

**Files:**
- Modify: `backend/app/assistant_graph/router_runtime.py`
- Modify: `backend/app/routers/agent_v2.py`
- Modify: `backend/tests/assistant_graph/test_agent_stream_trace_events.py`
- Create: `backend/tests/assistant_graph/test_agent_streaming_runtime_contract.py`

**Step 1: Write failing streaming contract tests**

Cover:
- assistant text streaming
- structured thought streaming
- tool call streaming after aggregation
- tool result streaming from normalized tool envelopes
- final reply fallback when no token stream is emitted

**Step 2: Refactor stream extraction**

Make trace emission derive from normalized graph node outputs and tool envelopes rather than heuristics on partially streamed messages.

**Step 3: Run streaming tests**

Run: `backend\.venv\Scripts\python.exe -m pytest backend/tests/assistant_graph/test_agent_stream_trace_events.py backend/tests/assistant_graph/test_agent_streaming_runtime_contract.py -q`

Expected: PASS

**Step 4: Commit**

```bash
git add backend/app/assistant_graph/router_runtime.py backend/app/routers/agent_v2.py backend/tests/assistant_graph/test_agent_stream_trace_events.py backend/tests/assistant_graph/test_agent_streaming_runtime_contract.py
git commit -m "refactor: align streaming with runtime state"
```

### Task 8: Run full runtime verification

**Files:**
- Modify: `docs/plans/2026-03-11-langgraph-agent-runtime-rebuild-plan.md`

**Step 1: Run targeted assistant graph tests**

Run: `backend\.venv\Scripts\python.exe -m pytest backend/tests/assistant_graph -q`

Expected: PASS

**Step 2: Run syntax verification**

Run: `backend\.venv\Scripts\python.exe -m py_compile backend/app/assistant_graph/agent_graph.py backend/app/assistant_graph/graph_nodes.py backend/app/assistant_graph/agent_tools.py backend/app/assistant_graph/router_runtime.py backend/app/assistant_graph/session_runtime.py backend/app/routers/agent_v2.py`

Expected: no output

**Step 3: Run one real smoke scenario**

Exercise one `run-stream` call against a knowledge-base question and record:
- emitted `thought/tool_call/tool_result`
- whether the graph stops naturally
- whether the next turn reuses the same session/thread

**Step 4: Record verification notes**

Append the final command results and any residual risks to this plan document.

**Step 5: Commit**

```bash
git add docs/plans/2026-03-11-langgraph-agent-runtime-rebuild-plan.md
git commit -m "docs: record runtime rebuild verification"
```
