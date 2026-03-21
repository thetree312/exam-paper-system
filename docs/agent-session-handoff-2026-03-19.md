# Agent Session Handoff

Date: 2026-03-19
Audience: Next coding agent continuing this workspace
Purpose: Preserve session context, technical decisions, resolved issues, unresolved risks, and the latest evaluation of the current agent system.

## 1. Context

This repository has been under heavy recovery after accidental deletion of earlier agent- and workroom-related code. The user is pushing for production reconstruction, not patch-grade stopgaps. Throughout this session, the user repeatedly rejected:

- compatibility shims that preserve old conceptual ambiguity
- test-case-specific optimizations
- keyword-triggered hacks in RAG
- engineering-side hard rules that bypass semantic retrieval

The user wants foundational, long-term-stable infrastructure. When proposing fixes, prefer structural solutions over special cases.

## 2. Product Semantics Aligned in This Session

These terms were clarified and should be treated as authoritative unless the user changes them later:

- `workspace`: the high-level learning/project container
- `workroom`: the three-column operating environment inside a workspace
- left column in workroom: knowledge base / source area
- middle column in workroom: studio / content work area
- right column in workroom: agent panel

Important:
- Do not collapse `workroom` into the middle column only.
- Do not use old ambiguous naming patterns that overload `workspace` to mean both outer container and center document space.

## 3. Major Problems Encountered

### 3.1 KB / RAG multimodal retrieval was structurally wrong

Observed symptoms:

- agent sometimes reported it could not see images
- agent sometimes retrieved the wrong image for the right text query
- text chunks and page images were not reliably packaged as one semantic evidence unit
- old chunk-level retrieval allowed cross-document / cross-page confusion

Root cause identified during the session:

- retrieval and agent evidence packaging were not aligned with ingestion-time multimodal semantics
- image and text evidence could be recalled separately, causing wrong document/page associations
- the tool layer was trying to repair retrieval behavior after the fact

User explicitly rejected:

- keyword-based visual-need heuristics
- rules like "if query contains 图/page then fetch image"
- scenario-specific optimization for exam papers only

### 3.2 Workspace deletion failed with 500

Observed symptom:

- deleting old workroom/workspace failed because cleanup SQL referenced tables that did not yet exist

Root cause:

- repository deletion path referenced `kb_units` / `kb_unit_embeddings` before migration was applied

### 3.3 Frontend agent trace UX was incorrect

Observed symptoms:

- trace stayed permanently above final answer
- tool traces appeared too late and looked non-realtime
- trace and final answer were not visually separated enough
- thought text had poor rendering for LaTeX / math expressions

### 3.4 Workroom state persistence had instability

Observed symptoms across the session:

- after entering/exiting workspace/workroom, uploaded knowledge and panel state could disappear or desync
- there were repeated `PUT /api/workrooms/{id}/state` storms causing UI jitter

This area was partially stabilized but should still be treated as a sensitive subsystem.

## 4. Key Decisions Made

### 4.1 Adopt unit-first KB architecture

Decision:

- move from loose chunk-only retrieval toward page-level / semantic-unit retrieval
- preserve the idea that ingestion-time parsing exists to improve recall precision, not to be bypassed later by tool-side rules

Reasoning:

- the user explicitly emphasized that parsed text blocks should support higher-relevance multimodal recall
- if the tool layer has to hard-bind image and text with custom rules after retrieval, then ingestion-time parsing is being wasted

### 4.2 Directly create tables instead of talking about compatibility

Decision:

- create the new KB unit tables immediately

Reasoning:

- the user rejected "compatibility" and preferred direct schema evolution
- after confirmation, the migration was applied directly

### 4.3 Trace is model-originated thought, not backend-authored progress text

Decision:

- trace content must come from model output
- tool trace rows show tool name plus build icon and status spinner/check/close
- trace should be visually distinct from final answer and collapsible

Reasoning:

- user explicitly rejected fixed boilerplate trace text
- user wanted chain-of-thought-like appearance, not cards or timeline widgets

## 5. Implemented Changes

### 5.1 New KB unit schema

Added migration:

- `backend/db/migrations/20260319_add_kb_units_and_embeddings.sql`

Tables introduced:

- `kb_units`
- `kb_unit_embeddings`

Migration status:

- applied successfully during this session

### 5.2 KB ingestion updated toward units

Changed files:

- `backend/app/services/kb/types.py`
- `backend/app/services/kb/chunk_builders.py`
- `backend/app/services/kb/ingest_service.py`
- `backend/app/services/kb/repository.py`

Implemented:

- page/unit row building during ingestion
- text + image embeddings persisted per unit
- source replacement path for unit rows and unit embeddings

### 5.3 RAG retrieval updated to support units

Changed file:

- `backend/app/services/kb/rag_service.py`

Implemented:

- unit candidate retrieval
- unit ranking
- fallback path to legacy chunk retrieval if unit tables are unavailable

Note:

- this fallback exists in code; conceptually the user dislikes compatibility layers, so this should be revisited after full cutover

### 5.4 Agent KB tool updated toward unit-based evidence

Changed file:

- `backend/app/agent/tools/knowledge_evidence.py`

Implemented:

