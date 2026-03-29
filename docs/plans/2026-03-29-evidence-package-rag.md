# Evidence Package RAG Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace fragment-style KB tool outputs with structured evidence packages that hand the agent a primary visual, supporting text/table evidence, and package-level answerability context.

**Architecture:** Keep semantic-group retrieval as the candidate stage, then add an evidence assembly layer inside `knowledge_evidence.py` that builds package-level objects from retrieved groups and their members. KB tools stop handing the model raw snippets plus a single ad hoc image; instead they hand over ranked evidence packages and a package-focused model payload.

**Tech Stack:** Python, pytest, existing KB semantic-group retrieval, agent tool registry.

---

### Task 1: Lock The New Contract With Tests

**Files:**
- Modify: `backend/tests/services/test_knowledge_evidence.py`

**Step 1: Write the failing tests**

- Assert that multimodal group evidence is assembled into package objects with:
  - `package_id`
  - `primary_visual_ref`
  - `supporting_text_refs`
  - `supporting_table_refs`
  - `member_refs`
- Assert that the primary visual prefers figure/image members over decorative header strips when both are present.
- Assert that `tool_read_kb_evidence` and `tool_read_kb_snippets` expose `evidence_packages` in both result payload and model payload.

**Step 2: Run the focused tests to verify failure**

Run: `pytest backend/tests/services/test_knowledge_evidence.py -q`

**Step 3: Keep failures limited to the missing package behavior**

No production changes in this step.

### Task 2: Add Evidence Package Assembly

**Files:**
- Modify: `backend/app/agent/tools/knowledge_evidence.py`

**Step 1: Implement minimal package assembly helpers**

- Add helpers to:
  - classify candidate visual members
  - group evidence into package objects
  - choose a `primary_visual_ref` from package structure, not raw chunk ordering
  - surface package-level `answerability_focus`

**Step 2: Update evidence builders**

- Extend group/row/unit evidence builders to include `evidence_packages`
- Preserve existing `snippets`, `asset_refs`, `citation_candidates` for compatibility
- Make `model_message_content` package-first

**Step 3: Keep image handoff minimal but package-aware**

- Continue sending one inline image for now
- Ensure the chosen inline image comes from the package `primary_visual_ref`, not the first sorted asset

### Task 3: Rewire KB Tool Outputs Around Packages

**Files:**
- Modify: `backend/app/agent/tools/knowledge_evidence.py`
- Modify: `backend/app/agent/tools/registry.py`

**Step 1: Update tool result payloads**

- `search_kb_candidates` should expose candidate package/group context
- `read_kb_evidence` should expose package-level payloads
- `read_kb_snippets` should carry forward package-level payloads instead of degrading to snippet-first framing

**Step 2: Tighten tool descriptions**

- Tool descriptions should steer the model toward package reading instead of snippet grazing

### Task 4: Verify

**Files:**
- Test: `backend/tests/services/test_knowledge_evidence.py`
- Test: `backend/tests/agent/test_agent_policy_and_tool_descriptions.py`

**Step 1: Run focused tests**

Run:
- `pytest backend/tests/services/test_knowledge_evidence.py -q`
- `pytest backend/tests/agent/test_agent_policy_and_tool_descriptions.py -q`

**Step 2: Run one adjacent regression slice if needed**

Run: `pytest backend/tests/services/test_rag_service.py -q`
