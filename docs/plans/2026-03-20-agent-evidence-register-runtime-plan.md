# Agent Evidence Register Runtime Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop agent prompt growth at the runtime architecture level by separating persistent conversation history from reusable multimodal evidence.

**Architecture:** Keep the existing KB multimodal retrieval contract intact (`evidence_units`, `model_message_content`, transient multimodal passthrough), but remove heavy tool payloads from persistent `messages`. Introduce an `evidence_register` in runtime state that stores bounded reusable evidence frames and rebuilds a small carry-forward evidence working set for each model decision.

**Tech Stack:** Python, LangGraph runtime, pytest.

---

## Requirements Summary

- Preserve current multimodal behavior: the model must still see inline image evidence after `read_kb_evidence`.
- Eliminate prompt-size growth caused by replaying heavy tool outputs through `messages`.
- Avoid query-specific or domain-specific retrieval hacks.
- Keep the existing KB unit-first direction and dual-lane multimodal retrieval intact.
- Bound runtime complexity: no new workflow engine, no extra summarizer agent, no document-type-specific routing.

## Root Cause

- Runtime currently writes every tool result into two places:
  - `transient_tool_messages`: correct path for immediate next-step multimodal reasoning
  - `messages`: incorrect path for long-lived prompt replay
- Even after `sanitize_tool_content_for_history`, persistent tool history still contains large JSON/text payloads.
- Next `decide` call merges persistent history back into the prompt, causing cumulative growth.

## Design

### 1. Persistent History Becomes Receipt-Only

Persistent `messages` keeps only:

- human conversation
- assistant tool-call stubs
- compact tool receipts

It no longer stores full `model_message_content` or large evidence payloads.

Each persisted tool receipt must include:

- `tool_name`
- `status`
- `query`
- `summary`
- `answerability`
- `target_resolution`
- `source_refs`

### 2. Add `evidence_register`

New runtime state field:

- `evidence_register: list[dict[str, Any]]`

Each entry is a bounded reusable evidence frame:

- `frame_id`
- `tool_name`
- `tool_call_id`
- `query`
- `source_refs`
- `answerability`
- `target_resolution`
- `summary`
- `content` (full multimodal `model_message_content`)
- `created_step`
- `last_selected_step`

The register is bounded and deduplicated by evidence identity:

- same `tool_name + query + source_refs` updates existing frame
- keep only the newest few frames

### 3. Decision-Time Evidence Working Set

Before each model decision:

- merge persistent messages as usual
- append current `transient_tool_messages`
- append a small carry-forward set rebuilt from `evidence_register`

This gives the model access to previously discovered multimodal evidence without replaying all past tool payloads through history.

Selection rules:

- prefer newest frames with usable evidence
- skip duplicates already present in `transient_tool_messages`
- keep the working set small and bounded

### 4. Preserve Existing KB Contract

Do not change the KB tool contract fundamentally.

`read_kb_evidence` should keep returning:

- `evidence_units`
- `source_refs`
- `answerability`
- `target_resolution`
- `model_message_content`

The change belongs in runtime packaging, not KB retrieval semantics.

## Risks and Mitigations

- Risk: carry-forward evidence duplicates current transient evidence.
  - Mitigation: dedupe by `tool_call_id` and `source_refs`.
- Risk: register becomes another hidden prompt-growth path.
  - Mitigation: hard cap frame count and selected carry-forward count.
- Risk: model loses critical visual evidence after one step.
  - Mitigation: selected carry-forward frames use the original multimodal `content`, not a text summary.
- Risk: old tests only validate transient passthrough, not prompt growth.
  - Mitigation: add tests for receipt-only persistence and evidence-register carry-forward reuse.

## Task 1: Add Failing Runtime Tests

**Files:**
- Modify: `backend/tests/assistant_graph/test_runtime_multimodal_tool_passthrough.py`
- Create or Modify: `backend/tests/assistant_graph/test_evidence_register_runtime.py`

**Step 1: Write failing test for receipt-only history**

Test behavior:

- `_execute_tool_action()` with multimodal tool output must:
  - keep full content in `transient_msg`
  - write compact receipt into `history_msg`
  - not persist full snippets/image payload into `history_msg`

**Step 2: Run targeted tests and verify failure**

Run:

```powershell
pytest backend/tests/assistant_graph/test_runtime_multimodal_tool_passthrough.py -q
```

Expected:

- new receipt test fails against current runtime behavior

**Step 3: Write failing test for evidence-register carry-forward**

