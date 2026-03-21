from __future__ import annotations

from typing import Any


def test_normalize_unique_int_ids() -> None:
    from app.agent.assistant_graph.session_runtime import normalize_source_file_ids

    values = ["1", 2, "2", "x", 0, -1, 3]
    assert normalize_source_file_ids(values) == [1, 2, 3]


def test_extract_continuation_seed_from_session_profile() -> None:
    from app.agent.assistant_graph.session_runtime import extract_continuation_seed

    seed = extract_continuation_seed(
        {
            "continuation_loaded_tools": ["read_kb_evidence", "read_workspace_index", "unknown_tool"],
            "continuation_tool_search_history": [
                {"query": "need kb retrieval", "added_tools": ["read_kb_evidence"]},
                {"query": "need workspace index", "added_tools": ["read_workspace_index"]},
                "invalid",
            ],
        }
    )

    session_memory = seed.get("session_memory") if isinstance(seed, dict) else {}
    assert isinstance(session_memory, dict)
    assert session_memory == {}

    loaded_tools = seed.get("loaded_tools") if isinstance(seed, dict) else []
    assert isinstance(loaded_tools, list)
    assert "tool_search" in loaded_tools
    assert "read_kb_evidence" in loaded_tools
    assert "unknown_tool" not in loaded_tools

    history = seed.get("tool_search_history") if isinstance(seed, dict) else []
    assert isinstance(history, list)
    assert len(history) == 2


class _DummyDB:
    def __init__(self, rows: list[tuple[int]]) -> None:
        self._rows = rows

    class _Result:
        def __init__(self, rows: list[tuple[int]]) -> None:
            self._rows = rows

        def fetchall(self) -> list[tuple[int]]:
            return self._rows

    def execute(self, *_args: Any, **_kwargs: Any) -> "_DummyDB._Result":
        return self._Result(self._rows)


def test_resolve_source_file_ids_prefers_explicit_subset() -> None:
    from app.agent.assistant_graph.session_runtime import resolve_source_file_ids
    from fastapi import HTTPException
    import pytest

    db = _DummyDB([(9,), (8,), (7,), (2,), (5,)])

    with pytest.raises(HTTPException) as ei:
        resolve_source_file_ids(
            db=db,  # type: ignore[arg-type]
            tenant_id=2,
            user_id=2,
            workroom_id=88,
            explicit_source_ids=[2, 3],
        )
    assert ei.value.status_code == 409


def test_resolve_source_file_ids_uses_workroom_binding_when_explicit_missing() -> None:
    from app.agent.assistant_graph.session_runtime import resolve_source_file_ids

    db = _DummyDB([(9,), (8,), (7,), (2,)])
    out = resolve_source_file_ids(
        db=db,  # type: ignore[arg-type]
        tenant_id=2,
        user_id=2,
        workroom_id=88,
        explicit_source_ids=[],
    )
    assert out == [9, 8, 7, 2]


def test_resolve_resume_runtime_context_falls_back_when_no_session() -> None:
    from app.agent.assistant_graph.session_runtime import resolve_resume_runtime_context

    class _Svc:
        def __init__(self, _db: Any) -> None:
            pass

        def get_session(self, **_kwargs: Any) -> Any:
            raise AssertionError("should not call get_session when session_id is None")

    import app.agent.assistant_graph.session_runtime as runtime_svc

    original = runtime_svc.AgentService
    runtime_svc.AgentService = _Svc  # type: ignore[assignment]
    try:
        out = resolve_resume_runtime_context(
            db=object(),  # type: ignore[arg-type]
            tenant_id=1,
            user_id=2,
            workroom_id=3,
            payload_thread_id=None,
            payload_session_id=None,
            studio_document_id=10,
        )
    finally:
        runtime_svc.AgentService = original  # type: ignore[assignment]

    assert out["session_id"] is None
    assert out["thread_id"] == "agent:1:2:w3:10"


def test_resolve_resume_runtime_context_rejects_mismatched_session_thread() -> None:
    from app.agent.assistant_graph.session_runtime import resolve_resume_runtime_context
    from fastapi import HTTPException
    import app.agent.assistant_graph.session_runtime as runtime_svc
    import pytest

    class _Session:
        id = 7
        thread_id = "agent:1:2:w3:10"
        profile_json = {}
        history_summary = None

    class _Svc:
        def __init__(self, _db: Any) -> None:
            pass

        def get_session(self, **_kwargs: Any) -> Any:
            return _Session()

    original = runtime_svc.AgentService
    runtime_svc.AgentService = _Svc  # type: ignore[assignment]
    try:
        with pytest.raises(HTTPException) as ei:
            resolve_resume_runtime_context(
                db=object(),  # type: ignore[arg-type]
                tenant_id=1,
                user_id=2,
                workroom_id=3,
                payload_thread_id="agent:1:2:w3:other",
                payload_session_id=7,
                studio_document_id=10,
            )
    finally:
        runtime_svc.AgentService = original  # type: ignore[assignment]

    assert ei.value.status_code == 409


