from __future__ import annotations


def test_list_workspace_sources_exposes_unified_semantics_for_bound_workspace() -> None:
    from app.agent.tools.workspace_sources import tool_list_workspace_sources

    ctx = {
        "environment": {
            "surfaces": {
                "workspace": {
                    "studio_document_id": 99,
                    "workspace_view": "questions",
                    "resource_summary": {
                        "question_card_count": 2,
                        "flashcard_count": 1,
                        "mindmap_node_count": 0,
                        "mindmap_edge_count": 0,
                        "ocr_item_count": 0,
                    },
                }
            }
        }
    }

    out = tool_list_workspace_sources({}, ctx)

    assert out["target_resolution"] == "bound"
    assert out["answerability"] == "context_only"
    assert out["evidence_modality"] == "none"
    assert out["feedback"]["status"] == "success"
    assert out["feedback"]["outcome"] == "workspace_context_available"
    assert out["feedback"]["missing_information"] == []

