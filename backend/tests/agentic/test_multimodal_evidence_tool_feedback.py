from __future__ import annotations


def test_read_kb_evidence_keeps_text_and_adds_multimodal(monkeypatch) -> None:
    from app.agent.tools.kb import evidence as kb

    def _fake_search_page_bundles(**_kwargs):
        return [
            {
                "file_id": 1054,
                "page_no": 2,
                "title": "doc",
                "best_distance": 0.12,
                "bundle_score": 1.1,
                "source_refs": ["chunk:101", "chunk:102"],
                "text_chunks": [
                    {
                        "chunk_id": 101,
                        "content": "文本证据片段",
                        "distance": 0.12,
                        "page_start": 2,
                        "page_end": 2,
                    }
                ],
                "primary_image": {
                    "chunk_id": 102,
                    "file_id": 1054,
                    "title": "doc",
                    "preview_url": "/api/files/preview/1054?page=3",
                    "page_no": 3,
                    "asset_kind": "page_image",
                    "asset_rel_path": "uploads/a/page_3.png",
                    "distance": 0.15,
                    "file_preview_path": "uploads/a/page_1.png",
                    "file_storage_path": "uploads/a/doc.pdf",
                },
            }
        ]

    monkeypatch.setattr(kb.RAGService, "search_page_bundles", lambda self, **kwargs: _fake_search_page_bundles(**kwargs))
    monkeypatch.setattr(kb, "_encode_asset_as_data_url", lambda _: "data:image/jpeg;base64,AAAA")

    out = kb.tool_read_kb_evidence(
        {"query": "第六题坐标", "top_k": 3},
        {"tenant_id": 2, "user_id": 2, "workroom_id": 12, "source_file_ids": [1054]},
    )

    assert len(out["snippets"]) == 1
    assert len(out["asset_refs"]) == 1
    assert out["asset_refs"][0]["preview_url"] == "/api/files/preview/1054?page=3"
    assert out["model_message_content"][1]["type"] == "image_url"


def test_tool_result_trace_observation_contains_feedback_outcome() -> None:
    from app.agent.assistant_graph.llm_tools import tool_result_to_trace as _tool_result_to_trace

    trace = _tool_result_to_trace(
        "read_kb_evidence",
        {"query": "q6"},
        {
            "results": [],
            "feedback": {
                "outcome": "ok_no_evidence",
                "reason": "no_evidence_found",
            },
        },
        ok=True,
        tool_call_id="call-1",
    )

    obs = trace.get("observation") or {}
    assert obs.get("summary") == "no_evidence_found"
    assert obs.get("outcome") == "ok_no_evidence"
