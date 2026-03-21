from __future__ import annotations

from typing import Any


def test_kb_evidence_returns_page_bundles_and_semantics(monkeypatch: Any) -> None:
    from app.agent.tools.kb import evidence as kb

    class _FakeRAG:
        def search_page_bundles(self, **kwargs: Any) -> list[dict[str, Any]]:
            return [
                {
                    "file_id": 11,
                    "page_no": 2,
                    "title": "doc-a",
                    "best_distance": 0.11,
                    "bundle_score": 1.2,
                    "source_refs": ["chunk:101", "chunk:103"],
                    "text_chunks": [
                        {
                            "chunk_id": 101,
                            "content": "candidate text a",
                            "distance": 0.11,
                            "page_start": 2,
                            "page_end": 2,
                        }
                    ],
                    "primary_image": None,
                },
                {
                    "file_id": 12,
                    "page_no": 5,
                    "title": "doc-b",
                    "best_distance": 0.12,
                    "bundle_score": 1.1,
                    "source_refs": ["chunk:102"],
                    "text_chunks": [
                        {
                            "chunk_id": 102,
                            "content": "candidate text b",
                            "distance": 0.12,
                            "page_start": 5,
                            "page_end": 5,
                        }
                    ],
                    "primary_image": None,
                },
            ]

    monkeypatch.setattr(kb, "RAGService", lambda: _FakeRAG())

    out = kb.tool_read_kb_evidence(
        {"query": "第六题图例视风风速的坐标", "top_k": 3},
        {"tenant_id": 1, "user_id": 2, "workroom_id": 3, "source_file_ids": [11, 12]},
    )

    assert out["query"] == "第六题图例视风风速的坐标"
    assert out["target_resolution"] == "ambiguous"
    assert out["answerability"] == "ambiguous_target"
    assert len(out["page_bundles"]) == 2
    assert out["page_bundles"][0]["file_id"] == 11
    assert isinstance(out["doc_coverage"], list)


def test_search_kb_candidates_reports_candidate_refs_from_page_bundles(monkeypatch: Any) -> None:
    from app.agent.tools.kb import evidence as kb

    class _FakeRAG:
        def search_page_bundles(self, **kwargs: Any) -> list[dict[str, Any]]:
            return [
                {
                    "file_id": 11,
                    "page_no": 2,
                    "title": "doc-a",
                    "best_distance": 0.11,
                    "bundle_score": 1.0,
                    "source_refs": ["chunk:101"],
                    "text_chunks": [
                        {
                            "chunk_id": 101,
                            "content": "candidate text a",
                            "distance": 0.11,
                            "page_start": 2,
                            "page_end": 2,
                        }
                    ],
                    "primary_image": None,
                }
            ]

    monkeypatch.setattr(kb, "RAGService", lambda: _FakeRAG())

    out = kb.tool_search_kb_candidates(
        {"query": "第六题图例", "top_k": 3},
        {"tenant_id": 1, "user_id": 2, "workroom_id": 3, "source_file_ids": [11]},
    )

    assert out["candidate_refs"] == ["chunk:101"]
    assert out["target_resolution"] == "bound"
    assert out["answerability"] == "candidate_only"


def test_read_kb_snippets_reports_visual_only_when_refs_resolve_to_image(monkeypatch: Any) -> None:
    from app.agent.tools.kb import evidence as kb

    class _FakeRAG:
        def get_chunks_by_ids(self, **kwargs: Any) -> list[dict[str, Any]]:
            return [
                {
                    "chunk_id": 301,
                    "file_id": 21,
                    "title": "doc-a",
                    "content": "[image]",
                    "distance": 0.0,
                    "metadata_json": {
                        "modality": "image",
                        "asset_kind": "page_image",
                        "asset_rel_path": "missing.jpg",
                    },
                    "page_start": 3,
                    "page_end": 3,
                    "chunk_type": "page_image",
                }
            ]

    monkeypatch.setattr(kb, "RAGService", lambda: _FakeRAG())

    out = kb.tool_read_kb_snippets(
        {"source_refs": ["chunk:301"]},
        {"tenant_id": 1, "user_id": 2, "workroom_id": 3, "source_file_ids": [21]},
    )

    assert out["snippets"] == []
    assert len(out["asset_refs"]) == 1
    assert out["target_resolution"] == "bound"
    assert out["answerability"] == "text_evidence_unavailable"


