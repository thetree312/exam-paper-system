from __future__ import annotations


def test_memory_sync_does_not_emit_environment_as_system_prompt() -> None:
    from app.agent.assistant_graph.runtime_bootstrap import _node_memory_sync, _node_prepare

    context = {"workroom_id": 23, "ui_context": "exam_editor", "source_file_ids": [1069, 1070]}
    prepared = _node_prepare(
        {
            "context": context,
            "conversation_messages": [{"role": "user", "content": "第六题图例里视风风速的坐标是什么"}],
            "ingress_messages": [],
        }
    )

    synced = _node_memory_sync({"context": context, **prepared})

    assert synced["message_window"][0]["role"] == "system"
    assert len(synced["message_window"]) == 2
    assert synced["message_window"][1]["role"] == "user"
    assert "objects" not in str(synced["message_window"])
    assert "relations" not in str(synced["message_window"])
    assert "Decision State" not in str(synced["message_window"])
    assert isinstance(synced["observation_packet"], dict)
    assert synced["observation_packet"]["runtime_snapshot"]["environment_window"]["bindings"]["source_file_ids"] == [1069, 1070]
    assert "workroom" not in synced["observation_packet"]
    assert "studio" not in synced["observation_packet"]
    assert "knowledge_base" not in synced["observation_packet"]


def test_node_decide_injects_runtime_state_transiently_without_persisting_it(monkeypatch) -> None:
    from app.agent.assistant_graph import runtime_bootstrap as rb

    captured: dict[str, object] = {}

    def fake_invoke_model_action(*, client, messages, tools, stream_writer=None):
        captured["messages"] = messages
        return "继续解题", [], []

    monkeypatch.setattr(rb, "_invoke_model_action", fake_invoke_model_action)
    monkeypatch.setattr(rb, "_new_client", lambda: object())

    state = {
        "context": {},
        "step_count": 4,
        "message_window": [
            {"role": "system", "content": "policy"},
            {"role": "user", "content": "为什么跟参考答案不一样？"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call-1",
                        "type": "function",
                        "function": {"name": "read_kb_evidence", "arguments": "{}"},
                    }
                ],
            },
        ],
        "transient_tool_messages": [
            {
                "role": "tool",
                "name": "read_kb_evidence",
                "tool_call_id": "call-1",
                "content": [{"type": "text", "text": '{"summary":"图中箭头方向需要复核"}'}],
            }
        ],
        "evidence_register": [],
        "context": {
            "environment_state": {
                "workroom": {"id": 23},
                "layout": {"center_panel": {"studio_view": "editor"}},
                "selection": {"active_center_document_id": None},
                "bindings": {"source_file_ids": [1069, 1070]},
                "artifacts": {"by_type": {"mindmap": [{"id": 1}], "flashcards": []}},
                "focus": {"note_focus": {"kind": "question"}},
            }
        },
        "runtime_snapshot": {
            "environment_window": {
                "workroom_id": 23,
                "panels": {"center": {"studio_view": "editor"}},
                "selection": {"active_center_document_id": None},
                "bindings": {"source_file_ids": [1069, 1070]},
            }
        },
    }

    rb._node_decide(state)

    messages = captured["messages"]
    assert any(item.get("role") == "user" for item in messages if isinstance(item, dict))
    assert messages[0]["role"] == "system"
    assert "Current runtime state for this user turn only." in str(messages[0].get("content") or "")
    assert messages[1]["role"] == "system"
    assert str(messages[1].get("content") or "") == "policy"
    assert any(
        isinstance(item, dict)
        and str(item.get("role") or "").strip().lower() == "system"
        and "Current runtime state for this user turn only." in str(item.get("content") or "")
        and "2 bound source files" in str(item.get("content") or "")
        for item in messages
    )
    assert not any("Decision State" in str(item) or "Working Set" in str(item) for item in messages)
    assert not any(
        isinstance(item, dict)
        and "Current runtime state for this user turn only." in str(item.get("content") or "")
        for item in state["message_window"]
    )


