# ORC Single-Step Agent Loop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace ORC's static task-board planning loop with a single-step agent loop where each ORC pass chooses exactly one next action and the outer loop accumulates a full decision closure over repeated observe -> act -> observe iterations.

**Architecture:** Keep the existing outer graph loop (`orc_loop -> execution_runtime -> orc_loop`) but change the contract between ORC and runtime. ORC should no longer emit a batch of future tasks; instead it emits one immediate action (`tool`, `reply`, `interrupt`, or `finish`). Runtime executes that one action, updates world state, and returns control so the next ORC pass can react to the new world rather than a precomputed workflow.

**Tech Stack:** Python, FastAPI, LangGraph, Qwen client, assistant graph runtime

---

### Task 1: Freeze the target behavior with failing loop-contract tests

**Files:**
- Create: `backend/tests/assistant_graph/test_orc_single_step_loop.py`
- Modify: `backend/tests/assistant_graph/test_orc_loop_behavior.py`

**Step 1: Write the failing test**

Add tests that assert:

- ORC can output only one immediate action per pass
- `tool_search -> read_kb_evidence` cannot be emitted as a future batch in one ORC payload
- after one tool result is returned, the next ORC pass is allowed to choose a different next action based on the updated world

Include one test for allowed payloads:

```python
def test_orc_accepts_single_tool_action_payload():
    payload = {
        "next_action": "tool",
        "tool": "tool_search",
        "inputs": {"query": "我需要一个读取知识库的工具"},
    }
```

Include one test for rejected payloads:

```python
def test_orc_rejects_multi_step_task_board_payload():
    payload = {
        "next_action": "act",
        "tasks": [
            {"task_id": "a", "tool": "tool_search"},
            {"task_id": "b", "tool": "read_kb_evidence"},
        ],
    }
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd backend
.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_orc_single_step_loop.py tests/assistant_graph/test_orc_loop_behavior.py -v
```

Expected:

- FAIL because current ORC still centers on `tasks[]` and multi-step planning

**Step 3: Commit**

```bash
git add backend/tests/assistant_graph/test_orc_single_step_loop.py backend/tests/assistant_graph/test_orc_loop_behavior.py
git commit -m "test: lock single-step orc loop contract"
```

### Task 2: Replace ORC output contract with a single immediate action

**Files:**
- Modify: `backend/app/assistant_graph/nodes/orc_loop.py`
- Test: `backend/tests/assistant_graph/test_orc_single_step_loop.py`

**Step 1: Write the failing test**

Add tests for:

- accepted actions: `tool`, `reply`, `interrupt`, `finish`
- `tool` payload contains exactly one `tool` and one `inputs` object
- ORC prompt no longer requires `tasks[]`, `depends_on`, or `tool_decision`

**Step 2: Run test to verify it fails**

Run:

```bash
cd backend
.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_orc_single_step_loop.py -v
```

Expected:

- FAIL because current parser/validator still requires task-board semantics

**Step 3: Write minimal implementation**

In `orc_loop.py`:

- replace the current JSON schema contract with a single-action contract
- remove `tasks[]` normalization as the main path
- add a parser that normalizes:
  - `{"next_action":"tool","tool":"tool_search","inputs":{...}}`
  - `{"next_action":"reply","final_answer":"..."}`
  - `{"next_action":"interrupt","interrupt_payload":{...}}`
  - `{"next_action":"finish","final_answer":"..."}`
- store the chosen immediate action on state, e.g.:
  - `pending_tool_action`
  - `assistant_reply`
  - `pending_interrupt`

**Step 4: Run test to verify it passes**

Run:

```bash
cd backend
.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_orc_single_step_loop.py -v
```

Expected:

- PASS

**Step 5: Commit**

```bash
git add backend/app/assistant_graph/nodes/orc_loop.py backend/tests/assistant_graph/test_orc_single_step_loop.py
git commit -m "refactor: switch orc to single-step action contract"
```

### Task 3: Convert execution runtime to execute one immediate action

**Files:**
- Modify: `backend/app/assistant_graph/nodes/execution_runtime.py`
- Test: `backend/tests/assistant_graph/test_execution_runtime_world_changes.py`
- Test: `backend/tests/assistant_graph/test_orc_single_step_loop.py`

**Step 1: Write the failing test**

Add tests asserting:

- runtime executes one pending tool action, not a static batch
- tool result updates:
  - `last_observation`
  - `execution_observation`
  - `recent_changes`
  - `loaded_tools`
  - `vision_assets`
- runtime clears the consumed pending action before returning control

**Step 2: Run test to verify it fails**

Run:

```bash
cd backend
.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_execution_runtime_world_changes.py tests/assistant_graph/test_orc_single_step_loop.py -v
```

Expected:

- FAIL because runtime still expects `active_tasks`

**Step 3: Write minimal implementation**

In `execution_runtime.py`:

- add a code path that consumes one `pending_tool_action`
- resolve tool permissions against current `loaded_tools`
- execute exactly one worker
- merge returned state delta
- emit one tool-start and one tool-end trace
- write the result into state as the latest observation

Do not add workflow branching such as “if tool_search then load next”.

**Step 4: Run test to verify it passes**

Run:

```bash
cd backend
.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_execution_runtime_world_changes.py tests/assistant_graph/test_orc_single_step_loop.py -v
```

Expected:

- PASS

**Step 5: Commit**

