from __future__ import annotations

import json
from typing import Any


def test_search_kb_candidates_is_candidate_only_and_does_not_inline_heavy_evidence(monkeypatch: Any) -> None:
    from app.agent.tools import knowledge_evidence as kb

    class _FakeRAG:
        def search_unit_refs(self, **kwargs: Any) -> list[dict[str, Any]]:
            return [
                {
                    "unit_id": 7,
                    "unit_key": "page:7",
                    "unit_type": "page",
                    "file_id": 1064,
                    "source_id": 34,
                    "page_no_start": 7,
                    "page_no_end": 7,
                    "title": "doc-a.pdf",
                    "distance": 0.11,
                    "matched_embed_kind": "text",
                    "matched_embed_kinds": ["text", "image"],
                },
                {
                    "unit_id": 18,
                    "unit_key": "page:3",
                    "unit_type": "page",
                    "file_id": 1065,
                    "source_id": 35,
                    "page_no_start": 3,
                    "page_no_end": 3,
                    "title": "doc-b.pdf",
                    "distance": 0.13,
                    "matched_embed_kind": "image",
                    "matched_embed_kinds": ["image"],
                },
            ]

    monkeypatch.setattr(kb, "RAGService", lambda: _FakeRAG())

    out = kb.tool_search_kb_candidates(
        {"query": "math", "top_k": 3},
        {"tenant_id": 1, "user_id": 2, "workroom_id": 3, "source_file_ids": [1064, 1065]},
    )

    assert out["answerability"] == "candidate_only"
    assert out["candidate_refs"] == ["unit:7", "unit:18"]
    assert out["source_refs"] == ["unit:7", "unit:18"]
    model_message_content = out["model_message_content"]
    assert isinstance(model_message_content, list)
    assert len(model_message_content) == 1
    payload = json.loads(model_message_content[0]["text"])
    assert "candidate_refs" in payload
    assert "doc_coverage" in payload
    assert "snippets" not in payload
    assert "evidence_units" not in payload
    assert "evidence_objects" not in payload


def test_read_kb_snippets_model_payload_excludes_full_evidence_units(monkeypatch: Any) -> None:
    from app.agent.tools import knowledge_evidence as kb

    class _FakeRAG:
        def get_units_by_ids(self, **kwargs: Any) -> list[dict[str, Any]]:
            return [
                {
                    "unit_id": 7,
                    "unit_key": "page:7",
                    "unit_type": "page",
                    "file_id": 1064,
                    "source_id": 34,
                    "page_no_start": 7,
                    "page_no_end": 7,
                    "title": "doc-a.pdf",
                    "text_content": "x" * 3000,
                    "primary_image_path": "uploads/2/p7.jpg",
                    "distance": 0.0,
                }
            ]

    monkeypatch.setattr(kb, "RAGService", lambda: _FakeRAG())
    monkeypatch.setattr(kb, "_encode_asset_as_data_url", lambda _: "data:image/jpeg;base64,AAAA")

    out = kb.tool_read_kb_snippets(
        {"source_refs": ["unit:7"], "query": "math problem"},
        {"tenant_id": 1, "user_id": 2, "workroom_id": 3, "source_file_ids": [1064]},
    )

    model_message_content = out["model_message_content"]
    assert isinstance(model_message_content, list)
    payload = json.loads(model_message_content[0]["text"])
    assert "snippets" in payload
    assert "asset_refs" in payload
    assert "evidence_units" not in payload
    assert "doc_coverage" not in payload


def test_render_resume_user_message_flattens_component_state_values() -> None:
    from app.agent.assistant_graph.runtime_bootstrap import _render_resume_user_message

    message = _render_resume_user_message(
        submission={
            "form_state": {
                "topic": {"value": "math", "componentType": "text"},
                "quantity": {"value": 2, "componentType": "number"},
                "use_kb": {"value": "yes", "componentType": "select"},
            }
        },
        interrupt_payload={
            "openui": {
                "fields": [
                    {"id": "topic", "name": "topic", "label": "Topic"},
                    {"id": "quantity", "name": "quantity", "label": "Quantity"},
                    {"id": "use_kb", "name": "use_kb", "label": "Use KB"},
                ]
            }
        },
    )

    assert "componentType" not in message
    assert '{"value"' not in message
    assert "Topic（topic）：math" in message
    assert "Quantity（quantity）：2" in message
    assert "Use KB（use_kb）：yes" in message


def test_read_kb_evidence_returns_partial_evidence_for_bound_readable_units(monkeypatch: Any) -> None:
    from app.agent.tools import knowledge_evidence as kb

    class _FakeRAG:
        def search_units(self, **kwargs: Any) -> list[dict[str, Any]]:
            return [
                {
                    "unit_id": 7,
                    "unit_key": "page:7",
                    "unit_type": "page",
                    "file_id": 1064,
                    "source_id": 34,
                    "page_no_start": 7,
                    "page_no_end": 7,
                    "title": "doc-a.pdf",
                    "text_content": "full readable evidence " * 20,
                    "primary_image_path": "uploads/2/p7.jpg",
                    "distance": 0.0,
                }
            ]

    monkeypatch.setattr(kb, "RAGService", lambda: _FakeRAG())
    monkeypatch.setattr(kb, "_encode_asset_as_data_url", lambda _: "data:image/jpeg;base64,AAAA")

    out = kb.tool_read_kb_evidence(
        {"query": "ground from kb", "top_k": 3},
        {"tenant_id": 1, "user_id": 2, "workroom_id": 3, "source_file_ids": [1064]},
    )

    assert out["target_resolution"] == "bound"
    assert out["answerability"] == "partial_evidence"
    assert out["feedback"]["status"] == "partial"


def test_read_kb_snippets_returns_partial_evidence_for_bound_text_refs(monkeypatch: Any) -> None:
    from app.agent.tools import knowledge_evidence as kb

    class _FakeRAG:
        def get_units_by_ids(self, **kwargs: Any) -> list[dict[str, Any]]:
            return [
                {
                    "unit_id": 7,
                    "unit_key": "page:7",
                    "unit_type": "page",
                    "file_id": 1064,
                    "source_id": 34,
                    "page_no_start": 7,
                    "page_no_end": 7,
                    "title": "doc-a.pdf",
                    "text_content": "full readable evidence " * 20,
                    "primary_image_path": "",
                    "distance": 0.0,
                }
            ]

    monkeypatch.setattr(kb, "RAGService", lambda: _FakeRAG())

    out = kb.tool_read_kb_snippets(
        {"source_refs": ["unit:7"], "query": "ground from kb"},
        {"tenant_id": 1, "user_id": 2, "workroom_id": 3, "source_file_ids": [1064]},
    )

    assert out["target_resolution"] == "bound"
    assert out["answerability"] == "partial_evidence"
    assert out["feedback"]["status"] == "partial"


def test_world_model_treats_partial_evidence_as_readable_progress() -> None:
    from app.agent.assistant_graph.world_model import record_tool_result

    world_model, _ = record_tool_result(
        None,
        trace={
            "tool_name": "read_kb_evidence",
            "status": "ok",
            "observation": {"query": "ground from kb", "summary": "Readable evidence was found."},
            "source_refs": ["unit:7"],
            "output": {
                "source_refs": ["unit:7"],
                "answerability": "partial_evidence",
                "target_resolution": "bound",
                "evidence_summary": {"evidence_count": 1},
            },
            "arguments": {"query": "ground from kb"},
        },
        step_count=2,
    )

    facts = (world_model or {}).get("facts") or {}
    assert facts.get("evidence_status") == "readable"
    assert facts.get("last_tool_progress") is True