def test_node_decide_uses_pre_model_hook_to_inject_runtime_first_on_every_model_call(monkeypatch) -> None:
    from app.agent.assistant_graph import runtime_bootstrap as rb

    captured: list[list[dict[str, object]]] = []

    def fake_invoke_model_action(*, client, messages, tools, stream_writer=None):
        captured.append(messages)
        return "", [], []

    monkeypatch.setattr(rb, "_invoke_model_action", fake_invoke_model_action)
    monkeypatch.setattr(rb, "_new_client", lambda: object())

    state = {
        "step_count": 1,
        "message_window": [
            {"role": "system", "content": "policy"},
            {"role": "user", "content": "第六题图例里视风风速的坐标是什么"},
        ],
        "transient_tool_messages": [],
        "evidence_register": [],
        "context": {
            "environment_state": {
                "workroom": {"id": 23, "status": "active"},
                "layout": {
                    "left_panel": {},
                    "center_panel": {"studio_view": "editor", "is_answer_mode": False},
                    "right_panel": {"is_agent_drawer_open": True},
                },
                "selection": {
                    "active_file_id": 1069,
                    "active_session_id": 1068,
                    "active_center_document_id": None,
                },
                "bindings": {"source_file_ids": [1069, 1070]},
                "artifacts": {"by_type": {"mindmap": [{"id": 1}], "flashcard": [{"id": 2}, {"id": 3}]}},
            }
        },
        "runtime_snapshot": {
            "environment_window": {
                "workroom_id": 23,
                "panels": {
                    "left": {},
                    "center": {"studio_view": "editor", "is_answer_mode": False},
                    "right": {"is_agent_drawer_open": True},
                },
                "selection": {
                    "active_file_id": 1069,
                    "active_session_id": 1068,
                    "active_center_document_id": None,
                },
                "bindings": {"source_file_ids": [1069, 1070]},
            }
        },
    }

    first = rb._node_decide(state)
    second_state = {**state, **first.update}
    rb._node_decide(second_state)

    first_messages = captured[0]
    second_messages = captured[1]
    assert first_messages[0]["role"] == "system"
    assert second_messages[0]["role"] == "system"
    assert "Current runtime state for this user turn only." in str(first_messages[0].get("content") or "")
    assert "Current runtime state for this user turn only." in str(second_messages[0].get("content") or "")
    assert str(first_messages[1].get("content") or "") == "policy"
    assert str(second_messages[1].get("content") or "") == "policy"
    assert sum(
        1
        for item in first_messages
        if isinstance(item, dict) and "Current runtime state for this user turn only." in str(item.get("content") or "")
    ) == 1
    assert sum(
        1
        for item in second_messages
        if isinstance(item, dict) and "Current runtime state for this user turn only." in str(item.get("content") or "")
    ) == 1


def test_pre_model_hook_preserves_runtime_first_then_policy_then_conversation() -> None:
    from app.agent.assistant_graph.runtime_bootstrap import _build_pre_model_hook_messages

    messages, _updates = _build_pre_model_hook_messages(
        {
            "message_window": [
                {"role": "system", "content": "policy"},
                {"role": "user", "content": "第六题图例里视风风速的坐标是什么"},
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
                    "bindings": {"source_file_ids": [1069, 1070]},
                    "artifacts": {"by_type": {}},
                }
            },
        },
        next_step_count=2,
    )

    assert [item["role"] for item in messages[:3]] == ["system", "system", "user"]
    assert "Current runtime state for this user turn only." in str(messages[0]["content"])
    assert str(messages[1]["content"]) == "policy"
    assert str(messages[2]["content"]) == "第六题图例里视风风速的坐标是什么"


