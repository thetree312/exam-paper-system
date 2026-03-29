# Inline Citation Infrastructure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a first-class inline citation infrastructure so the final agent answer can cite concrete KB evidence as `[1]`, `[2]`, and clicking a citation drives the left document preview to the exact page and highlighted region.

**Architecture:** Keep the current KB retrieval and evidence register direction, but add a formal citation layer between retrieved evidence and the final assistant answer. The backend must normalize evidence into stable citation anchors, assign citation indices to only the evidence actually used in the answer, and stream both the cited answer text and a structured citation map. The frontend must render inline citation tokens as clickable UI and route each click into the existing left preview surface using `file_id + page_no + bbox_norm` instead of inventing a new floating panel.

**Tech Stack:** Python, FastAPI, LangGraph runtime, PostgreSQL-backed KB, TypeScript, React, pytest.

---

## Requirements Summary

- Final assistant answers must support inline citation markers such as `[1]`, `[2]`.
- Inline citation indices must map to structured evidence objects, not inferred strings.
- Citation clicks must navigate the existing left preview to the correct file and page, then highlight the cited region.
- The system must distinguish:
  - retrieved evidence
  - candidate evidence
  - cited evidence actually used in the answer
- Citation anchors must work for:
  - page-level evidence
  - layout text blocks
  - layout image crops
  - future KB unit variants
- No floating citation panel is required for V1. The left preview is the primary visual surface.
- The design must be infrastructure-grade: no regex-only parsing, no front-end guessing, no transient-only trace dependence.

## Root Cause

- Current KB tools already return rich evidence payloads:
  - `source_refs`
  - `snippets`
  - `asset_refs`
  - `evidence_objects`
  - `doc_coverage`
- Runtime already stores reusable evidence in `evidence_register`.
- But the final reply path only streams plain assistant text deltas.
- Frontend currently only knows:
  - assistant text
  - thinking/tool traces
  - ag_ui events
- There is no formal contract that says:
  - which evidence was finally cited
  - which index maps to which region
  - how the preview should navigate/highlight

## Design

### 1. Introduce a Stable Citation Anchor Schema

Define one normalized backend citation anchor model shared by runtime, final answer, and preview navigation.

Required fields:

- `citation_id`: stable ID for one cited evidence object within a turn, for example `cite:1`
- `citation_index`: displayed inline number, for example `1`
- `source_ref`: canonical evidence ref such as `unit:251` or `chunk:889`
- `anchor_type`: one of `unit`, `chunk`, `page`, `layout_block`
- `file_id`
- `page_no`
- `unit_key`
- `chunk_id`
- `chunk_type`
- `title`
- `excerpt`
- `asset_kind`
- `asset_ref`
- `preview_url`
- `bbox_norm`
- `bbox_abs`

Rules:

- `bbox_norm` is the primary preview-highlighting contract.
- `bbox_abs` is informational/debug only.
- If `bbox_norm` is absent, preview may still navigate by `file_id + page_no`, but the anchor is considered page-level only.

### 2. Split Evidence Lifecycle States

Add explicit separation in runtime output semantics:

- `retrieved_evidence`: everything returned by retrieval
- `candidate_evidence`: evidence made available to the model for answer composition
- `cited_evidence`: evidence explicitly bound into final answer inline citations

Only `cited_evidence` may appear in the final citation map.

This prevents fake citations where the system displays `[1]` for evidence that the answer never actually grounded on.

### 3. Add a Citation-Building Layer Above Evidence Register

Evidence register stays responsible for bounded multimodal evidence memory.

Add a new citation-building layer that:

- reads the latest usable evidence frames
- normalizes them into citation anchors
- deduplicates anchors by evidence identity
- assigns deterministic indices for the current answer turn

Deterministic ordering:

1. sort by explicit answer-use order if provided
2. else sort by first mention in answer
3. else fall back to best evidence order:
   - lower distance first
   - text before image only when answer sentence cites text
   - otherwise preserve retrieval order

