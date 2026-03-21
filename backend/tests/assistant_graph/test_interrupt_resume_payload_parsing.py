from __future__ import annotations


def test_extract_clarification_accepts_nested_payload() -> None:
    from app.agent.assistant_graph.runtime_nodes import _extract_clarification

    payload = {
        "form": {
            "fields": {
                "clarification": "是 2025年高考全国一卷数学真题 第六题图例",
            }
        }
    }
    assert _extract_clarification(payload) == "是 2025年高考全国一卷数学真题 第六题图例"


def test_extract_clarification_accepts_plain_string() -> None:
    from app.agent.assistant_graph.runtime_nodes import _extract_clarification

    assert _extract_clarification("补充：看第六题图例") == "补充：看第六题图例"
