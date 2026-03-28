from __future__ import annotations


def _ctx() -> dict:
    return {
        "tenant_id": 2,
        "studio_document_id": 501,
        "environment_state": {
            "selection": {
                "active_center_document_id": 501,
            },
            "layout": {
                "center_panel": {
                    "studio_view": "mindmap",
                },
            },
            "artifacts": {
                "items": [
                    {"artifact_type": "question_card", "studio_document_id": 501, "payload_json": {}},
                    {"artifact_type": "flashcard", "studio_document_id": 501, "payload_json": {}},
                    {
                        "artifact_type": "mindmap",
                        "studio_document_id": 501,
                        "payload_json": {"nodes": [1, 2, 3], "edges": [4]},
                    },
                    {"artifact_type": "ocr_item", "studio_document_id": 501, "payload_json": {}},
                ]
            },
        },
    }


def test_tool_get_studio_resource_summary_reads_environment_state() -> None:
    from app.agent.tools.studio_environment import tool_get_studio_resource_summary

    result = tool_get_studio_resource_summary({}, _ctx())

    summary = result["studio_summary"]
    assert summary["studio_document_id"] == 501
    assert summary["studio_view"] == "mindmap"
    assert summary["question_card_count"] == 1
    assert summary["flashcard_count"] == 1
    assert summary["mindmap_node_count"] == 3
    assert summary["mindmap_edge_count"] == 1
    assert summary["ocr_item_count"] == 1


def test_tool_list_studio_sources_no_longer_requires_legacy_environment() -> None:
    from app.agent.tools.studio_sources import tool_list_studio_sources

    result = tool_list_studio_sources({}, _ctx())

    assert result["target_resolution"] == "bound"
    assert result["studio_summary"]["studio_document_id"] == 501
    assert "environment" not in str(result)
