from __future__ import annotations


def test_observe_environment_keeps_only_fact_layer() -> None:
    from app.agent.assistant_graph.world_model import observe_environment

    after, _diff = observe_environment(
        None,
        observation_packet={
            "workspace": {"studio_document_id": None, "workspace_view": "editor", "resource_summary": {}},
            "knowledge_base": {"source_file_ids": [1056, 1055], "source_count": 2},
            "favorites": {"favorite_question_count": 0},
            "latest_tool_observation": {},
        },
        step_count=0,
    )

    facts = after["facts"]
    assert "target_resolution" not in facts
    assert "evidence_status" not in facts
    assert "answerability" not in facts
    assert "target_candidates_count" not in facts


def test_record_tool_result_does_not_write_engineering_judgement() -> None:
    from app.agent.assistant_graph.world_model import init_world_model, record_tool_result

    before = init_world_model()
    after, _diff = record_tool_result(
        before,
        trace={
            "tool_name": "search_kb_candidates",
            "status": "ok",
            "observation": {"query": "绗叚棰?鍥句緥", "summary": "found refs"},
            "source_refs": ["chunk:348", "chunk:338"],
            "output": {
                "candidate_refs": ["chunk:348", "chunk:338"],
                "doc_coverage": [{"file_id": 1056, "hit_count": 1}, {"file_id": 1055, "hit_count": 1}],
                "objects": [{"object_type": "knowledge_evidence_ref", "ref": "chunk:348"}],
                "observations": [{"kind": "knowledge_base_hit"}],
            },
        },
        step_count=1,
    )

    facts = after["facts"]
    assert "target_resolution" not in facts
    assert "evidence_status" not in facts
    assert "answerability" not in facts
    assert "target_candidates_count" not in facts

