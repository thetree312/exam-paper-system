from __future__ import annotations


def test_get_workspace_resource_summary_reads_environment_counts() -> None:
    from app.agent.tools.workspace_environment import tool_get_workspace_resource_summary

    ctx = {
        "studio_document_id": 99,
        "environment": {
            "surfaces": {
                "workspace": {
                    "studio_document_id": 99,
                    "workspace_view": "questions",
                    "resource_summary": {
                        "question_card_count": 100,
                        "flashcard_count": 30,
                        "mindmap_node_count": 12,
                        "mindmap_edge_count": 11,
                        "ocr_item_count": 5,
                    },
                }
            }
        },
    }
    out = tool_get_workspace_resource_summary({}, ctx)
    assert out["feedback"]["status"] == "success"
    assert out["workspace_summary"]["question_card_count"] == 100
    assert out["workspace_summary"]["studio_document_id"] == 99
    assert "target_resolution" not in out
    assert "answerability" not in out
    assert "evidence_modality" not in out
    assert out["observations"][0]["kind"] == "workspace_resource_summary"


def test_resolve_question_card_candidates_requires_query() -> None:
    from app.agent.tools.workspace_environment import tool_resolve_question_card_candidates

    out = tool_resolve_question_card_candidates({}, {"tenant_id": 1})
    assert out["error"] == "empty_query"
    assert out["feedback"]["status"] == "error"
    assert "query" in out["feedback"]["missing_information"]


def test_read_workspace_question_card_requires_selector() -> None:
    from app.agent.tools.workspace_environment import tool_read_workspace_question_card

    ctx = {"tenant_id": 1, "studio_document_id": 99}
    out = tool_read_workspace_question_card({}, ctx)
    assert out["error"] == "missing_question_selector"
    assert out["feedback"]["status"] == "error"
    assert "question_id_or_sequence_index" in out["feedback"]["missing_information"]

