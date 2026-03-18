# KB Evidence Dual-Lane Retrieval Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `read_kb_evidence` reliably return image asset references alongside text evidence, then tighten ORC/tool-search query semantics.

**Architecture:** Split the fix into two stages. First, change KB retrieval from single global top-k to text/image dual-lane recall and let `read_kb_evidence` consume both lanes. Second, tighten ORC-generated tool-search queries and reduce tool catalog embedding noise so first-call tool discovery is less workspace-biased.

**Tech Stack:** Python, SQLAlchemy, pgvector, pytest.

---

### Task 1: Add failing tests for dual-lane KB retrieval
- Files:
  - Modify: `backend/tests/assistant_graph/test_execution_runtime_world_changes.py`
  - Create/Modify if needed: `backend/tests/services/test_rag_service.py`
- Add tests that prove:
  - image chunks present in retrieval pool are not dropped behind text-only top-k
  - `read_kb_evidence` returns `asset_refs` and `loaded_assets_count > 0` when image rows exist

### Task 2: Implement dual-lane retrieval in `RAGService`
- Files:
  - Modify: `backend/app/services/rag_service.py`
- Change `search_chunks()` to fetch a mixed pool then split by modality/chunk_type into text/image lanes, cap each lane separately, and merge into a stable result set.

### Task 3: Update `read_kb_evidence` worker to consume image hits explicitly
- Files:
  - Modify: `backend/app/assistant_graph/nodes/execution_runtime.py`
- Add support for `top_text_k`, `top_image_k`, `prefer_visual_evidence` inputs.
- Ensure returned content contains `asset_refs` when image hits exist and `state_delta.vision_assets` when payload loading succeeds.

### Task 4: Add failing tests for ORC/tool-search query quality and tool catalog noise
- Files:
  - Modify: `backend/tests/assistant_graph/test_orc_loop_world_snapshot_prompt.py`
  - Modify: `backend/tests/assistant_graph/test_tool_registry_world_metadata.py`
- Prove prompt requires domain/object/unavailable-domain language for `tool_search` query.
- Prove embedding doc text no longer depends on bulky schema/input hints as primary semantics.

### Task 5: Implement ORC/tool-search improvements
- Files:
  - Modify: `backend/app/assistant_graph/nodes/orc_loop.py`
  - Modify: `backend/app/services/tool_search_service.py`
- Tighten world-first prompt wording for query generation.
- Reduce tool catalog embedding text to summary/domain/capability/object/domain metadata.

### Task 6: Verify
- Run focused pytest targets for touched files.
- Run broader `assistant_graph` regression excluding known unrelated failing test if still necessary.
