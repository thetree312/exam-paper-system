from __future__ import annotations

import uuid
from typing import Any

from ..assistant_graph.loop_budget import new_turn_loop_budget
from ..assistant_graph.state import AgentState, build_default_evidence_state, build_default_session_context, build_default_studio_state


def build_run_thread_id(
    *,
    tenant_id: int,
    user_id: int,
    workroom_id: int,
    studio_document_id: int | None,
    with_suffix: bool,
) -> str:
    doc = studio_document_id or "no-doc"
    if not with_suffix:
        return f"agent:{tenant_id}:{user_id}:w{workroom_id}:{doc}"
    return f"agent:{tenant_id}:{user_id}:w{workroom_id}:{doc}:run-{uuid.uuid4().hex}"


def build_agent_base_state(
    *,
    tenant_id: int,
    user_id: int,
    workroom_id: int,
    ui_context: str,
    session_id: int | None,
    messages: list[dict[str, str]],
    persist_messages: list[dict[str, str]],
    session_state: dict | None,
    history_summary: str | None,
    continuation_seed: dict[str, Any] | None,
    studio_document_id: int | None,
    studio_snapshot: str | None,
    source_file_ids: list[int],
    thread_id: str,
    note_focus: dict | None = None,
    note_context_text: str | None = None,
    include_assistant_reply: bool = False,
    run_id: str | None = None,
) -> AgentState:
    state: AgentState = {
        "tenant_id": tenant_id,
        "user_id": user_id,
        "workroom_id": workroom_id,
        "ui_context": ui_context,
        "session_id": session_id,
        "messages": list(messages),
        "base_messages": list(persist_messages),  # type: ignore[typeddict-item]
        "session_state": session_state or {},
        "history_summary": history_summary,
        "session_memory": (continuation_seed or {}).get("session_memory") or {},
        "studio_document_id": studio_document_id,
        "studio_snapshot": studio_snapshot,
        "source_file_ids": source_file_ids,
        "session_context": build_default_session_context(),
        "tool_results": [],
        "observation_log": [],
        "evidence_state": build_default_evidence_state(),
        "studio_state": build_default_studio_state(),
        "loaded_tools": (continuation_seed or {}).get("loaded_tools") or [],
        "tool_search_history": (continuation_seed or {}).get("tool_search_history") or [],
        "ag_ui_events": [],
        "ag_ui_prompt_events": [],
        "tool_summaries": [],
        "latest_replaced_question": None,
        "run_id": run_id,
        "skip_model": False,
        "thread_id": thread_id,
        "supervisor_directive": None,
        "supervisor_focus_index": None,
        "supervisor_payload": None,
        "solver_reply_outline": None,
        "pending_tool_calls": [],
        "tool_execution_report": None,
        "loop_budget": new_turn_loop_budget(turn_id=f"run-{uuid.uuid4().hex}"),
    }
    state["session_context"] = {
        "session_id": session_id,
        "thread_id": thread_id,
    }
    if note_focus is not None:
        state["note_focus"] = note_focus
    if note_context_text is not None:
        state["note_context_text"] = note_context_text
    if include_assistant_reply:
        state["assistant_reply"] = None
    return state


__all__ = ["build_run_thread_id", "build_agent_base_state"]