### 4. Change Final Answer Contract

The backend final answer must no longer be treated as plain text only.

Introduce a structured assistant-answer payload:

- `answer_text`
- `citations`
- `citation_render_text`
- `citation_status`

Definitions:

- `answer_text`: canonical final answer body, containing inline markers like `[1]`
- `citations`: structured citation anchor array
- `citation_render_text`: optional already-rendered markdown-safe text for frontend fallback
- `citation_status`: one of `none`, `partial`, `complete`

Example:

```json
{
  "answer_text": "第六题图例说明风速按颜色分级展示[1]，横轴表示时间顺序[2]。",
  "citation_status": "complete",
  "citations": [
    {
      "citation_id": "cite:1",
      "citation_index": 1,
      "source_ref": "unit:251",
      "anchor_type": "layout_block",
      "file_id": 1077,
      "page_no": 7,
      "unit_key": "page:7/block:6",
      "chunk_type": "layout_text",
      "excerpt": "……图例显示不同颜色对应不同风速等级……",
      "bbox_norm": {"x": 0.11, "y": 0.32, "w": 0.44, "h": 0.08},
      "preview_url": "/api/files/preview/1077?page=7"
    },
    {
      "citation_id": "cite:2",
      "citation_index": 2,
      "source_ref": "unit:252",
      "anchor_type": "layout_block",
      "file_id": 1077,
      "page_no": 7,
      "unit_key": "page:7/block:7",
      "chunk_type": "layout_image",
      "asset_kind": "layout_crop",
      "asset_ref": "uploads/2/paper.page7.block7.jpg",
      "bbox_norm": {"x": 0.08, "y": 0.41, "w": 0.61, "h": 0.27},
      "preview_url": "/api/files/preview/1077?page=7"
    }
  ]
}
```

### 5. Extend Stream Protocol Instead of Hiding Citation Data in Traces

Do not overload `agent_trace`.

Add explicit stream events:

- `assistant_citations`
- `assistant_final`

Event meanings:

- `assistant_citations`:
  - emitted once per turn after citations are finalized
  - includes structured citation anchors
- `assistant_final`:
  - emitted once per turn after final text and citations are both ready
  - includes `answer_text` and `citation_status`

This gives the frontend a stable contract and avoids scraping traces.

### 6. Persist Citation Metadata Alongside Assistant Message

Current `agent_messages` stores only plain text content.

This is insufficient for reload/history rendering because citations vanish after refresh.

Add persistence for assistant citation metadata:

- either add `metadata_json` to `agent_messages`
- or add a sibling `agent_message_annotations` table

Preferred direction:

- `agent_message_annotations`

Required fields:

- `message_id`
- `annotation_type = 'inline_citation'`
- `payload_json`
- `created_at`

Why this direction:

- avoids overloading every message with nullable JSON
- keeps assistant message content simple
- scales to future annotations beyond citations

### 7. Add a KB Manifest Inspection Endpoint

The user must be able to see what the uploaded file became after ingestion.

Add one backend inspection API for a file-bound source:

- `GET /api/files/{file_id}/kb-manifest`

Response must include:

- source status
- ingest job stages
- page list
- layout cache status per page
- unit count
- chunk count
- unit summary list
- chunk summary list

For each unit/chunk summary, include:

- `unit_id` / `chunk_id`
- `unit_key` / `chunk_type`
- `page_no`
- `title`
- `excerpt`
- `asset_kind`
- `asset_ref`
- `bbox_norm`

This endpoint is the operational truth source for “the file was cut into what”.

### 8. Frontend Rendering Contract

Extend `AgentRunMessage` to carry citation data:

- `answerText`
- `citations`
- `citationStatus`

Do not parse citations out of raw markdown only.

Frontend renderer responsibilities:

