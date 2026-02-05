from __future__ import annotations

from typing import Annotated, List, Literal, TypedDict


def _append_events(existing: list | None, new_items: list | None) -> list:
    acc = list(existing or [])
    if new_items:
        acc.extend(new_items)
    return acc


def _append_strings(existing: List[str] | None, new_items: List[str] | None) -> List[str]:
    acc = list(existing or [])
    if new_items:
        acc.extend(new_items)
    return acc


def _append_messages(existing: List["AgentMessageEntry"] | None, new_items: List["AgentMessageEntry"] | None) -> List["AgentMessageEntry"]:
    acc = list(existing or [])
    if new_items:
        acc.extend(new_items)
    return acc


class AgentMessageEntry(TypedDict):
    role: Literal["system", "user", "assistant"]
    content: str


class AgentState(TypedDict, total=False):
    tenant_id: int
    user_id: int
    ui_context: str
    session_id: int | None
    messages: Annotated[List[AgentMessageEntry], _append_messages]
    base_messages: List[AgentMessageEntry]
    session_profile: dict | None
    dialogue_window: List[AgentMessageEntry]
    session_state: dict | None
    session_state_patch: dict | None
    session_anchors: List[dict] | None
    active_entities: List[str] | None
    history_summary: str | None
    document_id: int | None
    document_title: str | None
    snapshot_questions: list
    question_index_map: dict
    question_contexts: list
    vision_focus_questions: list
    ag_ui_events: Annotated[list, _append_events]
    ag_ui_prompt_events: list
    tool_summaries: Annotated[List[str], _append_strings]
    latest_replaced_question: dict | None
    run_id: str | None
    skip_model: bool
    thread_id: str | None
    supervisor_directive: str | None
    supervisor_focus_index: int | None
    supervisor_payload: dict | None
    supervisor_focus_question_id: int | None
    solver_reply_outline: str | None
    pending_tool_calls: List[dict]
    tool_execution_report: str | None
    supervisor_tool_request: dict | None
    vision_summary: str | None
    note_focus: dict | None
    note_context_text: str | None
    batch_config: dict | None
    batch_config_required: bool | None
    batch_config_missing_fields: List[str] | None
    batch_config_reason: str | None
    supervisor_expected_new_questions: int | None
    tool_error: str | None
    tool_error_detail: str | None
    tool_retry_count: int | None
    assistant_reply: str | None
    enable_batch_config_skill: bool | None
    active_skills: List[str]
    task_intent: dict
    doc_context: str | None
    retrieved_snippets: List[str]
    rag_enabled: bool | None


__all__ = [
    "AgentMessageEntry",
    "AgentState",
    "_append_events",
    "_append_strings",
    "_append_messages",
]