def test_build_runtime_context_message_is_semantic_and_compact() -> None:
    from app.agent.assistant_graph.runtime_bootstrap import _build_runtime_context_message

    message = _build_runtime_context_message(
        {
            "context": {
                "environment_state": {
                    "workroom": {"id": 23, "name": "高考数学复习工作台", "status": "active"},
                    "layout": {
                        "left_panel": {},
                        "center_panel": {"studio_view": "mindmap", "is_answer_mode": False},
                        "right_panel": {"is_agent_drawer_open": True, "agent_view_id": "view-22031-1182"},
                    },
                    "selection": {
                        "active_file_id": 1069,
                        "active_session_id": 1182,
                        "active_tab_index": 0,
                        "active_center_document_id": 22031,
                    },
                    "bindings": {"source_file_ids": list(range(1000, 1014))},
                    "artifacts": {
                        "by_type": {
                            "question_card": [{"id": idx} for idx in range(24)],
                            "flashcard": [{"id": idx} for idx in range(138)],
                            "mindmap": [{"id": idx} for idx in range(6)],
                        }
                    },
                }
            },
            "runtime_snapshot": {},
        }
    )

    content = str(message["content"])
    assert "Current runtime state for this user turn only." in content
    assert "Left knowledge base" in content
    assert "Center studio" in content
    assert "Right agent drawer" in content
    assert "14 bound source files" in content
    assert "question_card=24" in content
    assert "flashcard=138" in content
    assert "active file id" not in content
    assert "active session id" not in content
    assert "active tab index" not in content
    assert '"layout"' not in content
    assert '"runtime_snapshot"' not in content
    assert '"source_file_ids"' not in content


def test_execute_tools_does_not_pollute_visible_conversation_with_tool_messages() -> None:
    from app.agent.assistant_graph import runtime_bootstrap as rb

    state = {
        "context": {},
        "messages": [
            {"role": "system", "content": "policy"},
            {"role": "user", "content": "第六题图例里视风风速的坐标是什么"},
        ],
        "conversation_messages": [
            {"role": "user", "content": "第六题图例里视风风速的坐标是什么"},
        ],
        "step_count": 2,
        "model_turn": {"response_text": "视风向量坐标应继续核对图像证据。", "tool_calls": []},
        "runtime_snapshot": {},
    }

    result = rb._node_execute_tools(state)
    updates = result.update

    assert updates["messages"][-1]["role"] == "assistant"
    assert updates["conversation_messages"] == [
        {"role": "user", "content": "第六题图例里视风风速的坐标是什么"},
        {"role": "assistant", "content": "视风向量坐标应继续核对图像证据。"},
    ]
    assert all(item["role"] in {"user", "assistant"} for item in updates["conversation_messages"])


def test_interrupt_user_resume_only_writes_visible_user_message(monkeypatch) -> None:
    from app.agent.assistant_graph import runtime_bootstrap as rb

    monkeypatch.setattr(
        rb,
        "interrupt",
        lambda _payload: {"form_state": {"clarification": "箭头起点在(0,2)"}, "action_id": "submit"},
    )

    state = {
        "context": {},
        "messages": [
            {"role": "system", "content": "policy"},
            {"role": "user", "content": "为什么跟参考答案不一样？"},
        ],
        "conversation_messages": [
            {"role": "user", "content": "为什么跟参考答案不一样？"},
        ],
        "interrupt_payload": {
            "interrupt_id": "intr-1",
            "prompt": "请补充图中箭头起点",
            "openui": {
                "fields": [
                    {"id": "clarification", "name": "clarification", "label": "请补充说明", "type": "longText"}
                ]
            },
        },
        "step_count": 6,
        "runtime_snapshot": {},
        "world_model": {},
    }

    result = rb._node_interrupt_user(state)
    updates = result.update

    assert updates["messages"][-1]["role"] == "user"
    assert "箭头起点在(0,2)" in updates["messages"][-1]["content"]
    assert updates["conversation_messages"] == [
        {"role": "user", "content": "为什么跟参考答案不一样？"},
        {"role": "user", "content": updates["messages"][-1]["content"]},
    ]
    assert all(item["role"] == "user" for item in updates["conversation_messages"])
