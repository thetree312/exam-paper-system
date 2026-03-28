# Harness Runtime Phase 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace workflow-heavy decision inputs with a minimal harness context for the runtime bootstrap path.

**Architecture:** Phase 1 removes `decision_projection` and evidence-register carryforward/working-set prompt injection from the bootstrap runtime. The model will receive a small `context_map` plus a bounded list of recent tool facts, while artifact storage remains in the runtime for later phases.

**Tech Stack:** Python, pytest, LangGraph runtime, Qwen tool-calling adapter

---

### Task 1: Lock the new prompt contract with tests

**Files:**
- Create: `backend/tests/assistant_graph/test_harness_runtime_phase1.py`
- Modify: `backend/tests/assistant_graph/test_evidence_register_runtime.py`

**Step 1: Write failing tests**

Cover:
- `_node_memory_sync` emits `context_map` instead of `decision_projection`
- `_node_decide` ignores evidence-register carryforward and does not inject `working_set`
- old working-set helper contract is removed

**Step 2: Run tests to verify they fail**

Run: `backend\.venv\Scripts\python -m pytest backend/tests/assistant_graph/test_harness_runtime_phase1.py backend/tests/assistant_graph/test_evidence_register_runtime.py -q`

Expected: failures because the old runtime still emits `decision_projection` and carryforward messages.

### Task 2: Replace decision projection with context map

**Files:**
- Modify: `backend/app/agent/assistant_graph/runtime_bootstrap.py`

**Step 1: Add minimal harness context builders**

Create helpers for:
- `context_map`
- recent tool fact summaries
- bounded memory summary

**Step 2: Wire `_node_memory_sync` to emit the new harness payload**

Requirements:
- no `decision_projection`
- no task-phase coaching
- no strategy-feedback prompt injection

### Task 3: Remove carryforward prompt injection from bootstrap decision loop

**Files:**
- Modify: `backend/app/agent/assistant_graph/runtime_bootstrap.py`

**Step 1: Stop reading evidence register into prompt assembly**

Requirements:
- `_node_decide` uses persisted messages + model messages + current transient tool messages only
- no `build_working_set_message`
- no `select_carryforward_evidence_messages`

**Step 2: Keep runtime storage intact**

Requirements:
- do not delete evidence register storage yet
- do not change tool execution or interrupt flow in this phase

### Task 4: Remove obsolete working-set tests and verify the new contract

**Files:**
- Modify: `backend/tests/assistant_graph/test_evidence_register_runtime.py`

**Step 1: Delete tests that encode carryforward prompt injection as desired behavior**

**Step 2: Run focused tests**

Run: `backend\.venv\Scripts\python -m pytest backend/tests/assistant_graph/test_harness_runtime_phase1.py backend/tests/assistant_graph/test_evidence_register_runtime.py backend/tests/assistant_graph/test_runtime_interrupt_protocol.py backend/tests/assistant_graph/test_runtime_multimodal_tool_passthrough.py backend/tests/assistant_graph/test_step_count_runtime.py -q`

Expected: all green.

### Task 5: Summarize residual scope for Phase 2

**Files:**
- Modify: `docs/plans/2026-03-26-harness-runtime-phase1-implementation.md`

**Step 1: Record what remains**

Include:
- tool semantic neutralization
- state-model simplification
- artifact store cutover
- eval harness rollout