- parsing `unit:*` references
- building evidence from units
- multimodal `model_message_content` including image parts
- bounded image inlining to reduce base64 explosion

Important current design in this file:

- `_DEFAULT_TOP_K = 3`
- `_MAX_SNIPPETS_TO_MODEL = 2`
- `_MAX_ASSET_REFS_TO_MODEL = 3`
- only one best image is generally inlined to control cost/latency

### 5.5 Workspace deletion path fixed

Changed file:

- `backend/app/services/workspace/repository.py`

Resolved:

- cleanup now includes KB unit tables
- temporary existence checks were added to stop 500 before migration
- after confirming migration was present, those compatibility checks were removed and direct deletion against new tables was restored

### 5.6 Agent trace frontend improved

Changed file:

- `frontend/src/components/AgentChatPanel.tsx`

Implemented:

- trace section became collapsible
- trace auto-expands while streaming
- trace auto-collapses after response completes
- left vertical separator only appears when trace is actively visible
- thought text now renders through `MarkdownWithMath` instead of plain text

Current intended UX:

- while thinking is streaming: separator visible, thought visible
- after answer completes: thought collapses, separator hidden
- user can reopen thought manually; separator becomes visible again

## 6. Problems Resolved vs Not Fully Resolved

### Resolved enough to continue

- KB unit tables were created and wired into ingestion/retrieval
- workspace deletion no longer depends on missing tables
- trace visibility behavior is much closer to the user’s target UX
- thought rendering now supports math better than plain text rendering

### Still not fully closed

- old sources are not fully backfilled into `kb_units`
- the system still contains partial legacy chunk compatibility
- evidence correctness across multimodal retrieval needs more validation with real files
- session continuity, profile write-back, and long-term memory remain weak
- there are existing TypeScript errors in the frontend unrelated to the trace changes

## 7. Technical Evaluation Reached in This Session

The user challenged an earlier evaluation as possibly based on outdated pre-2026 assumptions. A refreshed assessment aligned to 2025-2026 agentic / AI-native standards was then produced.

Latest evaluation:

- `Agentic`: `8/10`
- `AI-native`: `6.5/10`
- `Multi-turn continuity`: `6/10`
- `Information completeness`: `6/10`
- `Cost control and compression`: `5.5/10`
- `Personalization/profile`: `3.5/10`
- `Technical depth`: `8.5/10`

Interpretation:

- the system is a real agent system, not a fake workflow wrapper
- it has meaningful technical depth
- it is not yet a mature production-grade AI-native agent platform

Main gaps identified:

- long-term memory write-back loop is incomplete
- evidence binding consistency is insufficient
- cost governance is local, not global
- personalization/profile is mostly schema-level, not behavioral

## 8. Specific Lessons From User Feedback

The user reacted very strongly against the following patterns. Avoid repeating them.

### Do not do these

- do not add scenario-specific heuristics framed as general solutions
- do not solve semantic retrieval defects with string-keyword triggers
- do not introduce "compatibility" when direct schema or architecture repair is available
- do not hide incomplete reasoning behind optimistic summaries
- do not redesign unrelated UI areas when asked to fix one surface
- do not treat wrong-image retrieval as a query wording issue if logs indicate structural evidence misbinding

### Do these instead

- inspect logs and actual agent reasoning traces first
- separate symptom from root cause
- prefer ingestion/retrieval architecture fixes over tool-side rule wrapping
- preserve Chinese correctly; assume encoding/tooling issues before assuming source-file corruption

## 9. File-Level Hotspots for the Next Agent

Start here if continuing this line of work:

- `backend/app/agent/tools/knowledge_evidence.py`
- `backend/app/services/kb/rag_service.py`
- `backend/app/services/kb/ingest_service.py`
- `backend/app/services/kb/repository.py`
- `backend/app/agent/assistant_graph/world_model.py`
- `backend/app/agent/assistant_graph/runtime_bootstrap.py`
- `backend/app/services/workspace/repository.py`
- `frontend/src/components/AgentChatPanel.tsx`

## 10. Recommended Next Steps

Priority order:

1. Backfill existing KB sources into `kb_units` so retrieval behavior is not split by ingestion date.
2. Remove remaining chunk-first ambiguity from evidence packaging after confirming unit retrieval quality.
3. Add a proper evidence-consistency closing step before final answer emission.
4. Build a real session-memory write-back loop into `profile_json` and `history_summary`.
5. Add unified per-turn cost governance instead of scattered local limits.

## 11. Verification Notes

Things verified during the session:

- migration for KB unit tables was applied successfully
- `kb_units` and `kb_unit_embeddings` exist in PostgreSQL
- `workspace` deletion path was updated to target the new schema

Things not verified end-to-end enough:

- full multimodal retrieval correctness over a large mixed corpus
- complete back-navigation persistence stability across all workroom surfaces
- frontend full typecheck health unrelated to this session’s targeted changes

## 12. Final Handoff Summary

This session materially moved the codebase from ad-hoc multimodal RAG behavior toward a unit-first KB foundation and improved the frontend trace UX. The largest unresolved issue is not lack of components but lack of full system closure: evidence correctness, memory continuity, and cost governance still need another round of structural work.
