from __future__ import annotations

from typing import Any


def test_execute_tool_action_preserves_multimodal_tool_message_content(monkeypatch: Any) -> None:
    import app.agent.assistant_graph.runtime_nodes as rn

    monkeypatch.setattr(
        rn,
        "execute_tool_call",
        lambda name, arguments, context: {
            "feedback": {"status": "ok", "message": "visual evidence"},
            "model_message_content": [
                {"type": "text", "text": '{"query":"第六题"}'},
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AAAA"}},
            ],
        },
    )

    out = rn._execute_tool_action(
        tool_name="read_kb_evidence",
        tool_arguments={"query": "第六题", "top_k": 5},
        context={},
        state_snapshot={},
        call_id="call-1",
    )

    assert isinstance(out, dict)
    transient_msg = out["transient_msg"]
    history_msg = out["history_msg"]
    assert isinstance(transient_msg.get("content"), list)
    assert transient_msg["content"][1]["type"] == "image_url"
    assert isinstance(history_msg.get("content"), list)
    assert len(history_msg["content"]) == 1
    assert history_msg["content"][0]["type"] == "text"


def test_execute_tool_action_persists_compact_receipt_instead_of_full_evidence_blob(monkeypatch: Any) -> None:
    import app.agent.assistant_graph.runtime_nodes as rn

    monkeypatch.setattr(
        rn,
        "execute_tool_call",
        lambda name, arguments, context: {
            "feedback": {"status": "ok", "message": "Readable evidence was found."},
            "source_refs": ["unit:101", "unit:102"],
            "answerability": "answerable",
            "target_resolution": "bound",
            "model_message_content": [
                {
                    "type": "text",
                    "text": (
                        '{"query":"第六题图例","evidence_objects":[{"kind":"snippet","payload":{"content":"very long"}},'
                        '{"kind":"asset_ref","payload":{"page_no":6}}],"snippets":[{"chunk_id":1,"content":"big blob"}]}'
                    ),
                },
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AAAA"}},
            ],
        },
    )

    out = rn._execute_tool_action(
        tool_name="read_kb_evidence",
        tool_arguments={"query": "第六题图例", "top_k": 5},
        context={},
        state_snapshot={},
        call_id="call-compact",
    )

    history_msg = out["history_msg"]
    assert isinstance(history_msg.get("content"), list)
    assert len(history_msg["content"]) == 1
    text = history_msg["content"][0]["text"]
    assert "evidence_objects" not in text
    assert "snippets" not in text
    assert "source_refs" in text
    assert "answerability" in text
    assert "target_resolution" in text


def test_node_decide_includes_transient_multimodal_tool_messages(monkeypatch: Any) -> None:
    import app.agent.assistant_graph.runtime_nodes as rn

    captured: dict[str, Any] = {}

    def _fake_invoke_model_action(
        *,
        client: Any,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        stream_writer: Any = None,
    ) -> tuple[str, list[dict[str, Any]], list[str]]:
        captured["messages"] = messages
        return ("已读取图片。", [], [])

    monkeypatch.setattr(rn, "_invoke_model_action", _fake_invoke_model_action)
    monkeypatch.setattr(rn, "_new_client", lambda: object())
    monkeypatch.setattr(rn, "get_stream_writer", lambda: None)

    state = {
        "context": {"ui_context": "exam_editor"},
        "messages": [
            {"role": "system", "content": "system"},
            {"role": "user", "content": "第六题图例视风风速的坐标是什么"},
        ],
        "transient_tool_messages": [
            {
                "role": "tool",
                "name": "read_kb_snippets",
                "tool_call_id": "call-1",
                "content": [
                    {"type": "text", "text": '{"query":"第六题"}'},
                    {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AAAA"}},
                ],
            }
        ],
        "model_messages": [{"role": "user", "content": "{}"}],
        "runtime_snapshot": {},
        "exec_state": {},
        "step_count": 0,
    }

    cmd = rn._node_decide(state)  # type: ignore[arg-type]

    sent = captured["messages"]
    assert len(sent) == 4
    assert isinstance(sent[2]["content"], list)
    assert sent[2]["content"][1]["type"] == "image_url"
    assert getattr(cmd, "goto", None) == "execute_tools"


def test_runtime_bootstrap_decide_includes_transient_multimodal_tool_messages(monkeypatch: Any) -> None:
    import app.agent.assistant_graph.runtime_bootstrap as rb

    captured: dict[str, Any] = {}

    def _fake_invoke_model_action(
        *,
        client: Any,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        stream_writer: Any = None,
    ) -> tuple[str, list[dict[str, Any]], list[str]]:
        captured["messages"] = messages
        return ("已读取图片。", [], [])

    monkeypatch.setattr(rb, "_invoke_model_action", _fake_invoke_model_action)
    monkeypatch.setattr(rb, "_new_client", lambda: object())
    monkeypatch.setattr(rb, "get_stream_writer", lambda: None)

    state = {
        "context": {"ui_context": "exam_editor"},
        "messages": [
            {"role": "system", "content": "system"},
            {"role": "user", "content": "第六题图例视风风速的坐标是什么"},
        ],
        "transient_tool_messages": [
            {
                "role": "tool",
                "name": "read_kb_snippets",
                "tool_call_id": "call-1",
                "content": [
                    {"type": "text", "text": '{"query":"第六题"}'},
                    {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AAAA"}},
                ],
            }
        ],
        "model_messages": [{"role": "system", "content": "[环境前景上下文]"}],
        "runtime_snapshot": {},
        "model_turn": {},
        "step_count": 0,
    }

    cmd = rb._node_decide(state)  # type: ignore[arg-type]

    sent = captured["messages"]
    assert len(sent) == 4
    assert isinstance(sent[3]["content"], list)
    assert sent[3]["content"][1]["type"] == "image_url"
    assert getattr(cmd, "goto", None) == "execute_tools"
