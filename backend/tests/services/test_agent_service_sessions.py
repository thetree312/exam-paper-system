from __future__ import annotations

from typing import Any


def test_get_or_create_session_allows_no_doc_session(monkeypatch: Any) -> None:
    from app.services import agent_service as agent_service_module

    created: dict[str, Any] = {}

    class _FakeSessionModel:
        def __init__(self, **kwargs: Any) -> None:
            created.update(kwargs)
            self.id = 91
            self.thread_id = None
            self.document_id = kwargs.get("document_id")

    class _FakeDB:
        def query(self, *_args: Any, **_kwargs: Any) -> Any:
            raise AssertionError("query should not be used when creating a new session")

        def add(self, _obj: Any) -> None:
            return None

        def flush(self) -> None:
            return None

    original_model = agent_service_module.AgentSession
    monkeypatch.setattr(agent_service_module, "AgentSession", _FakeSessionModel)
    monkeypatch.setattr(
        agent_service_module.AgentService,
        "_ensure_session_thread_id",
        lambda self, session, tenant_id, user_id: session,
    )
    try:
        svc = agent_service_module.AgentService(_FakeDB())  # type: ignore[arg-type]
        session = svc.get_or_create_session(
            tenant_id=1,
            user_id=2,
            workroom_id=3,
            document_id=None,
            view_id="default",
            session_id=None,
        )
    finally:
        monkeypatch.setattr(agent_service_module, "AgentSession", original_model)

    assert session.id == 91
    assert created["document_id"] is None
    assert created["workroom_id"] == 3
    assert created["view_id"] == "default"


def test_agent_session_document_id_is_nullable_for_no_doc_runtime() -> None:
    from app.models import AgentSession

    assert AgentSession.__table__.c.document_id.nullable is True
