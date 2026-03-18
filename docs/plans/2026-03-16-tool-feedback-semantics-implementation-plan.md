# Tool Feedback Semantics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make tool-layer feedback semantics consistent and non-misleading, especially for KB evidence tools that currently blur candidate refs, text evidence, and visual-only evidence.

**Architecture:** Keep the agent runtime unchanged for now and fix the contract at the tool boundary. Standardize feedback fields across workspace and KB tools, then tighten KB-specific answerability and modality signals so tool outputs no longer claim text answerability when only image refs exist.

**Tech Stack:** Python, pytest, FastAPI backend tool modules

---

### Task 1: Lock the desired tool semantics with failing tests

**Files:**
- Modify: `backend/tests/assistant_graph/test_kb_evidence_environment_signals.py`
- Modify: `backend/tests/assistant_graph/test_workspace_environment_tools.py`
- Create: `backend/tests/assistant_graph/test_workspace_source_tools.py`

**Step 1: Write the failing tests**

- Add assertions for KB tools:
  - `read_kb_evidence` returns `evidence_modality`
  - visual-only evidence does not report `answerability == "answerable"`
  - `search_kb_candidates` reports candidate-only semantics
  - `read_kb_snippets` with empty snippets reports text-specific insufficiency
- Add assertions for workspace tools:
  - all feedback payloads include `status`, `outcome`, `reason`, `missing_information`
  - workspace summary tools include `target_resolution`, `answerability`, `evidence_modality`

**Step 2: Run tests to verify they fail**

Run: `d:\Exam-paper\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/assistant_graph/test_kb_evidence_environment_signals.py backend/tests/assistant_graph/test_workspace_environment_tools.py backend/tests/assistant_graph/test_workspace_source_tools.py`

Expected: FAIL because the new semantics are not implemented yet.

### Task 2: Implement unified tool feedback helpers

**Files:**
- Modify: `backend/app/agent/tools/common.py`

**Step 1: Add a minimal feedback helper**

- Add a helper that normalizes:
  - `status`
  - `outcome`
  - `reason`
  - `missing_information`
  - optional counts and tool-specific details

**Step 2: Keep implementation minimal**

- Do not add a full schema or validation framework.
- Only centralize repeated feedback construction.

### Task 3: Fix workspace tool semantics

**Files:**
- Modify: `backend/app/agent/tools/workspace_sources.py`
- Modify: `backend/app/agent/tools/workspace_environment.py`

**Step 1: Update each workspace tool to emit the unified feedback fields**

- `tool_list_workspace_sources`
- `tool_get_workspace_resource_summary`
- `tool_resolve_question_card_candidates`
- `tool_read_workspace_question_card`

**Step 2: Add top-level semantic fields where applicable**

- `target_resolution`
- `answerability`
- `evidence_modality`

**Step 3: Keep YAGNI discipline**

- Do not change selection logic or query logic.
- Only tighten output semantics.

### Task 4: Fix KB tool semantics

**Files:**
- Modify: `backend/app/agent/tools/knowledge_evidence.py`

**Step 1: Separate evidence modality from answerability**

- Derive `evidence_modality` as `none|text|visual|mixed`
- Do not set `answerability` to `answerable` for visual-only evidence

**Step 2: Tighten each KB tool contract**

- `read_kb_evidence`
  - report whether evidence is text, visual, or mixed
  - report target binding ambiguity clearly
- `search_kb_candidates`
  - report `answerability="candidate_only"`
  - make feedback explicitly say candidate refs are not readable evidence
- `read_kb_snippets`
  - report text-only semantics
  - when `snippets=[]`, do not emit success-like answerability

**Step 3: Preserve existing payload shape when possible**

- Keep `snippets`, `asset_refs`, `doc_coverage`, `source_refs`, `model_input`
- Only change misleading semantics and feedback values

### Task 5: Verify the targeted test set

**Files:**
- Test: `backend/tests/assistant_graph/test_kb_evidence_environment_signals.py`
- Test: `backend/tests/assistant_graph/test_workspace_environment_tools.py`
- Test: `backend/tests/assistant_graph/test_workspace_source_tools.py`

**Step 1: Run the targeted tests**

Run: `d:\Exam-paper\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/assistant_graph/test_kb_evidence_environment_signals.py backend/tests/assistant_graph/test_workspace_environment_tools.py backend/tests/assistant_graph/test_workspace_source_tools.py`

Expected: PASS

**Step 2: Commit**

```bash
git add backend/app/agent/tools/common.py backend/app/agent/tools/knowledge_evidence.py backend/app/agent/tools/workspace_environment.py backend/app/agent/tools/workspace_sources.py backend/tests/assistant_graph/test_kb_evidence_environment_signals.py backend/tests/assistant_graph/test_workspace_environment_tools.py backend/tests/assistant_graph/test_workspace_source_tools.py docs/plans/2026-03-16-tool-feedback-semantics-implementation-plan.md
git commit -m "fix: tighten tool feedback semantics"
```
