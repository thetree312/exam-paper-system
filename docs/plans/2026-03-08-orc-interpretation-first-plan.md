# ORC Interpretation-First Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the single-agent ORC produce an explicit world interpretation before action selection, and use that interpretation to improve tool search without adding case-specific routing rules.

**Architecture:** Keep a single ORC loop and single model call per turn, but change the ORC contract from direct `state -> action` into explicit `state -> interpretation -> action`. Add an affordance-aware tool search reranker that scores tools against the interpreted world state instead of relying only on semantic similarity.

**Tech Stack:** Python, pytest, LangGraph-style node orchestration, Qwen client, SQLAlchemy/Postgres vector search

---

### Task 1: Lock ORC interpretation contract with tests

**Files:**
- Modify: `backend/tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py`

**Step 1: Write the failing test**

Add assertions that the ORC system prompt exposes interpretation-first fields such as `situation_summary`, `natural_path`, `blocked_paths`, `missing_means`, and `answerability`.

**Step 2: Run test to verify it fails**

Run: `pytest tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py -q`
Expected: FAIL because the current prompt contract does not include the new interpretation fields.

**Step 3: Write minimal implementation**

Update the ORC prompt contract so these fields are part of the required JSON shape and the reasoning instructions explicitly require interpretation before action.

**Step 4: Run test to verify it passes**

Run: `pytest tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py -q`
Expected: PASS

### Task 2: Lock affordance-aware tool search behavior with tests

**Files:**
- Create: `backend/tests/services/test_tool_search_service_affordance.py`

**Step 1: Write the failing test**

Add focused tests that verify:
- A `kb`-aligned query with `kb` affordance hints reranks `read_kb_evidence` ahead of workspace tools even when semantic scores are close.
- A generic query without affordance hints preserves semantic ordering.

**Step 2: Run test to verify it fails**

Run: `pytest tests/services/test_tool_search_service_affordance.py -q`
Expected: FAIL because the current service only orders by vector distance.

**Step 3: Write minimal implementation**

Add an affordance scoring layer to `ToolSearchService.search()` using optional world-state hints.

**Step 4: Run test to verify it passes**

Run: `pytest tests/services/test_tool_search_service_affordance.py -q`
Expected: PASS

### Task 3: Implement interpretation-first ORC output

**Files:**
- Modify: `backend/app/assistant_graph/nodes/orc_loop.py`
- Test: `backend/tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py`

**Step 1: Write the failing test**

Extend the ORC prompt test to assert that the action schema now includes the interpretation fields before `next_action`.

**Step 2: Run test to verify it fails**

Run: `pytest tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py -q`
Expected: FAIL if not already failing from Task 1.

**Step 3: Write minimal implementation**

Change the ORC system prompt so the required JSON object starts with:
- `situation_summary`
- `natural_path`
- `blocked_paths`
- `missing_means`
- `answerability`

Keep compatibility with the existing downstream parser by tolerating these extra fields if present.

**Step 4: Run test to verify it passes**

Run: `pytest tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py -q`
Expected: PASS

### Task 4: Add affordance-aware reranking to tool search

**Files:**
- Modify: `backend/app/services/tool_search_service.py`
- Modify: `backend/app/assistant_graph/tool_registry.py`
- Test: `backend/tests/services/test_tool_search_service_affordance.py`
- Test: `backend/tests/assistant_graph/test_tool_registry_world_metadata.py`

**Step 1: Write the failing test**

Use the new service tests from Task 2 and, if needed, add registry assertions for new optional search-hint fields.

**Step 2: Run test to verify it fails**

Run: `pytest tests/services/test_tool_search_service_affordance.py tests/assistant_graph/test_tool_registry_world_metadata.py -q`
Expected: FAIL

**Step 3: Write minimal implementation**

Implement optional search hints for:
- `preferred_domains`
- `preferred_reads_kinds`
- `blocked_domains`

Use them as reranking bonuses/penalties after vector retrieval. Do not hardcode any business scenario or case identifiers.

**Step 4: Run test to verify it passes**

Run: `pytest tests/services/test_tool_search_service_affordance.py tests/assistant_graph/test_tool_registry_world_metadata.py -q`
Expected: PASS

### Task 5: Run focused regression suite

**Files:**
- Test: `backend/tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py`
- Test: `backend/tests/assistant_graph/test_tool_registry_world_metadata.py`
- Test: `backend/tests/assistant_graph/test_execution_runtime_world_changes.py`
- Test: `backend/tests/services/test_qwen_client_stream_contract.py`
- Test: `backend/tests/services/test_tool_search_service_affordance.py`

**Step 1: Run focused tests**

Run: `pytest tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py tests/assistant_graph/test_tool_registry_world_metadata.py tests/assistant_graph/test_execution_runtime_world_changes.py tests/services/test_qwen_client_stream_contract.py tests/services/test_tool_search_service_affordance.py -q`

**Step 2: Verify**

Expected: All tests pass.

**Step 3: Commit**

```bash
git add docs/plans/2026-03-08-orc-interpretation-first-plan.md backend/app/assistant_graph/nodes/orc_loop.py backend/app/assistant_graph/tool_registry.py backend/app/services/tool_search_service.py backend/tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py backend/tests/assistant_graph/test_tool_registry_world_metadata.py backend/tests/services/test_tool_search_service_affordance.py
git commit -m "feat: add interpretation-first orc flow"
```