- render markdown text
- detect inline citation tokens from structured citation map, not regex guesses alone
- replace each citation token with a clickable element
- keep citation index stable during streaming completion

### 9. Left Preview Highlight Contract

When a citation is clicked, frontend dispatches a preview-focus event:

- `type: 'citation_focus'`
- `fileId`
- `pageNo`
- `bboxNorm`
- `citationId`
- `sourceRef`

Left preview behavior:

1. ensure the cited file tab is active
2. switch to the cited page
3. draw an overlay rectangle using `bboxNorm`
4. animate highlight pulse for a short duration
5. keep active citation state so repeated clicks can re-focus

No floating citation panel is needed.

### 10. Answer Generation Rules

The model or post-processor must follow these rules:

- no inline citation marker unless a structured citation anchor exists
- no citation anchor may be omitted from the citation map
- citation indices must be contiguous starting at `1`
- repeated use of the same evidence should reuse the same citation index
- one sentence may cite multiple anchors, for example `[1][2]`

### 11. Failure Semantics

Possible states:

- `citation_status='none'`
  - no usable citation anchors available
- `citation_status='partial'`
  - answer contains some citation markers but not every claim is cited
- `citation_status='complete'`
  - every evidence-based claim in the answer has at least one citation marker

The UI should not fabricate missing citations.

## Data Contracts

### Backend Citation Model

Create a Pydantic schema in agent/router-facing code:

```python
class CitationAnchorOut(BaseModel):
    citation_id: str
    citation_index: int
    source_ref: str
    anchor_type: str
    file_id: int
    page_no: int
    unit_key: str | None = None
    chunk_id: int | None = None
    chunk_type: str | None = None
    title: str | None = None
    excerpt: str | None = None
    asset_kind: str | None = None
    asset_ref: str | None = None
    preview_url: str | None = None
    bbox_norm: dict[str, float] | None = None
    bbox_abs: dict[str, float] | None = None
```

### Stream Events

Add to frontend/backend shared stream event union:

```ts
type AgentStreamEvent =
  | { type: 'delta'; role: 'assistant'; delta: string }
  | { type: 'assistant_citations'; citations: CitationAnchor[]; citationStatus: 'none' | 'partial' | 'complete' }
  | { type: 'assistant_final'; answerText: string; citationStatus: 'none' | 'partial' | 'complete' }
  | { type: 'agent_trace'; payload?: Record<string, unknown> }
  | { type: 'ag_ui'; event: AgUiEvent }
  | { type: 'session'; session_id: number; document_id?: number | null; studio_document_id?: number | null }
```

## Risks and Mitigations

- Risk: answer text and citation map drift apart.
  - Mitigation: build both from one final answer object, not from separate render passes.
- Risk: image citations lack precise region highlight.
  - Mitigation: require `bbox_norm` for layout-derived image citations; fall back to page-only navigation only for legacy evidence.
- Risk: history reload loses clickable citations.
  - Mitigation: persist citation annotations with assistant messages.
- Risk: frontend regex parsing breaks on markdown/math.
  - Mitigation: citation rendering uses structured message metadata, not raw string parsing as the source of truth.
- Risk: one answer cites evidence from multiple files/pages.
  - Mitigation: citation click event always carries explicit `fileId` and `pageNo`.
- Risk: old messages have no citation metadata.
  - Mitigation: frontend handles `citationStatus='none'` and renders plain text for historical assistant messages.

## Task 1: Add Failing Backend Contract Tests

**Files:**
- Create: `backend/tests/agent/test_inline_citation_contract.py`
- Modify: `backend/tests/services/test_knowledge_evidence.py`
- Modify: `backend/tests/services/test_rag_service.py`

**Step 1: Write failing test for citation anchor normalization**

Test behavior:

- given KB evidence rows with `file_id`, `page_no`, `layout_unit_key`, `bbox_norm`
- citation builder must normalize them into one stable citation anchor shape

