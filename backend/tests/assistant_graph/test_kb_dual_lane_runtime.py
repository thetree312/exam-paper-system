from __future__ import annotations

from typing import Any


def test_read_kb_evidence_forwards_dual_lane_inputs_and_returns_assets(monkeypatch: Any) -> None:
    from app.agent.assistant_graph.nodes import execution_runtime
    from app.agent.assistant_graph.nodes.execution_runtime import execution_runtime_node

    captured: dict[str, Any] = {}

    class _FakeRAG:
        def search_chunks(self, **kwargs: Any) -> list[dict[str, Any]]:
            captured.update(kwargs)
            return [
                {
                    "chunk_id": 9001,
                    "chunk_type": "fulltext",
                    "file_id": 1054,
                    "source_id": 777,
                    "page_start": 2,
                    "title": "paper.pdf",
                    "distance": 0.12,
                    "content": "鏌愭椂鍒绘祴寰楃殑瑙嗛椋庨€熷搴旂殑鍚戦噺涓庤埞閫熷搴旂殑鍚戦噺濡傚浘2",
                    "metadata_json": {"modality": "text"},
                },
                {
                    "chunk_id": 9002,
                    "chunk_type": "page_image",
                    "file_id": 1054,
                    "source_id": 777,
                    "page_start": 2,
                    "title": "paper.pdf",
                    "distance": 0.22,
                    "content": "[image page 2]",
                    "metadata_json": {
                        "modality": "image",
                        "asset_kind": "page_image",
                        "asset_data_url": "data:image/png;base64,AAAA",
                    },
                },
            ]

    monkeypatch.setattr(execution_runtime, "RAGService", _FakeRAG)

    out = execution_runtime_node(
        {
            "tenant_id": 2,
            "user_id": 2,
            "workroom_id": 12,
            "source_file_ids": [1054],
            "active_tasks": [
                {
                    "task_id": "t-kb-dual",
                    "tool": "read_kb_evidence",
                    "objective": "retrieve multimodal evidence",
                    "inputs": {
                        "query": "绗叚棰?鍥句緥 瑙嗛椋庨€?鍧愭爣",
                        "top_text_k": 6,
                        "top_image_k": 2,
                        "max_assets": 2,
                        "prefer_visual_evidence": True,
                    },
                }
            ],
            "loaded_tools": ["tool_search", "read_kb_evidence"],
        }
    )

    assert captured["top_text_k"] == 6
    assert captured["top_image_k"] == 2

    results = out.get("task_results") or []
    content = results[0].get("content") if results and isinstance(results[0].get("content"), dict) else {}
    asset_refs = content.get("asset_refs") if isinstance(content.get("asset_refs"), list) else []
    assert asset_refs
    assert str(asset_refs[0].get("modality") or "") == "image"
    assert int(content.get("loaded_assets_count") or 0) == 1

