from __future__ import annotations


def test_build_default_blackboard_has_protocol_containers() -> None:
    from app.agent.assistant_graph.cognition_blackboard import build_default_blackboard

    board = build_default_blackboard()

    assert board == {
        "entries": [],
        "relations": [],
        "working_set": {"focus_entry_ids": [], "candidate_entry_ids": [], "open_question_entry_ids": []},
        "decision_trace": [],
        "revisions": [],
    }


def test_apply_blackboard_patch_appends_entries_relations_and_revision() -> None:
    from app.agent.assistant_graph.cognition_blackboard import apply_blackboard_patch, build_default_blackboard

    board = build_default_blackboard()
    patch = {
        "append_entries": [
            {
                "id": "entry-goal",
                "kind": "claim",
                "content": {"text": "user wants the coordinate"},
                "status": "active",
                "confidence": 0.8,
                "provenance_refs": ["msg:user:1"],
            },
            {
                "id": "entry-question",
                "kind": "question",
                "content": {"text": "which document contains the target object"},
                "status": "active",
                "confidence": 0.7,
                "provenance_refs": ["msg:user:1"],
            },
        ],
        "append_relations": [
            {
                "id": "rel-1",
                "from_entry_id": "entry-question",
                "to_entry_id": "entry-goal",
                "type": "about",
                "status": "active",
                "confidence": 0.6,
                "provenance_refs": ["msg:user:1"],
            }
        ],
        "working_set_update": {
            "focus_entry_ids": ["entry-question"],
            "candidate_entry_ids": ["entry-goal"],
            "open_question_entry_ids": ["entry-question"],
        },
        "decision_trace_append": [
            {"kind": "reflection", "content": "need more grounding", "entry_refs": ["entry-question"]}
        ],
    }

    updated = apply_blackboard_patch(board, patch=patch, step_count=1, source="reflect")

    assert [item["id"] for item in updated["entries"]] == ["entry-goal", "entry-question"]
    assert updated["relations"][0]["from_entry_id"] == "entry-question"
    assert updated["working_set"]["focus_entry_ids"] == ["entry-question"]
    assert updated["decision_trace"][0]["kind"] == "reflection"
    assert updated["revisions"][0]["source"] == "reflect"


def test_apply_blackboard_patch_invalidates_entry_without_semantic_interpretation() -> None:
    from app.agent.assistant_graph.cognition_blackboard import apply_blackboard_patch, build_default_blackboard

    board = build_default_blackboard()
    board = apply_blackboard_patch(
        board,
        patch={
            "append_entries": [
                {
                    "id": "entry-1",
                    "kind": "claim",
                    "content": {"text": "candidate A"},
                    "status": "active",
                    "confidence": 0.5,
                    "provenance_refs": [],
                }
            ]
        },
        step_count=0,
        source="reflect",
    )

    updated = apply_blackboard_patch(
        board,
        patch={"invalidate_entry_ids": ["entry-1"]},
        step_count=1,
        source="reflect",
    )

    assert updated["entries"][0]["status"] == "invalidated"