Test behavior:

- when `transient_tool_messages` is empty but `evidence_register` contains a multimodal frame,
  `_node_decide()` must still send the selected evidence frame to the model input

**Step 4: Run targeted tests and verify failure**

Run:

```powershell
pytest backend/tests/assistant_graph/test_evidence_register_runtime.py -q
```

Expected:

- carry-forward test fails before implementation

## Task 2: Implement Evidence Register Helpers

**Files:**
- Create: `backend/app/agent/assistant_graph/evidence_register.py`

**Step 1: Add helper functions**

Implement:

- `build_tool_receipt_message(...)`
- `build_evidence_frame(...)`
- `merge_evidence_register(...)`
- `select_evidence_messages(...)`

**Step 2: Add small bounded rules**

- cap stored frames
- cap selected carry-forward messages
- dedupe by evidence identity

**Step 3: Run tests for syntax/import safety**

Run:

```powershell
pytest backend/tests/assistant_graph/test_evidence_register_runtime.py -q
```

## Task 3: Integrate Runtime Bootstrap Path

**Files:**
- Modify: `backend/app/agent/assistant_graph/runtime_bootstrap.py`

**Step 1: Store evidence register in state**

- extend `GraphState`
- initialize register in prepare/reset paths

**Step 2: Replace heavy persistent tool history**

- `_execute_tool_action()` should emit compact `history_msg`
- keep full `transient_msg`
- emit evidence frame for register merge

**Step 3: Use register during `_node_decide()`**

- build selected carry-forward evidence messages
- merge with persistent history and transient tool messages

**Step 4: Run targeted tests**

Run:

```powershell
pytest backend/tests/assistant_graph/test_runtime_multimodal_tool_passthrough.py backend/tests/assistant_graph/test_evidence_register_runtime.py -q
```

## Task 4: Integrate Runtime Nodes Path

**Files:**
- Modify: `backend/app/agent/assistant_graph/runtime_nodes.py`

**Step 1: Mirror bootstrap behavior**

- same receipt-only persistence
- same evidence-register update
- same carry-forward selection during decision

**Step 2: Keep behavior aligned with bootstrap**

- avoid divergent logic
- reuse helper functions from `evidence_register.py`

**Step 3: Run targeted tests**

Run:

```powershell
pytest backend/tests/assistant_graph/test_runtime_multimodal_tool_passthrough.py backend/tests/assistant_graph/test_evidence_register_runtime.py -q
```

## Task 5: Surface Evidence Register in Model Snapshot

**Files:**
- Modify: `backend/app/agent/assistant_graph/runtime_common.py`
- Modify: `backend/app/agent/assistant_graph/runtime_bootstrap.py`

**Step 1: Add compact evidence-register summary to model snapshot**

- include only tiny metadata, not full content
- expose enough context for agent to know reusable evidence exists

**Step 2: Keep snapshot bounded**

- no raw snippets
- no image data URLs

**Step 3: Run focused tests**

Run:

```powershell
pytest backend/tests/assistant_graph/test_evidence_register_runtime.py -q
```

## Task 6: Verify Prompt Growth Does Not Regress

**Files:**
- Modify: `backend/tests/assistant_graph/test_evidence_register_runtime.py`
- Optional Modify: `backend/tests/assistant_graph/test_agent_session_runtime_contract.py`

**Step 1: Add regression test**

Assert:

- persistent `messages` do not contain heavy tool payload after multiple KB calls
- selected carry-forward evidence remains available to model

**Step 2: Run targeted suite**

Run:

```powershell
pytest backend/tests/assistant_graph/test_runtime_multimodal_tool_passthrough.py backend/tests/assistant_graph/test_evidence_register_runtime.py backend/tests/assistant_graph/test_agent_session_runtime_contract.py -q
```

## Task 7: Final Verification

**Files:**
- No new files unless test fixes are required

**Step 1: Run focused runtime suite**

Run:

```powershell
pytest backend/tests/assistant_graph/test_runtime_multimodal_tool_passthrough.py backend/tests/assistant_graph/test_evidence_register_runtime.py backend/tests/assistant_graph/test_kb_evidence_environment_signals.py -q
```

**Step 2: Run broader assistant_graph smoke suite if the focused tests pass**

Run:

```powershell
pytest backend/tests/assistant_graph -q
```

Expected:

- new tests pass
- existing multimodal passthrough behavior remains intact
- no prompt-history replay regressions in targeted runtime paths
