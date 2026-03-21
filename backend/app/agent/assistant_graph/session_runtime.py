from __future__ import annotations

import uuid
from typing import Any

from fastapi import HTTPException
from sqlalchemy import text

from ..services.agent_service import AgentService

_ALLOWED_CONTINUATION_TOOLS = {
    "tool_search",
    "read_kb_evidence",
    "read_studio_index",
    "read_studio_assets",
    "write_studio_questions",
    "write_studio_focus",
}


def normalize_source_file_ids(values: list[Any] | None) -> list[int]:
    out: list[int] = []
    seen: set[int] = set()
    for value in values or []:
        try:
            candidate = int(value)
        except (TypeError, ValueError):
            continue
        if candidate <= 0 or candidate in seen:
            continue
        seen.add(candidate)
        out.append(candidate)
    return out


def extract_continuation_seed(profile_json: dict[str, Any] | None) -> dict[str, Any]:
    profile_json = profile_json or {}
    loaded_tools = ["tool_search"]
    for name in profile_json.get("continuation_loaded_tools") or []:
        if isinstance(name, str) and name in _ALLOWED_CONTINUATION_TOOLS and name not in loaded_tools:
            loaded_tools.append(name)

    tool_search_history: list[dict[str, Any]] = []
    for item in profile_json.get("continuation_tool_search_history") or []:
        if not isinstance(item, dict):
            continue
        query = str(item.get("query") or "").strip()
        added = [t for t in item.get("added_tools") or [] if isinstance(t, str) and t in _ALLOWED_CONTINUATION_TOOLS]
        if not query:
            continue
        tool_search_history.append({"query": query, "added_tools": added})

    return {
        "session_memory": {},
        "loaded_tools": loaded_tools,
        "tool_search_history": tool_search_history,
    }


def _load_workroom_bound_source_ids(*, db: Any, tenant_id: int, user_id: int, workroom_id: int) -> list[int]:
    rows = db.execute(
        text(
            """
            SELECT file_id
            FROM workroom_source_bindings
            WHERE tenant_id = :tenant_id
              AND user_id = :user_id
              AND workroom_id = :workroom_id
              AND is_active = TRUE
            ORDER BY id DESC
            """
        ),
        {"tenant_id": tenant_id, "user_id": user_id, "workroom_id": workroom_id},
    ).fetchall()
    return normalize_source_file_ids([row[0] for row in rows])


def resolve_source_file_ids(
    *,
    db: Any,
    tenant_id: int,
    user_id: int,
    workroom_id: int,
    explicit_source_ids: list[int] | None,
) -> list[int]:
    explicit = normalize_source_file_ids(explicit_source_ids)
    bound = _load_workroom_bound_source_ids(
        db=db,
        tenant_id=tenant_id,
        user_id=user_id,
        workroom_id=workroom_id,
    )
    if not explicit:
        return bound
    missing = [v for v in explicit if v not in bound]
    if missing:
        raise HTTPException(status_code=409, detail="source_file_ids contains file not bound to workroom")
    return explicit


def resolve_session_runtime_context(
    *,
    db: Any,
    tenant_id: int,
    user_id: int,
    workroom_id: int,
    resolved_document_id: int | None,
    payload_session_id: int | None,
    is_fresh_turn: bool,
    view_id: str,
) -> dict[str, Any]:
    svc = AgentService(db)
    session = svc.get_or_create_session(
        tenant_id=tenant_id,
        user_id=user_id,
        workroom_id=workroom_id,
        document_id=resolved_document_id,
        view_id=view_id,
        session_id=payload_session_id,
    )
    return {
        "session_id": session.id,
        "thread_id": session.thread_id,
        "session_profile": getattr(session, "profile_json", None),
        "history_summary": getattr(session, "history_summary", None),
        "continuation_seed": extract_continuation_seed(getattr(session, "profile_json", None)),
    }


def resolve_run_runtime_context(
    *,
    db: Any,
    tenant_id: int,
    user_id: int,
    workroom_id: int,
    resolved_document_id: int | None,
    payload_session_id: int | None,
    is_fresh_turn: bool,
    view_id: str,
    unique_thread_fallback: bool,
) -> dict[str, Any]:
    out = resolve_session_runtime_context(
        db=db,
        tenant_id=tenant_id,
        user_id=user_id,
        workroom_id=workroom_id,
        resolved_document_id=resolved_document_id,
        payload_session_id=payload_session_id,
        is_fresh_turn=is_fresh_turn,
        view_id=view_id,
    )
    if out.get("thread_id"):
        return out
    doc = resolved_document_id or "no-doc"
    base = f"agent:{tenant_id}:{user_id}:w{workroom_id}:{doc}"
    if unique_thread_fallback:
        base = f"{base}:run-{uuid.uuid4().hex}"
    out["thread_id"] = base
    return out


def resolve_resume_runtime_context(
    *,
    db: Any,
    tenant_id: int,
    user_id: int,
    workroom_id: int,
    payload_thread_id: str | None,
    payload_session_id: int | None,
    studio_document_id: int | None,
) -> dict[str, Any]:
    if payload_session_id is None:
        doc = studio_document_id or "no-doc"
        return {
            "session_id": None,
            "thread_id": payload_thread_id or f"agent:{tenant_id}:{user_id}:w{workroom_id}:{doc}",
            "session_profile": None,
            "history_summary": None,
        }

    svc = AgentService(db)
    session = svc.get_session(tenant_id=tenant_id, session_id=payload_session_id, user_id=user_id)
    session_thread_id = str(getattr(session, "thread_id", "") or "").strip()
    requested_thread_id = str(payload_thread_id or "").strip()
    if requested_thread_id and session_thread_id and requested_thread_id != session_thread_id:
        raise HTTPException(status_code=409, detail="thread_id does not match session thread")
    return {
        "session_id": session.id,
        "thread_id": requested_thread_id or session_thread_id or f"agent:{tenant_id}:{user_id}:w{workroom_id}:{studio_document_id or 'no-doc'}",
        "session_profile": getattr(session, "profile_json", None),
        "history_summary": getattr(session, "history_summary", None),
    }


__all__ = [
    "normalize_source_file_ids",
    "extract_continuation_seed",
    "resolve_source_file_ids",
    "resolve_session_runtime_context",
    "resolve_run_runtime_context",
    "resolve_resume_runtime_context",
]

