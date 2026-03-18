# ORC World Grounding Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make ORC reason from the current world situation first, and treat `tool_search` as an optional helper instead of a default entry step.

**Architecture:** Shift ORC from protocol-first planning to situation-first interpretation. Update the ORC prompt and context packaging so the model works on objects, domains, relations, and stalled paths before considering tools; then reshape runtime observations and tool search semantics so follow-up actions emerge from world updates instead of capability gap filling.

**Tech Stack:** Python, pytest, assistant graph runtime, Qwen chat client, tool catalog semantic search

---

### Task 1: Add regression tests for world-first ORC framing

**Files:**
- Modify: `backend/tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py`
- Test: `backend/tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py`

**Step 1: Write the failing test**

Add assertions that the ORC system prompt and user context no longer frame `tool_search` as a default first move and instead emphasize:
- situation interpretation before action selection
- object/domain/relation based reasoning
- `tool_search` only when direct action lacks a usable tool

**Step 2: Run test to verify it fails**

Run: `.\.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py -q`

Expected: FAIL because current prompt still centers action-contract/task planning and does not encode the new world-first framing.

**Step 3: Write minimal implementation**

Update `backend/app/assistant_graph/nodes/orc_loop.py` prompt text and any prompt-construction helpers required for the test to pass, without yet changing runtime observation shape.

**Step 4: Run test to verify it passes**

Run: `.\.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py -q`

Expected: PASS

**Step 5: Commit**

```bash
git add backend/tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py backend/app/assistant_graph/nodes/orc_loop.py
git commit -m "test: cover world-first orc framing"
```

### Task 2: Reduce ORC context emphasis on protocol history and highlight current world situation

**Files:**
- Modify: `backend/app/assistant_graph/nodes/orc_loop.py`
- Test: `backend/tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py`

**Step 1: Write the failing test**

Add a test that builds ORC context and asserts the outbound user payload foregrounds current world state and de-emphasizes raw task/protocol baggage. Verify:
- world-facing fields remain present
- task history is compact or omitted when not needed
- current actionable objects/domains are surfaced clearly

**Step 2: Run test to verify it fails**

Run: `.\.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py -q`

Expected: FAIL because current context object still includes broad task/protocol state that dominates the payload.

**Step 3: Write minimal implementation**

Refactor ORC context building in `backend/app/assistant_graph/nodes/orc_loop.py` so the payload is shaped around:
- latest user request
- current actionable objects/domains/relations
- stalled or invalid paths
- only the minimal recent evidence needed for the next decision

**Step 4: Run test to verify it passes**

Run: `.\.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py -q`

Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/assistant_graph/nodes/orc_loop.py backend/tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py
git commit -m "refactor: foreground world state in orc context"
```

### Task 3: Reframe runtime observations as world updates

**Files:**
- Modify: `backend/app/assistant_graph/nodes/execution_runtime.py`
- Test: `backend/tests/assistant_graph/test_execution_runtime_world_changes.py`

**Step 1: Write the failing test**

Add or extend tests so runtime results must expose world updates in a way ORC can reason over, including:
- what new objects/evidence became available
- what path was advanced or stalled
- which domain now contains actionable evidence

**Step 2: Run test to verify it fails**

Run: `.\.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_execution_runtime_world_changes.py -q`

Expected: FAIL because current observation/result summaries still read like tool receipts more than world changes.

**Step 3: Write minimal implementation**

Adjust result compaction and observation generation in `backend/app/assistant_graph/nodes/execution_runtime.py` so ORC receives world-update semantics instead of task bookkeeping semantics.

**Step 4: Run test to verify it passes**

Run: `.\.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_execution_runtime_world_changes.py -q`

Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/assistant_graph/nodes/execution_runtime.py backend/tests/assistant_graph/test_execution_runtime_world_changes.py
git commit -m "refactor: expose runtime world updates to orc"
```

### Task 4: Make tool search query semantics world-driven instead of capability-gap driven

**Files:**
- Modify: `backend/app/services/tool_search_service.py`
- Modify: `backend/app/assistant_graph/tool_registry.py`
- Test: `backend/tests/assistant_graph/test_tool_registry_world_metadata.py`
- Test: `backend/tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py`

**Step 1: Write the failing test**

Add tests that enforce the intended semantics:
- tool catalog text should support matching on domain/object contact semantics
- prompt wording should describe `tool_search` as optional and situation-triggered
- world-grounded query language should outperform plain request restatement in expectations encoded by tests

**Step 2: Run test to verify it fails**

Run: `.\.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_tool_registry_world_metadata.py tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py -q`

Expected: FAIL because catalog/query semantics still favor generic semantic similarity and capability wording.

**Step 3: Write minimal implementation**

Update:
- `backend/app/services/tool_search_service.py` catalog document text composition and any ranking cues
- `backend/app/assistant_graph/tool_registry.py` tool summaries/input hints where needed to reflect world-contact semantics rather than generic capability blurbs

Do not hardcode a special-case “always pick KB first”; preserve general behavior while making world-grounded intent easier to express and retrieve.

**Step 4: Run test to verify it passes**

Run: `.\.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_tool_registry_world_metadata.py tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py -q`

Expected: PASS

**Step 5: Commit**

```bash
git add backend/app/services/tool_search_service.py backend/app/assistant_graph/tool_registry.py backend/tests/assistant_graph/test_tool_registry_world_metadata.py backend/tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py
git commit -m "refactor: make tool search world driven"
```

### Task 5: Run focused verification for the full ORC world-grounding slice

**Files:**
- Verify only

**Step 1: Run focused backend verification**

Run:

```bash
.\.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py tests/assistant_graph/test_execution_runtime_world_changes.py tests/assistant_graph/test_tool_registry_world_metadata.py tests/services/test_qwen_client_stream_contract.py -q
```

Expected: all selected tests PASS.

**Step 2: Run compile verification**

Run:

```bash
.\.venv\Scripts\python.exe -m py_compile app/assistant_graph/nodes/orc_loop.py app/assistant_graph/nodes/execution_runtime.py app/services/tool_search_service.py app/assistant_graph/tool_registry.py
```

Expected: no output, exit code 0.

**Step 3: Review diff for accidental scope creep**

Run:

```bash
git diff -- backend/app/assistant_graph/nodes/orc_loop.py backend/app/assistant_graph/nodes/execution_runtime.py backend/app/services/tool_search_service.py backend/app/assistant_graph/tool_registry.py backend/tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py backend/tests/assistant_graph/test_execution_runtime_world_changes.py backend/tests/assistant_graph/test_tool_registry_world_metadata.py
```

Expected: only world-grounding related changes appear.

**Step 4: Commit**

```bash
git add backend/app/assistant_graph/nodes/orc_loop.py backend/app/assistant_graph/nodes/execution_runtime.py backend/app/services/tool_search_service.py backend/app/assistant_graph/tool_registry.py backend/tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py backend/tests/assistant_graph/test_execution_runtime_world_changes.py backend/tests/assistant_graph/test_tool_registry_world_metadata.py
git commit -m "refactor: ground orc decisions in world state"
```
