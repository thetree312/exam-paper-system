from __future__ import annotations

from types import SimpleNamespace


def test_sanitize_conversation_messages_strips_empty_assistant_placeholder() -> None:
    from app.agent.assistant_graph.adapters.message_adapter import sanitize_conversation_messages

    result = sanitize_conversation_messages(
        [
            {"role": "user", "content": "question"},
            {"role": "assistant", "content": ""},
        ]
    )

    assert result == [
        {"role": "user", "content": "question"},
    ]


def test_sanitize_conversation_messages_accepts_object_messages() -> None:
    from app.agent.assistant_graph.adapters.message_adapter import sanitize_conversation_messages

    result = sanitize_conversation_messages(
        [
            SimpleNamespace(role="user", content="hello"),
            SimpleNamespace(role="assistant", content=""),
        ]
    )

    assert result == [{"role": "user", "content": "hello"}]
