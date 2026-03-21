from __future__ import annotations


def test_list_workspace_sources_reads_workspace_summary_only() -> None:
    from app.agent.tools.workspace_sources import tool_list_workspace_sources

    ctx = {
        "tenant_id": 1,
        "source_file_ids": [1001, 1002],
        "environment": {
            "surfaces": {
                "workspace": {
                    "studio_document_id": 99,
                    "workspace_view": "questions",
                    "resource_summary": {
                        "question_card_count": 100,
                        "flashcard_count": 42,
                        "mindmap_node_count": 28,
                        "mindmap_edge_count": 27,
                        "ocr_item_count": 5,
                    },
                }
            }
        },
    }

    out = tool_list_workspace_sources({}, ctx)
    assert out["feedback"]["reason"] == "workspace_summary_listed"
    assert out["feedback"]["status"] == "success"
    assert isinstance(out["feedback"]["message"], str) and out["feedback"]["message"]
    assert out["workspace_summary"]["question_card_count"] == 100
    assert out["workspace_summary"]["mindmap_node_count"] == 28


def test_list_workspace_sources_returns_empty_when_no_workspace_summary() -> None:
    from app.agent.tools.workspace_sources import tool_list_workspace_sources

    ctx = {"tenant_id": 1, "source_file_ids": [1001]}
    out = tool_list_workspace_sources({}, ctx)
    assert out["workspace_summary"] == {}
    assert out["feedback"]["reason"] == "no_workspace_summary"
    assert out["feedback"]["status"] == "insufficient"
    assert out["feedback"]["missing_information"] == ["workspace_summary"]