def test_read_kb_snippets_preserves_multimodal_model_message_content(monkeypatch: Any) -> None:
    from app.agent.tools.kb import evidence as kb

    class _FakeRAG:
        def get_chunks_by_ids(self, **kwargs: Any) -> list[dict[str, Any]]:
            return [
                {
                    "chunk_id": 301,
                    "file_id": 21,
                    "title": "doc-a",
                    "content": "[image]",
                    "distance": 0.0,
                    "metadata_json": {
                        "modality": "image",
                        "asset_kind": "page_image",
                        "asset_rel_path": "missing.jpg",
                    },
                    "page_start": 3,
                    "page_end": 3,
                    "chunk_type": "page_image",
                }
            ]

    monkeypatch.setattr(kb, "RAGService", lambda: _FakeRAG())
    monkeypatch.setattr(kb, "_encode_asset_as_data_url", lambda _: "data:image/jpeg;base64,AAAA")

    out = kb.tool_read_kb_snippets(
        {"source_refs": ["chunk:301"], "top_k": 9},
        {"tenant_id": 1, "user_id": 2, "workroom_id": 3, "source_file_ids": [21]},
    )

    model_message_content = out.get("model_message_content")
    assert isinstance(model_message_content, list)
    assert model_message_content[0]["type"] == "text"
    assert model_message_content[1]["type"] == "image_url"


def test_read_kb_evidence_uses_preview_path_when_asset_rel_path_is_stale(monkeypatch: Any) -> None:
    from app.agent.tools.kb import evidence as kb

    attempted_paths: list[str] = []

    class _FakeRAG:
        def search_page_bundles(self, **kwargs: Any) -> list[dict[str, Any]]:
            return [
                {
                    "file_id": 1056,
                    "page_no": 3,
                    "title": "doc-a",
                    "best_distance": 0.0,
                    "bundle_score": 1.0,
                    "source_refs": ["chunk:348"],
                    "text_chunks": [],
                    "primary_image": {
                        "chunk_id": 348,
                        "file_id": 1056,
                        "title": "doc-a",
                        "preview_url": "/api/files/preview/1056?page=3",
                        "page_no": 3,
                        "asset_kind": "page_image",
                        "asset_rel_path": "uploads/2/stale.page3.png",
                        "distance": 0.0,
                        "file_preview_path": "uploads/2/current.page1.png",
                        "file_storage_path": "uploads/2/current.pdf",
                    },
                }
            ]

    def _fake_encode(path: str) -> str | None:
        attempted_paths.append(path)
        if path == "uploads/2/current.page3.png":
            return "data:image/jpeg;base64,BBBB"
        return None

    monkeypatch.setattr(kb, "RAGService", lambda: _FakeRAG())
    monkeypatch.setattr(kb, "_encode_asset_as_data_url", _fake_encode)

    out = kb.tool_read_kb_evidence(
        {"query": "第六题图例视风风速的坐标", "top_k": 3},
        {"tenant_id": 1, "user_id": 2, "workroom_id": 3, "source_file_ids": [1056]},
    )

    model_message_content = out.get("model_message_content")
    assert attempted_paths == ["uploads/2/stale.page3.png", "uploads/2/current.page3.png"]
    assert isinstance(model_message_content, list)
    assert model_message_content[1]["type"] == "image_url"
    assert model_message_content[1]["image_url"]["url"] == "data:image/jpeg;base64,BBBB"


def test_read_kb_evidence_clamps_top_k_to_three(monkeypatch: Any) -> None:
    from app.agent.tools.kb import evidence as kb

    captured: dict[str, Any] = {}

    class _FakeRAG:
        def search_page_bundles(self, **kwargs: Any) -> list[dict[str, Any]]:
            captured.update(kwargs)
            return []

    monkeypatch.setattr(kb, "RAGService", lambda: _FakeRAG())

    kb.tool_read_kb_evidence(
        {"query": "第六题图例视风风速的坐标", "top_k": 9},
        {"tenant_id": 1, "user_id": 2, "workroom_id": 3, "source_file_ids": [11, 12]},
    )

    assert captured["limit"] == 3
