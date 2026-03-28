from __future__ import annotations


def test_build_agent_router_context_does_not_prebuild_environment_model() -> None:
    from app.agent.assistant_graph.router_runtime import build_agent_router_context

    context = build_agent_router_context(
        tenant_id=2,
        user_id=3,
        workroom_id=23,
        studio_document_id=501,
        source_file_ids=[1069, 1070],
        ui_context="exam_editor",
        session_id=11,
        thread_id="thread-1",
    )

    assert "environment" not in context
    assert context["workroom_id"] == 23
    assert context["source_file_ids"] == [1069, 1070]


def test_build_runtime_snapshot_keeps_three_panel_runtime_window() -> None:
    from app.agent.assistant_graph.router_runtime import build_runtime_snapshot, evolve_runtime_snapshot

    context = {
        "workroom_id": 23,
        "environment_state": {
            "layout": {
                "left_panel": {"pane": "sources"},
                "center_panel": {"studio_view": "mindmap"},
                "right_panel": {"is_agent_drawer_open": True},
            },
            "selection": {
                "active_file_id": 9,
                "active_session_id": 11,
                "active_tab_index": 2,
                "active_center_document_id": 501,
            },
            "bindings": {
                "source_file_ids": [1069, 1070],
            },
        },
    }

    base = build_runtime_snapshot(context)

    assert base["environment_window"]["workroom_id"] == 23
    assert base["environment_window"]["panels"]["left"]["pane"] == "sources"
    assert base["environment_window"]["panels"]["center"]["studio_view"] == "mindmap"
    assert base["environment_window"]["panels"]["right"]["is_agent_drawer_open"] is True
    assert base["environment_window"]["selection"]["active_center_document_id"] == 501
    assert base["environment_window"]["bindings"]["source_file_ids"] == [1069, 1070]
    assert "ui_context" not in base["environment_window"]
    assert "source_count" not in base["environment_window"]
    assert "studio_document_id" not in base["environment_window"]

    evolved = evolve_runtime_snapshot(
        previous=base,
        context=context,
        task_phase="observing",
        step_count=3,
        tool_results=[{"tool_name": "read_kb_evidence", "status": "ok", "source_refs": ["unit:46"]}],
        recent_changes=[{"change_type": "tool_error", "tool_name": "list_studio_sources", "status": "error"}],
    )

    assert evolved["environment_window"] == base["environment_window"]
    assert evolved["transition_state"]["latest_tool_name"] == "list_studio_sources"
    assert evolved["transition_state"]["added_source_refs"] == ["unit:46"]
    assert evolved["transition_state"]["errored_tools"] == ["list_studio_sources"]


def test_world_model_observe_environment_records_runtime_and_events_only() -> None:
    from app.agent.assistant_graph.world_model import observe_environment

    packet = {
        "task": {
            "phase": "observing",
            "step_count": 2,
            "goal_anchor": "定位题图证据",
            "subject_scope": "题图证据",
            "turn_intent": "读取候选证据",
            "feedback_signal": "",
        },
        "latest_tool_observation": {
            "tool_name": "read_kb_evidence",
            "status": "ok",
            "summary": "拿到可读证据",
            "source_refs": ["unit:46"],
        },
        "runtime_snapshot": {
            "environment_window": {
                "workroom_id": 23,
                "panels": {
                    "left": {"pane": "sources"},
                    "center": {"studio_view": "editor"},
                    "right": {"is_agent_drawer_open": False},
                },
                "selection": {
                    "active_center_document_id": 501,
                },
                "bindings": {
                    "source_file_ids": [1069],
                },
            },
            "transition_state": {
                "latest_tool_name": "read_kb_evidence",
                "latest_tool_status": "ok",
                "added_source_refs": ["unit:46"],
                "errored_tools": [],
            },
        },
    }

    model, _diff = observe_environment(None, observation_packet=packet, step_count=2)

    assert model["runtime_state"]["runtime_snapshot"]["environment_window"]["workroom_id"] == 23
    assert model["runtime_state"]["task"]["turn_intent"] == "读取候选证据"
    assert model["entities"]["runtime"]["source_file_ids"] == [1069]
    assert model["entities"]["runtime"]["center_panel_mode"] == "editor"
    assert model["entities"]["runtime"]["active_center_document_id"] == 501
    assert model["entities"]["runtime"]["left_knowledge_base"]["has_bound_sources"] is True
    assert model["entities"]["runtime"]["right_agent_drawer"]["open"] is False
    assert model["topology"]["runtime"]["regions"] == {
        "left": "knowledge_base",
        "center": "studio",
        "right": "agent_drawer",
    }
    assert model["entities"]["latest_tool"]["tool_name"] == "read_kb_evidence"
    assert model["relations"] == []
    assert model["recent_observations"][-1]["bound_source_count"] == 1
    assert model["facts"]["right_agent_drawer_open"] is False
    assert "ui_context" not in str(model)
    assert "studio_document_id" not in str(model["runtime_state"])
