from __future__ import annotations


def test_pre_model_hook_keeps_historical_tool_pairs_intact() -> None:
    from app.agent.assistant_graph.runtime_bootstrap import _build_pre_model_hook_messages

    messages, _updates = _build_pre_model_hook_messages(
        {
            "message_window": [
                {"role": "system", "content": "policy"},
                {"role": "user", "content": "第六题图例里的视风风速的坐标是什么？"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-1",
                            "type": "function",
                            "function": {"name": "list_studio_sources", "arguments": "{}"},
                        }
                    ],
                },
                {
                    "role": "tool",
                    "name": "list_studio_sources",
                    "tool_call_id": "call-1",
                    "content": [{"type": "text", "text": "{\"summary\":\"ok-1\"}"}],
                },
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-2",
                            "type": "function",
                            "function": {
                                "name": "resolve_question_card_candidates",
                                "arguments": "{\"query\":\"第六题\"}",
                            },
                        }
                    ],
                },
                {
                    "role": "tool",
                    "name": "resolve_question_card_candidates",
                    "tool_call_id": "call-2",
                    "content": [{"type": "text", "text": "{\"summary\":\"ok-2\"}"}],
                },
            ],
            "transient_tool_messages": [],
            "evidence_register": [],
            "context": {
                "environment_state": {
                    "workroom": {"id": 23, "status": "active"},
                    "layout": {
                        "center_panel": {"studio_view": "editor"},
                        "right_panel": {"is_agent_drawer_open": True},
                    },
                    "selection": {"active_center_document_id": None},
                    "bindings": {"source_file_ids": [1069]},
                    "artifacts": {"by_type": {}},
                }
            },
        },
        next_step_count=2,
    )

    roles = [str(item.get("role") or "") for item in messages]
    assert roles[:2] == ["system", "system"]
    assert roles[2:] == ["user", "assistant", "tool", "assistant", "tool"]
    assert messages[4]["tool_call_id"] == "call-1"
    assert messages[6]["tool_call_id"] == "call-2"
