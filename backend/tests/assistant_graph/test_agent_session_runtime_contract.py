from __future__ import annotations

from typing import Any


def test_resolve_session_runtime_context_reuses_session_without_document_binding() -> None:
    from app.agent.assistant_graph.session_runtime import resolve_session_runtime_context
    import app.agent.assistant_graph.session_runtime as runtime_svc

    class _Session:
        id = 77
        thread_id = "agent:1:2:w3:no-doc"
        profile_json = {"continuation_loaded_tools": ["read_kb_evidence"]}
        history_summary = "summary"

    class _Svc:
        def __init__(self, _db: Any) -> None:
            pass

        def get_or_create_session(self, **kwargs: Any) -> Any:
            assert kwargs["session_id"] == 77
            return _Session()

    original = runtime_svc.AgentService
    runtime_svc.AgentService = _Svc  # type: ignore[assignment]
    try:
        out = resolve_session_runtime_context(
            db=object(),  # type: ignore[arg-type]
            tenant_id=1,
            user_id=2,
            workroom_id=3,
            resolved_document_id=None,
            payload_session_id=77,
            is_fresh_turn=True,
            view_id="default",
        )
    finally:
        runtime_svc.AgentService = original  # type: ignore[assignment]

    assert out["session_id"] == 77
    assert out["thread_id"] == "agent:1:2:w3:no-doc"


def test_resolve_run_runtime_context_keeps_no_doc_thread_stable_when_session_exists() -> None:
    from app.agent.assistant_graph.session_runtime import resolve_run_runtime_context
    import app.agent.assistant_graph.session_runtime as runtime_svc

    def _fake_resolve_session_runtime_context(**_kwargs: Any) -> dict[str, Any]:
        return {
            "session_id": 77,
            "thread_id": "agent:1:2:w3:no-doc",
            "session_profile": {"k": "v"},
            "history_summary": "summary",
            "continuation_seed": {"loaded_tools": ["tool_search"]},
        }

    original = runtime_svc.resolve_session_runtime_context
    runtime_svc.resolve_session_runtime_context = _fake_resolve_session_runtime_context  # type: ignore[assignment]
    try:
        out = resolve_run_runtime_context(
            db=object(),  # type: ignore[arg-type]
            tenant_id=1,
            user_id=2,
            workroom_id=3,
            resolved_document_id=None,
            payload_session_id=77,
            is_fresh_turn=True,
            view_id="default",
            unique_thread_fallback=True,
        )
    finally:
        runtime_svc.resolve_session_runtime_context = original  # type: ignore[assignment]

    assert out["session_id"] == 77
    assert out["thread_id"] == "agent:1:2:w3:no-doc"


def test_resolve_session_runtime_context_creates_no_doc_session_on_first_turn() -> None:
    from app.agent.assistant_graph.session_runtime import resolve_session_runtime_context
    import app.agent.assistant_graph.session_runtime as runtime_svc

    class _Session:
        id = 88
        thread_id = "agent:1:2:no-doc:s88"
        profile_json = {}
        history_summary = None

    class _Svc:
        def __init__(self, _db: Any) -> None:
            pass

        def get_or_create_session(self, **kwargs: Any) -> Any:
            assert kwargs["document_id"] is None
            assert kwargs["session_id"] is None
            assert kwargs["view_id"] == "default"
            return _Session()

    original = runtime_svc.AgentService
    runtime_svc.AgentService = _Svc  # type: ignore[assignment]
    try:
        out = resolve_session_runtime_context(
            db=object(),  # type: ignore[arg-type]
            tenant_id=1,
            user_id=2,
            workroom_id=3,
            resolved_document_id=None,
            payload_session_id=None,
            is_fresh_turn=True,
            view_id="default",
        )
    finally:
        runtime_svc.AgentService = original  # type: ignore[assignment]

    assert out["session_id"] == 88
    assert out["thread_id"] == "agent:1:2:no-doc:s88"

