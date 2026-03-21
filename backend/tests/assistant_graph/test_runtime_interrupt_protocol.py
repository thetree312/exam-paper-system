from __future__ import annotations


def test_execute_tool_action_blocks_pseudo_interrupt_tool() -> None:
    from app.agent.assistant_graph.runtime_bootstrap import _execute_tool_action

    realized = _execute_tool_action(
        tool_name="need_human",
        tool_arguments={"prompt": "x", "fields": [{"name": "n", "label": "N", "type": "text"}]},
        context={},
        state_snapshot={},
        call_id="call-test",
    )
    assert isinstance(realized, dict)
    trace = realized["trace"]
    assert str(trace.get("status") or "") == "error"
    content = str(realized["transient_msg"]["content"])
    assert '"error": "protocol_violation"' in content
    assert '"code": "pseudo_interrupt_tool"' in content


def test_decision_tool_schemas_expose_clarification_tool_only() -> None:
    from app.agent.assistant_graph.runtime_bootstrap import _all_decision_tool_schemas

    names = [str(item.get("function", {}).get("name") or "") for item in _all_decision_tool_schemas()]
    assert "need_human" not in names
    assert "request_user_clarification" in names


def test_execute_meta_tool_request_clarification_returns_interrupt_payload() -> None:
    from app.agent.assistant_graph.runtime_bootstrap import _execute_meta_tool

    out = _execute_meta_tool(
        tool_name="request_user_clarification",
        tool_arguments={
            "prompt": "请确认参数",
            "fields": [{"name": "count", "label": "数量", "type": "number", "required": True}],
        },
        state_snapshot={},
    )
    assert isinstance(out, dict)
    assert out.get("error") is None
    intr = out.get("interrupt_request")
    assert isinstance(intr, dict)
    assert intr.get("prompt") == "请确认参数"
    assert isinstance(intr.get("openui"), dict)
    assert isinstance(intr.get("openui_lang"), str) and "root = HitlForm(" in str(intr.get("openui_lang"))