**Step 2: Write failing test for final answer payload**

Test behavior:

- final agent answer payload must contain:
  - `answer_text`
  - `citation_status`
  - `citations`

**Step 3: Run targeted tests and verify failure**

Run:

```powershell
pytest backend/tests/agent/test_inline_citation_contract.py -q
```

## Task 2: Build Citation Domain Model

**Files:**
- Create: `backend/app/agent/citations.py`
- Modify: `backend/app/agent/tools/knowledge_evidence.py`

**Step 1: Add citation anchor schema and helper constructors**

Implement:

- `build_citation_anchor_from_unit(...)`
- `build_citation_anchor_from_chunk(...)`
- `normalize_bbox_norm(...)`
- `dedupe_citation_anchors(...)`

**Step 2: Extend KB evidence tools to expose citation-ready fields**

Do not change retrieval semantics.

Ensure evidence payload contains enough data for later citation anchor construction:

- `unit_key`
- `chunk_id`
- `chunk_type`
- `bbox_norm`
- `asset_ref`
- `excerpt`

**Step 3: Run targeted tests**

Run:

```powershell
pytest backend/tests/services/test_knowledge_evidence.py backend/tests/agent/test_inline_citation_contract.py -q
```

## Task 3: Add Runtime Citation Assembly

**Files:**
- Modify: `backend/app/agent/assistant_graph/evidence_register.py`
- Modify: `backend/app/agent/assistant_graph/runtime_bootstrap.py`
- Modify: `backend/app/agent/assistant_graph/router_runtime.py`

**Step 1: Add citation assembly helpers**

Implement:

- `build_citation_candidates_from_register(...)`
- `assign_citation_indices(...)`
- `build_final_answer_payload(...)`

**Step 2: Keep evidence register and citations separate**

- evidence register remains multimodal memory
- citations are finalized only for the final assistant answer turn

**Step 3: Emit structured citation payload through runtime result**

Runtime result must expose:

- `final_answer_payload`
- `citations`
- `citation_status`

**Step 4: Run targeted tests**

Run:

```powershell
pytest backend/tests/agent/test_inline_citation_contract.py -q
```

## Task 4: Extend Agent Router Streaming and Persistence

**Files:**
- Modify: `backend/app/agent/router.py`
- Modify: `backend/app/models.py`
- Create: `backend/db/migrations/20260329_add_agent_message_annotations.sql`
- Modify: `backend/app/agent/services/agent_service.py`

**Step 1: Add annotation persistence**

Create `agent_message_annotations` with payload JSON.

**Step 2: Persist assistant inline citation annotations**

When final assistant message is stored, store the final citation map as annotations.

**Step 3: Extend stream events**

Emit:

- `assistant_citations`
- `assistant_final`

Do not hide citations in `agent_trace`.

**Step 4: Run targeted tests**

Run:

```powershell
pytest backend/tests/agent/test_inline_citation_contract.py backend/tests/test_agent_stream_citations.py -q
```

## Task 5: Add KB Manifest Inspection API

**Files:**
- Modify: `backend/app/routers/files.py`
- Modify: `backend/app/schemas.py`
- Modify: `backend/app/services/kb/repository.py`
- Create: `backend/tests/services/test_kb_manifest_api.py`

**Step 1: Add manifest schema**

Return:

- source status
- job stages
- page manifest
- unit summaries
- chunk summaries

**Step 2: Implement query path**

Use existing KB tables and layout cache tables as the truth source.

**Step 3: Run targeted tests**

Run:

```powershell
pytest backend/tests/services/test_kb_manifest_api.py -q
```

