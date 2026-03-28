from __future__ import annotations


def test_build_environment_state_models_real_three_panel_workroom() -> None:
    from app.agent.assistant_graph.router_runtime import build_environment_state

    environment_state = build_environment_state(
        workroom={"id": 23, "name": "wrk", "status": "active"},
        runtime_state={
            "active_file_id": 7,
            "active_session_id": 11,
            "active_tab_index": 2,
            "active_studio_document_id": 501,
            "left_panel_state_json": {"pane": "sources", "selected_source_file_id": 1069},
            "center_panel_state_json": {"studio_view": "mindmap", "is_answer_mode": True},
            "right_panel_state_json": {"is_agent_drawer_open": True},
        },
        sources=[
            {"file_id": 1069, "is_active": True},
            {"file_id": 1070, "is_active": False},
            {"file_id": 1071, "is_active": True},
        ],
        artifacts=[
            {"artifact_type": "flashcard", "artifact_ref_id": "fc-1", "payload_json": {}},
            {
                "artifact_type": "mindmap",
                "artifact_ref_id": "mm-1",
                "payload_json": {"nodes": [1, 2], "edges": [3]},
            },
        ],
        ui_context="exam_editor",
        studio_document_id=501,
        note_focus={"block_index": 3, "snippet": "wind vector"},
    )

    assert environment_state["workroom"]["id"] == 23
    assert environment_state["layout"]["left_panel"]["pane"] == "sources"
    assert environment_state["layout"]["center_panel"]["studio_view"] == "mindmap"
    assert environment_state["layout"]["right_panel"]["is_agent_drawer_open"] is True
    assert environment_state["selection"]["active_file_id"] == 7
    assert environment_state["selection"]["active_session_id"] == 11
    assert environment_state["selection"]["active_tab_index"] == 2
    assert environment_state["selection"]["active_center_document_id"] == 501
    assert environment_state["bindings"]["source_file_ids"] == [1069, 1071]
    assert len(environment_state["artifacts"]["items"]) == 2
    assert environment_state["focus"]["note_focus"]["block_index"] == 3
    assert "views" not in environment_state
    assert "ui_context" not in str(environment_state)
