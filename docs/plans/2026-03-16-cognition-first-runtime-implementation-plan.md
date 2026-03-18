# Cognition-First Runtime Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Introduce a cognition-first blackboard into the current agent runtime and make model input depend on shared reference state before retrieval.

**Architecture:** Add a dedicated blackboard module, wire it into `runtime_bootstrap.py`, and shift `memory_sync` to produce structured observation plus cognitive state. Keep external runtime APIs stable while replacing the internal decision framing.

**Tech Stack:** Python, LangGraph runtime, pytest

---

### Task 1: Add blackboard design tests

**Files:**
- Create: `backend/tests/assistant_graph/test_cognition_blackboard.py`
- Modify: `backend/tests/assistant_graph/test_environment_driven_policy_input.py`

**Step 1: Write the failing test**

Add tests for:
- extracting a question reference from user text
- detecting container ambiguity when workspace is empty and KB has multiple source documents
- building a cognition-first `model_messages[0].content` payload from `_node_memory_sync`

**Step 2: Run test to verify it fails**

Run: `d:\Exam-paper\backend\.venv\Scripts\python.exe -m pytest -q tests/assistant_graph/test_cognition_blackboard.py tests/assistant_graph/test_environment_driven_policy_input.py`

Expected: FAIL because the blackboard module and cognition-first payload do not exist yet.

**Step 3: Commit**

Do not commit yet.

### Task 2: Implement blackboard primitives

**Files:**
- Create: `backend/app/agent/assistant_graph/cognition_blackboard.py`

**Step 1: Write minimal implementation**

Implement:
- object-expression extraction
- scene summary
- reference hypotheses
- ambiguity derivation
- cognition-first policy input builder

**Step 2: Run tests**

Run the same targeted pytest command and verify the new module tests now pass or narrow to runtime integration failures.

### Task 3: Wire blackboard into runtime state

**Files:**
- Modify: `backend/app/agent/assistant_graph/runtime_bootstrap.py`

**Step 1: Update state shape**

Add `cognitive_blackboard` to `GraphState`.

**Step 2: Update prepare + memory_sync**

Initialize and rebuild the blackboard each turn, and replace the old flattened model snapshot with the cognition-first payload.

**Step 3: Run tests**

Run: `d:\Exam-paper\backend\.venv\Scripts\python.exe -m pytest -q tests/assistant_graph/test_cognition_blackboard.py tests/assistant_graph/test_environment_driven_policy_input.py`

Expected: PASS

### Task 4: Preserve compatibility helpers

**Files:**
- Modify: `backend/app/agent/assistant_graph/runtime_bootstrap.py`

**Step 1: Keep export compatibility**

Ensure existing tests and callers can still import the same runtime helpers.

**Step 2: Run focused regression tests**

Run: `d:\Exam-paper\backend\.venv\Scripts\python.exe -m pytest -q tests/assistant_graph/test_tool_error_feedback.py tests/assistant_graph/test_interrupt_resume_payload_parsing.py tests/assistant_graph/test_no_runtime_selector_contract.py`

Expected: PASS

### Task 5: Verify and summarize

**Files:**
- None

**Step 1: Run combined targeted verification**

Run: `d:\Exam-paper\backend\.venv\Scripts\python.exe -m pytest -q tests/assistant_graph/test_cognition_blackboard.py tests/assistant_graph/test_environment_driven_policy_input.py tests/assistant_graph/test_tool_error_feedback.py tests/assistant_graph/test_interrupt_resume_payload_parsing.py tests/assistant_graph/test_no_runtime_selector_contract.py`

Expected: PASS

**Step 2: Review diff**

Run: `git diff -- backend/app/agent/assistant_graph/cognition_blackboard.py backend/app/agent/assistant_graph/runtime_bootstrap.py backend/tests/assistant_graph/test_cognition_blackboard.py backend/tests/assistant_graph/test_environment_driven_policy_input.py docs/plans/2026-03-16-cognition-first-runtime-design.md docs/plans/2026-03-16-cognition-first-runtime-implementation-plan.md`
