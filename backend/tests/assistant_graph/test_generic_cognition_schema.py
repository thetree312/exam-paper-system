from __future__ import annotations


def test_blackboard_schema_uses_only_generic_cognition_terms() -> None:
    from app.agent.assistant_graph.cognition_blackboard import build_cognitive_blackboard

    board = build_cognitive_blackboard(
        messages=[{"role": "user", "content": "瑙ｉ噴涓€涓嬭繖涓粨璁?}],
        observation_packet={
            "workspace": {"studio_document_id": None, "workspace_view": "notes", "resource_summary": {}},
            "knowledge_base": {"source_file_ids": [10, 11], "source_count": 2},
            "favorites": {},
            "task": {"goal_anchor": "瑙ｉ噴涓€涓嬭繖涓粨璁?, "phase": "observing", "step_count": 0},
        },
    )

    serialized = str(board)
    for forbidden in ("question_anchor", "container_ambiguity", "shared_reference", "clarification_required"):
        assert forbidden not in serialized