## Task 6: Extend Frontend Message and Stream Types

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/services/agentApi.ts`
- Modify: `frontend/src/hooks/useAgentChat.ts`

**Step 1: Add citation types**

Create:

- `CitationAnchor`
- `CitationStatus`

Extend:

- `AgentRunMessage`
- `AgentStreamEvent`

**Step 2: Update stream reducer**

Handle:

- `assistant_citations`
- `assistant_final`

Store citations on the assistant message being streamed.

**Step 3: Add targeted frontend tests**

Files:

- Create: `frontend/src/hooks/__tests__/useAgentChat.citations.test.ts`

Run:

```powershell
npm test -- useAgentChat.citations.test.ts
```

## Task 7: Render Clickable Inline Citations

**Files:**
- Modify: `frontend/src/components/AgentChatPanel.tsx`
- Create: `frontend/src/components/InlineCitationText.tsx`
- Create: `frontend/src/components/__tests__/InlineCitationText.test.tsx`

**Step 1: Create citation-aware text renderer**

Responsibilities:

- render markdown-compatible text
- replace citation markers with clickable components
- preserve math/markdown behavior already used by chat

**Step 2: Emit citation focus events**

On click, dispatch:

- `citationId`
- `fileId`
- `pageNo`
- `bboxNorm`
- `sourceRef`

**Step 3: Run targeted tests**

Run:

```powershell
npm test -- InlineCitationText.test.tsx
```

## Task 8: Integrate Left Preview Highlighting

**Files:**
- Modify: left preview viewer component(s) that currently render `/api/files/preview/{file_id}?page={n}`
- Modify: workroom state bridge / store where active file and page are tracked
- Create: preview overlay/highlight utility if not already present
- Create: frontend test covering citation click -> preview focus

**Step 1: Add preview focus event contract**

Implement a typed event or shared store action:

- `focusCitationAnchor(anchor: CitationAnchor)`

**Step 2: Add overlay highlight renderer**

Draw a highlighter rectangle from `bboxNorm`.

**Step 3: Switch active file/page before drawing highlight**

The left preview must become the primary citation visualization surface.

**Step 4: Run targeted tests**

Run:

```powershell
npm test -- citationPreviewFocus.test.tsx
```

## Task 9: End-to-End Verification

**Files:**
- Create or Modify: `backend/tests/agent/test_inline_citation_e2e.py`
- Create: frontend integration test or QA checklist document

**Step 1: Backend E2E**

Verify one answer turn can:

- retrieve KB evidence
- create citation anchors
- produce `[1]` inline answer text
- persist citation annotations

**Step 2: Frontend E2E / QA**

Verify:

- answer shows clickable `[1]`
- clicking `[1]` activates correct file tab
- preview jumps to correct page
- region highlight is drawn using cited `bboxNorm`

**Step 3: Run verification**

Backend:

```powershell
pytest backend/tests/agent/test_inline_citation_contract.py backend/tests/test_agent_stream_citations.py backend/tests/services/test_kb_manifest_api.py -q
```

Frontend:

```powershell
npm test -- InlineCitationText.test.tsx useAgentChat.citations.test.ts citationPreviewFocus.test.tsx
```

## Acceptance Criteria

- Final answers can contain inline citation markers such as `[1]`.
- Each inline citation maps to a structured backend citation anchor.
- Citation metadata survives refresh and conversation history reload.
- Clicking an inline citation focuses the left preview to the correct file and page.
- If `bboxNorm` exists, the exact cited region is highlighted.
- A user can inspect file ingestion results through `kb-manifest` without checking logs.
- The implementation does not depend on trace scraping or frontend inference.

## Out of Scope

- Hover-only citation panels
- PDF-native text selection overlays
- claim-level automatic fact-check grading
- cross-turn citation graph analytics

## Notes for Execution

- This work crosses runtime, persistence, KB contract, streaming, and preview UI. Do not batch it into one unreviewed patch.
- Prefer introducing explicit schemas and typed contracts before touching rendering.
- Preserve existing chat markdown/math behavior while adding citation rendering.

Plan complete and saved to `docs/plans/2026-03-29-inline-citation-infrastructure-plan.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
