from __future__ import annotations

from types import SimpleNamespace
from typing import Any


def test_persist_agent_messages_attaches_final_answer_citations(monkeypatch: Any) -> None:
    from app.agent.assistant_graph import router_runtime as module

    captured: dict[str, Any] = {}

    class _FakeAgentService:
        def __init__(self, _db: Any) -> None:
            return None

        def list_messages(self, *, tenant_id: int, session_id: int, limit: int = 10) -> list[Any]:
            existing = captured.get("stored")
            if existing is not None:
                return existing
            return []

        def append_messages(self, *, tenant_id: int, session_id: int, messages: list[dict[str, Any]]) -> None:
            captured["appended"] = messages
            captured["stored"] = [
                SimpleNamespace(
                    id=index + 1,
                    role=item["role"],
                    content=item["content"],
                    metadata_json=item.get("metadata_json"),
                )
                for index, item in enumerate(messages)
            ]

    monkeypatch.setattr(module, "AgentService", _FakeAgentService)

    module.persist_agent_messages(
        db=object(),
        tenant_id=2,
        user_id=3,
        session_id=11,
        result_messages=[
            {"role": "user", "content": "第六题图例的视风风速的坐标是什么？"},
            {"role": "assistant", "content": "向量坐标是 (3,1)。[1][2]"},
        ],
        final_answer_payload={
            "answer_text": "向量坐标是 (3,1)。[1][2]",
            "used_rag_evidence": True,
            "citation_status": "partial",
            "citations": [
                {
                    "citation_id": "cite:1",
                    "citation_index": 1,
                    "source_ref": "unit:193",
                    "file_id": 1077,
                    "page_no": 2,
                }
            ],
        },
    )

    appended = captured["appended"]
    assert appended[0] == {
        "role": "user",
        "content": "第六题图例的视风风速的坐标是什么？",
        "metadata_json": None,
    }
    assert appended[1]["role"] == "assistant"
    assert appended[1]["metadata_json"]["citation_status"] == "partial"
    assert appended[1]["metadata_json"]["used_rag_evidence"] is True
    assert appended[1]["metadata_json"]["citations"][0]["citation_id"] == "cite:1"


def test_get_agent_session_messages_returns_citation_metadata(monkeypatch: Any) -> None:
    from app.agent import router as module

    class _FakeAgentService:
        def __init__(self, _db: Any) -> None:
            return None

        def get_session(self, *, tenant_id: int, session_id: int, user_id: int | None = None) -> Any:
            return SimpleNamespace(id=session_id)

        def list_messages(self, *, tenant_id: int, session_id: int, limit: int = 10) -> list[Any]:
            return [
                SimpleNamespace(
                    id=1,
                    role="assistant",
                    content="向量坐标是 (3,1)。[1]",
                    created_at="2026-03-29T13:04:58",
                    metadata_json={
                        "citation_status": "complete",
                        "used_rag_evidence": True,
                        "citations": [
                            {
                                "citation_id": "cite:1",
                                "citation_index": 1,
                                "source_ref": "unit:193",
                                "file_id": 1077,
                                "page_no": 2,
                            }
                        ],
                    },
                )
            ]

    monkeypatch.setattr(module, "AgentService", _FakeAgentService)

    result = module.get_agent_session_messages(
        session_id=8,
        tenant_id=2,
        user_id=3,
        limit=50,
        db=object(),
    )

    assert result.messages[0].citation_status == "complete"
    assert result.messages[0].used_rag_evidence is True
    assert result.messages[0].citations[0].citation_id == "cite:1"