def test_resolve_resume_runtime_context_uses_session_thread_when_payload_missing() -> None:
    from app.agent.assistant_graph.session_runtime import resolve_resume_runtime_context
    import app.agent.assistant_graph.session_runtime as runtime_svc

    class _Session:
        id = 8
        thread_id = "agent:1:2:w3:10"
        profile_json = {"k": "v"}
        history_summary = "h"

    class _Svc:
        def __init__(self, _db: Any) -> None:
            pass

        def get_session(self, **_kwargs: Any) -> Any:
            return _Session()

    original = runtime_svc.AgentService
    runtime_svc.AgentService = _Svc  # type: ignore[assignment]
    try:
        out = resolve_resume_runtime_context(
            db=object(),  # type: ignore[arg-type]
            tenant_id=1,
            user_id=2,
            workroom_id=3,
            payload_thread_id=None,
            payload_session_id=8,
            studio_document_id=10,
        )
    finally:
        runtime_svc.AgentService = original  # type: ignore[assignment]

    assert out["session_id"] == 8
    assert out["thread_id"] == "agent:1:2:w3:10"


def test_build_agent_base_state_contains_required_runtime_fields() -> None:
    from app.agent.services.agent_invocation_service import build_agent_base_state

    state = build_agent_base_state(
        tenant_id=1,
        user_id=2,
        workroom_id=3,
        ui_context="blank",
        session_id=11,
        messages=[{"role": "user", "content": "hi"}],
        persist_messages=[{"role": "user", "content": "hi"}, {"role": "assistant", "content": ""}],
        session_state={"k": "v"},
        history_summary="h",
        continuation_seed={"loaded_tools": ["tool_search"], "tool_search_history": []},
        studio_document_id=10,
        workspace_snapshot=None,
        source_file_ids=[101],
        thread_id="agent:1:2:w3:10",
        include_assistant_reply=True,
        run_id="run-x",
    )

    assert state["tenant_id"] == 1
    assert state["session_id"] == 11
    assert state["thread_id"] == "agent:1:2:w3:10"
    assert state["run_id"] == "run-x"
    assert isinstance(state.get("loop_budget"), dict)
    assert state["loop_budget"]["steps_taken"] == 0
    assert state["loop_budget"]["tool_calls"] == 0
    assert state["loop_budget"]["repeated_calls"] == 0
    assert state["session_context"] == {"session_id": 11, "thread_id": "agent:1:2:w3:10"}
    assert state["tool_results"] == []
    assert state["observation_log"] == []
    assert state.get("assistant_reply") is None
    assert state["source_file_ids"] == [101]


def test_resolve_run_runtime_context_unique_thread_fallback() -> None:
    from app.agent.assistant_graph.session_runtime import resolve_run_runtime_context
    import app.agent.assistant_graph.session_runtime as runtime_svc

    def _fake_resolve_session_runtime_context(**_kwargs: Any) -> dict[str, Any]:
        return {
            "session_id": None,
            "thread_id": None,
            "session_profile": None,
            "history_summary": None,
            "continuation_seed": {},
        }

    original = runtime_svc.resolve_session_runtime_context
    runtime_svc.resolve_session_runtime_context = _fake_resolve_session_runtime_context  # type: ignore[assignment]
    try:
        out = resolve_run_runtime_context(
            db=object(),  # type: ignore[arg-type]
            tenant_id=1,
            user_id=2,
            workroom_id=3,
            resolved_document_id=10,
            payload_session_id=None,
            is_fresh_turn=True,
            view_id="default",
            unique_thread_fallback=True,
        )
    finally:
        runtime_svc.resolve_session_runtime_context = original  # type: ignore[assignment]

    assert out["thread_id"].startswith("agent:1:2:w3:10:run-")


def test_resolve_run_runtime_context_reuses_existing_session_thread_on_fresh_turn() -> None:
    from app.agent.assistant_graph.session_runtime import resolve_run_runtime_context
    import app.agent.assistant_graph.session_runtime as runtime_svc

    def _fake_resolve_session_runtime_context(**_kwargs: Any) -> dict[str, Any]:
        return {
            "session_id": 42,
            "thread_id": "agent:1:2:w3:10",
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
            resolved_document_id=10,
            payload_session_id=42,
            is_fresh_turn=True,
            view_id="default",
            unique_thread_fallback=True,
        )
    finally:
        runtime_svc.resolve_session_runtime_context = original  # type: ignore[assignment]

    assert out["session_id"] == 42
    assert out["thread_id"] == "agent:1:2:w3:10"


def test_resolve_session_runtime_context_keeps_existing_session_on_fresh_turn() -> None:
    from app.agent.assistant_graph.session_runtime import resolve_session_runtime_context
    import app.agent.assistant_graph.session_runtime as runtime_svc

    class _Session:
        id = 42
        thread_id = "agent:1:2:w3:10"
        profile_json = {"k": "v"}
        history_summary = "summary"

    class _Svc:
        def __init__(self, _db: Any) -> None:
            pass

        def get_or_create_session(self, **kwargs: Any) -> Any:
            assert kwargs["session_id"] == 42
            return _Session()

    original = runtime_svc.AgentService
    runtime_svc.AgentService = _Svc  # type: ignore[assignment]
    try:
        out = resolve_session_runtime_context(
            db=object(),  # type: ignore[arg-type]
            tenant_id=1,
            user_id=2,
            workroom_id=3,
            resolved_document_id=10,
            payload_session_id=42,
            is_fresh_turn=True,
            view_id="default",
        )
    finally:
        runtime_svc.AgentService = original  # type: ignore[assignment]

    assert out["session_id"] == 42
    assert out["thread_id"] == "agent:1:2:w3:10"


