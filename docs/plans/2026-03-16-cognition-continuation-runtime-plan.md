# Cognition Continuation Runtime Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor the assistant runtime so the model's formal output is a cognitive update plus continuation commitment, not an action-first decision.

**Architecture:** Keep the existing graph shape for now, but change the decision contract and state propagation. `decide` will emit a cognition-first payload, `memory_sync` will carry forward cognitive state, and the execution node will only honor explicit continuation commitments already produced by the model.

**Tech Stack:** Python, LangGraph, pytest

---

### Task 1: Lock the new decision contract with tests

**Files:**
- Modify: `backend/tests/assistant_graph/test_cognitive_decision_runtime.py`

**Step 1: Write the failing test**

Add tests that require:
- `decide` to accept `cognitive_update` + `continuation_commitment`
- `decide` to store cognitive state separately from execution payload
- execution to consume explicit continuation commitments rather than `action.kind`

**Step 2: Run test to verify it fails**

Run: `pytest backend/tests/assistant_graph/test_cognitive_decision_runtime.py -q`

**Step 3: Write minimal implementation**

Update the runtime decision parser, node state updates, and execution input normalization.

**Step 4: Run test to verify it passes**

Run: `pytest backend/tests/assistant_graph/test_cognitive_decision_runtime.py -q`

### Task 2: Refactor runtime state and protocol

**Files:**
- Modify: `backend/app/agent/assistant_graph/runtime_bootstrap.py`

**Step 1: Replace the decision output protocol**

Define a cognition-first JSON contract centered on `cognitive_update` and `continuation_commitment`.

**Step 2: Update node state propagation**

Make `memory_sync` and follow-up nodes prefer `cognitive_update.summary` over prior action-oriented state.

**Step 3: Update execution bridging**

Convert explicit continuation commitments into:
- tool execution
- user interruption
- final assistant answer

without letting engineering-side code re-decide the next move.

### Task 3: Verify targeted runtime behavior

**Files:**
- Modify: `backend/tests/assistant_graph/test_cognitive_decision_runtime.py`
- Modify: `backend/tests/agentic/test_no_placeholder_runtime.py` if needed

**Step 1: Run targeted tests**

Run:
- `pytest backend/tests/assistant_graph/test_cognitive_decision_runtime.py -q`
- `pytest backend/tests/agentic/test_no_placeholder_runtime.py -q`

**Step 2: Fix regressions minimally**

Only adjust runtime code or tests required by the new protocol.
