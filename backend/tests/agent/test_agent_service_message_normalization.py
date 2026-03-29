from __future__ import annotations

from types import SimpleNamespace
from typing import Any


def test_append_messages_accepts_dict_payloads(monkeypatch: Any) -> None:
    from app.agent.services.agent_service import AgentService

    added: list[Any] = []

    class _FakeQuery:
        def filter(self, *args: Any) -> "_FakeQuery":
            return self

        def with_for_update(self) -> "_FakeQuery":
            return self

        def first(self) -> Any:
            return SimpleNamespace(
                id=11,
                tenant_id=2,
                deleted_at=None,
                title=None,
                message_count=0,
                last_message_preview=None,
                updated_at=None,
            )

    class _FakeDB:
        def query(self, model: Any) -> _FakeQuery:
            return _FakeQuery()

        def add(self, item: Any) -> None:
            added.append(item)

        def commit(self) -> None:
            return None

    svc = AgentService(_FakeDB())  # type: ignore[arg-type]
    svc.append_messages(
        tenant_id=2,
        session_id=11,
        messages=[
            {"role": "user", "content": "question", "metadata_json": None},
            {
                "role": "assistant",
                "content": "answer [1]",
                "metadata_json": {"citation_status": "partial", "used_rag_evidence": True},
            },
        ],
    )

    assert len(added) == 2
    assert added[0].role == "user"
    assert added[1].role == "assistant"
    assert added[1].metadata_json["citation_status"] == "partial"