```bash
git add backend/app/assistant_graph/nodes/execution_runtime.py backend/tests/assistant_graph/test_execution_runtime_world_changes.py backend/tests/assistant_graph/test_orc_single_step_loop.py
git commit -m "refactor: execute single pending tool action per runtime pass"
```

### Task 4: Shrink ORC-visible world to action-relevant state only

**Files:**
- Modify: `backend/app/assistant_graph/nodes/orc_loop.py`
- Test: `backend/tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py`

**Step 1: Write the failing test**

Add tests asserting ORC sees:

- latest user message
- compact dialogue window
- visible workbench objects
- visible evidence
- currently loaded tools
- latest observation/world delta

and does not see:

- raw task history
- task-board fields
- internal telemetry counters

**Step 2: Run test to verify it fails**

Run:

```bash
cd backend
.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py -v
```

Expected:

- FAIL if old planning metadata still leaks into prompt

**Step 3: Write minimal implementation**

Update ORC context builder so the next decision is grounded in:

- current world
- latest result
- current capability set

not in a planner-oriented protocol blob.

**Step 4: Run test to verify it passes**

Run:

```bash
cd backend
.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py -v
```

Expected:

- PASS

**Step 5: Commit**

```bash
git add backend/app/assistant_graph/nodes/orc_loop.py backend/tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py
git commit -m "refactor: ground orc in visible world and latest observation"
```

### Task 5: Rewire graph routing to support repeated single-step tool calls within one agent loop

**Files:**
- Modify: `backend/app/assistant_graph/nodes/orc_loop.py`
- Modify: `backend/app/assistant_graph/builder.py`
- Test: `backend/tests/assistant_graph/test_orc_run_scope_reset.py`
- Test: `backend/tests/assistant_graph/test_orc_single_step_loop.py`

**Step 1: Write the failing test**

Add tests asserting:

- ORC can emit `tool` on pass 1
- runtime executes it
- ORC is called again with updated world
- ORC can emit another `tool` or `reply`
- the outer loop still enforces max step budget

**Step 2: Run test to verify it fails**

Run:

```bash
cd backend
.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_orc_run_scope_reset.py tests/assistant_graph/test_orc_single_step_loop.py -v
```

Expected:

- FAIL because state currently assumes task-board semantics

**Step 3: Write minimal implementation**

Keep the graph topology, but change route semantics:

- `tool` => go to `execution_runtime`
- `reply|finish` => go to `responder`
- `interrupt` => go to `human_io`

Ensure the loop budget increments once per ORC pass, not once per tool call inside runtime.

**Step 4: Run test to verify it passes**

Run:

```bash
cd backend
.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_orc_run_scope_reset.py tests/assistant_graph/test_orc_single_step_loop.py -v
```

Expected:

- PASS

**Step 5: Commit**

```bash
git add backend/app/assistant_graph/nodes/orc_loop.py backend/app/assistant_graph/builder.py backend/tests/assistant_graph/test_orc_run_scope_reset.py backend/tests/assistant_graph/test_orc_single_step_loop.py
git commit -m "refactor: route graph by single-step orc actions"
```

### Task 6: Add end-to-end behavioral regression for non-workflow agent loop

**Files:**
- Create: `backend/tests/assistant_graph/test_orc_agentic_behavior.py`

**Step 1: Write the failing test**

Add a scenario test that verifies:

- ORC sees knowledge-base world
- first pass chooses `tool_search`
- second pass reacts to tool result rather than replaying a precomputed plan
- next pass can choose a different tool based on new world state
- no static task board appears in any ORC payload

**Step 2: Run test to verify it fails**

Run:

```bash
cd backend
.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_orc_agentic_behavior.py -v
```

Expected:

- FAIL on current planner-style behavior

**Step 3: Write minimal implementation**

Only fill any missing glue needed so the scenario runs through the new single-step loop without task-board artifacts.

**Step 4: Run test to verify it passes**

Run:

```bash
cd backend
.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_orc_agentic_behavior.py -v
```

Expected:

- PASS

**Step 5: Commit**

```bash
git add backend/tests/assistant_graph/test_orc_agentic_behavior.py
git commit -m "test: add agentic single-step loop regression"
```

### Task 7: Run focused verification suite

**Files:**
- Test: `backend/tests/assistant_graph/test_orc_single_step_loop.py`
- Test: `backend/tests/assistant_graph/test_orc_agentic_behavior.py`
- Test: `backend/tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py`
- Test: `backend/tests/assistant_graph/test_execution_runtime_world_changes.py`
- Test: `backend/tests/assistant_graph/test_orc_run_scope_reset.py`

**Step 1: Run focused suite**

Run:

```bash
cd backend
.venv\Scripts\python.exe -m pytest tests/assistant_graph/test_orc_single_step_loop.py tests/assistant_graph/test_orc_agentic_behavior.py tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py tests/assistant_graph/test_execution_runtime_world_changes.py tests/assistant_graph/test_orc_run_scope_reset.py -v
```

Expected:

- PASS

**Step 2: Run one broader safety suite**

Run:

```bash
cd backend
.venv\Scripts\python.exe -m pytest tests/assistant_graph -q
```

Expected:

- no regressions in adjacent assistant graph behavior

**Step 3: Commit**

```bash
git add backend/app/assistant_graph/nodes/orc_loop.py backend/app/assistant_graph/nodes/execution_runtime.py backend/app/assistant_graph/builder.py backend/tests/assistant_graph/
git commit -m "refactor: make orc a single-step agent loop"
```
