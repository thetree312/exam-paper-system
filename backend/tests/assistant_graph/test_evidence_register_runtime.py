from __future__ import annotations

import json
from typing import Any


def test_runtime_bootstrap_decide_uses_evidence_register_when_transient_messages_empty(monkeypatch: Any) -> None:
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
        return ("已读取证据寄存器中的图像。", [], [])

    monkeypatch.setattr(rb, "_invoke_model_action", _fake_invoke_model_action)
    monkeypatch.setattr(rb, "_new_client", lambda: object())
    monkeypatch.setattr(rb, "get_stream_writer", lambda: None)

    state = {
        "context": {"ui_context": "exam_editor"},
        "messages": [
            {"role": "system", "content": "system"},
            {"role": "user", "content": "第六题图例里风速坐标是什么"},
        ],
        "transient_tool_messages": [],
        "evidence_register": [
            {
                "frame_id": "frame-1",
                "tool_name": "read_kb_evidence",
                "tool_call_id": "call-1",
                "query": "第六题图例",
                "source_refs": ["unit:101"],
                "answerability": "answerable",
                "target_resolution": "bound",
                "summary": "已定位到第六题对应页面。",
                "content": [
                    {"type": "text", "text": '{"query":"第六题图例","source_refs":["unit:101"]}'},
                    {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AAAA"}},
                ],
                "created_step": 0,
                "last_selected_step": None,
            }
        ],
        "model_messages": [{"role": "system", "content": "[环境前景上下文]"}],
        "runtime_snapshot": {},
        "model_turn": {},
        "step_count": 1,
    }

    cmd = rb._node_decide(state)  # type: ignore[arg-type]

    sent = captured["messages"]
    evidence_msgs = [msg for msg in sent if msg.get("role") == "tool" and isinstance(msg.get("content"), list)]
    assert evidence_msgs
    assert evidence_msgs[0]["content"][1]["type"] == "image_url"
    assert getattr(cmd, "goto", None) == "execute_tools"


def test_runtime_bootstrap_repeated_kb_calls_keep_history_compact_and_limit_carryforward(monkeypatch: Any) -> None:
    import app.agent.assistant_graph.runtime_bootstrap as rb
    from app.agent.assistant_graph.evidence_register import merge_evidence_register

    captured: dict[str, Any] = {}

    def _fake_invoke_model_action(
        *,
        client: Any,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        stream_writer: Any = None,
    ) -> tuple[str, list[dict[str, Any]], list[str]]:
        captured["messages"] = messages
        return ("继续推理。", [], [])

    monkeypatch.setattr(rb, "_invoke_model_action", _fake_invoke_model_action)
    monkeypatch.setattr(rb, "_new_client", lambda: object())
    monkeypatch.setattr(rb, "get_stream_writer", lambda: None)
    monkeypatch.setattr(
        rb,
        "execute_tool_call",
        lambda name, arguments, context: {
            "feedback": {"status": "ok", "message": "Readable evidence was found."},
            "source_refs": [f"unit:{arguments['query']}"],
            "answerability": "answerable",
            "target_resolution": "bound",
            "model_message_content": [
                {
                    "type": "text",
                    "text": (
                        '{"query":"%s","evidence_objects":[{"kind":"snippet","payload":{"content":"very long"}},'
                        '{"kind":"asset_ref","payload":{"page_no":6}}],"snippets":[{"chunk_id":1,"content":"big blob"}]}'
                        % arguments["query"]
                    ),
                },
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AAAA"}},
            ],
        },
    )

    history_messages: list[dict[str, Any]] = []
    evidence_register: list[dict[str, Any]] = []

    for idx in range(3):
        query = f"第{idx + 1}次检索"
        realized = rb._execute_tool_action(
            tool_name="read_kb_evidence",
            tool_arguments={"query": query, "top_k": 5},
            context={},
            state_snapshot={"step_count": idx},
            call_id=f"call-{idx + 1}",
        )
        if realized is None:
            raise AssertionError("expected realized tool action")
        history_messages.append(realized["history_msg"])
        frame = realized.get("evidence_frame")
        if isinstance(frame, dict):
            evidence_register = merge_evidence_register(evidence_register, [frame])

    state = {
        "context": {"ui_context": "exam_editor"},
        "messages": [
            {"role": "system", "content": "system"},
            {"role": "user", "content": "帮我继续基于已检索证据回答"},
            *history_messages,
        ],
        "transient_tool_messages": [],
        "evidence_register": evidence_register,
        "model_messages": [{"role": "system", "content": "[环境前景上下文]"}],
        "runtime_snapshot": {},
        "model_turn": {},
        "step_count": 4,
    }

    rb._node_decide(state)  # type: ignore[arg-type]

    sent = captured["messages"]
    persisted_tool_msgs = [
        msg for msg in sent if msg.get("role") == "tool" and isinstance(msg.get("content"), list) and len(msg["content"]) == 1
    ]
    carryforward_tool_msgs = [
        msg
        for msg in sent
        if msg.get("role") == "tool"
        and isinstance(msg.get("content"), list)
        and any(isinstance(part, dict) and str(part.get("type") or "") == "image_url" for part in msg["content"])
    ]

    assert len(carryforward_tool_msgs) <= 2
    assert len(persisted_tool_msgs) >= 3
    for msg in persisted_tool_msgs[:3]:
        payload = json.loads(msg["content"][0]["text"])
        assert "source_refs" in payload
        assert "answerability" in payload
        assert "target_resolution" in payload
        assert "evidence_objects" not in msg["content"][0]["text"]
        assert "snippets" not in msg["content"][0]["text"]


def test_runtime_bootstrap_prompt_payload_stays_bounded_after_repeated_heavy_kb_calls(monkeypatch: Any) -> None:
    import json as _json

    import app.agent.assistant_graph.runtime_bootstrap as rb
    from app.agent.assistant_graph.evidence_register import merge_evidence_register

    captured: dict[str, Any] = {}
    heavy_blob = "very long evidence " * 400

    def _fake_invoke_model_action(
        *,
        client: Any,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        stream_writer: Any = None,
    ) -> tuple[str, list[dict[str, Any]], list[str]]:
        captured["messages"] = messages
        captured["payload_text"] = _json.dumps(messages, ensure_ascii=False)
        return ("继续推理。", [], [])

    monkeypatch.setattr(rb, "_invoke_model_action", _fake_invoke_model_action)
    monkeypatch.setattr(rb, "_new_client", lambda: object())
    monkeypatch.setattr(rb, "get_stream_writer", lambda: None)
    monkeypatch.setattr(
        rb,
        "execute_tool_call",
        lambda name, arguments, context: {
            "feedback": {"status": "ok", "message": "Readable evidence was found."},
            "source_refs": [f"unit:{arguments['query']}"],
            "answerability": "answerable",
            "target_resolution": "bound",
            "model_message_content": [
                {
                    "type": "text",
                    "text": _json.dumps(
                        {
                            "query": arguments["query"],
                            "evidence_objects": [{"kind": "snippet", "payload": {"content": heavy_blob}}],
                            "snippets": [{"chunk_id": 1, "content": heavy_blob}],
                        },
                        ensure_ascii=False,
                    ),
                },
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AAAA"}},
            ],
        },
    )

    history_messages: list[dict[str, Any]] = []
    evidence_register: list[dict[str, Any]] = []

    for idx in range(5):
        realized = rb._execute_tool_action(
            tool_name="read_kb_evidence",
            tool_arguments={"query": f"query-{idx + 1}", "top_k": 5},
            context={},
            state_snapshot={"step_count": idx},
            call_id=f"call-{idx + 1}",
        )
        if realized is None:
            raise AssertionError("expected realized tool action")
        history_messages.append(realized["history_msg"])
        frame = realized.get("evidence_frame")
        if isinstance(frame, dict):
            evidence_register = merge_evidence_register(evidence_register, [frame])

    state = {
        "context": {"ui_context": "exam_editor"},
        "messages": [
            {"role": "system", "content": "system"},
            {"role": "user", "content": "继续基于已检索证据回答"},
            *history_messages,
        ],
        "transient_tool_messages": [],
        "evidence_register": evidence_register,
        "model_messages": [{"role": "system", "content": "[环境前景上下文]"}],
        "runtime_snapshot": {},
        "model_turn": {},
        "step_count": 6,
    }

    rb._node_decide(state)  # type: ignore[arg-type]

    payload_text = captured["payload_text"]
    assert payload_text.count(heavy_blob) == 4
    assert payload_text.count('\\"source_refs\\"') >= 5
    assert '\\"snippets\\"' in payload_text
    assert '"snippets"' not in _json.dumps(history_messages, ensure_ascii=False)
