from __future__ import annotations


def test_compact_short_term_messages_keeps_latest_12_rounds() -> None:
    from app.agent.assistant_graph.router_runtime import compact_short_term_messages

    messages: list[dict[str, str]] = []
    for i in range(15):
        messages.append({"role": "user", "content": f"u{i}"})
        messages.append({"role": "assistant", "content": f"a{i}"})

    kept, summary = compact_short_term_messages(messages, max_rounds=12)

    assert len(kept) == 24
    assert kept[0]["content"] == "u3"
    assert kept[-1]["content"] == "a14"
    assert "u0" in summary


