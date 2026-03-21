from __future__ import annotations


def test_interrupt_reason_codes_are_restricted() -> None:
    from app.agent.assistant_graph.runtime_app import INTERRUPT_REASON_CODES

    assert INTERRUPT_REASON_CODES == {
        "required_missing",
        "unresolved_ambiguity",
        "unresolved_conflict",
        "loop_guard_triggered",
    }


def test_interrupt_user_extracts_nested_clarification() -> None:
    from app.agent.assistant_graph.runtime_nodes import _extract_clarification

    payload = {
        "submit": {
            "clarification": "第六题指的是 2025 全国一卷第六题",
        }
    }

    assert _extract_clarification(payload) == "第六题指的是 2025 全国一卷第六题"
