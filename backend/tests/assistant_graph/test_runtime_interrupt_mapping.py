from __future__ import annotations


class _Interrupt:
    def __init__(self, value: dict, id: str | None = None) -> None:
        self.value = value
        self.id = id


def test_interrupt_to_result_keeps_single_interrupt_payload_contract() -> None:
    from app.agent.assistant_graph.runtime_bootstrap import _CompiledAgentApp

    payload = {
        "interrupt_id": "intr-1",
        "prompt": "need clarification",
        "openui": {"type": "form", "fields": []},
        "openui_lang": 'root = HitlForm("need clarification", "intr-1", [], [])',
    }
    result = _CompiledAgentApp._interrupt_to_result(
        [_Interrupt({"interrupt_payload": payload, "messages": [{"role": "user", "content": "u"}]}, id="i-1")],
        fallback_messages=[],
    )

    assert result["task_phase"] == "awaiting_user"
    assert result["interrupt_payload"]["interrupt_id"] == "intr-1"
    assert result["interrupt_payload"]["openui"]["type"] == "form"
    assert "a2ui_protocol" not in result["interrupt_payload"]
    assert result["ag_ui_events"][0]["action"] == "openui.render"
    assert "openui" in result["ag_ui_events"][0]["payload"]
    assert result["ag_ui_events"][0]["payload"]["response"] == payload["openui_lang"]
    assert "interrupts" not in result["interrupt_payload"]


def test_interrupt_to_result_maps_multiple_interrupts() -> None:
    from app.agent.assistant_graph.runtime_bootstrap import _CompiledAgentApp

    p1 = {
        "interrupt_id": "intr-1",
        "prompt": "first",
        "openui": {"type": "form", "fields": [{"id": "f1"}]},
    }
    p2 = {
        "interrupt_id": "intr-2",
        "prompt": "second",
        "openui": {"type": "form", "fields": [{"id": "f2"}]},
    }
    result = _CompiledAgentApp._interrupt_to_result(
        [
            _Interrupt({"interrupt_payload": p1, "messages": [{"role": "user", "content": "u1"}]}, id="i-1"),
            _Interrupt({"interrupt_payload": p2, "messages": [{"role": "user", "content": "u2"}]}, id="i-2"),
        ],
        fallback_messages=[],
    )

    intr = result["interrupt_payload"]
    assert intr["interrupt_mode"] == "multiple"
    assert intr["primary_interrupt_id"] == "i-1"
    assert len(intr["interrupts"]) == 2
    assert intr["interrupts"][0]["interrupt_id"] == "i-1"
    assert intr["interrupts"][0]["payload"]["prompt"] == "first"
    assert intr["interrupts"][1]["interrupt_id"] == "i-2"
    assert intr["interrupts"][1]["payload"]["prompt"] == "second"
    assert intr["interrupts"][0]["payload"]["openui"]["fields"][0]["id"] == "f1"
    assert intr["prompt"] == "first"


def test_decision_tools_expose_request_user_clarification() -> None:
    from app.agent.assistant_graph.runtime_bootstrap import _all_decision_tool_schemas

    names = [str(item.get("function", {}).get("name") or "") for item in _all_decision_tool_schemas()]
    assert "request_user_clarification" in names
    assert "query_environment_model" in names

