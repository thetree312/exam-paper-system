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


def _limit_text(text: str, limit: int = 400) -> str:
    trimmed = (text or "").strip()
    if len(trimmed) <= limit:
        return trimmed
    return trimmed[:limit].rstrip() + "…"


def _normalize_role(raw_role: str | None) -> str | None:
    if not raw_role:
        return None
    role = raw_role.lower()
    if role == "human":
        return "user"
    if role in ("ai", "assistant"):
        return "assistant"
    return role


def _extract_role_content(msg: "AgentMessageEntry" | object) -> tuple[str | None, str]:
    if isinstance(msg, dict):
        role = _normalize_role(msg.get("role"))
        content = msg.get("content") or ""
        return role, str(content)
    role_attr = getattr(msg, "type", None) or getattr(msg, "role", None)
    role = _normalize_role(role_attr) if isinstance(role_attr, str) else None
    content = getattr(msg, "content", "") or ""
    return role, str(content)


class AgentMessageEntry(TypedDict):
    role: Literal["system", "user", "assistant"]
    content: str


def _student_answer_snapshot(question_contexts: list | None) -> str:
    if not question_contexts:
        return ""
    lines: List[str] = []
    for ctx in question_contexts:
        if not isinstance(ctx, dict):
            continue
        answer = ctx.get("student_answer")
        if not answer:
            continue
        label = ctx.get("display_index") or ctx.get("sequence_index")
        label_text = f"题目#{label}" if label is not None else "题目"
        lines.append(f"{label_text}：{_limit_text(str(answer), 160)}")
        if len(lines) >= 3:
            break
    return "\n".join(lines)


TASK_TAG_SYNONYMS: dict[str, set[str]] = {
    "explain": {"explain", "讲解", "解析", "解题", "说明", "拆解", "分析", "讲述"},
    "practice": {"practice", "练习", "出题", "类似题", "巩固", "再来几题", "练练"},
    "grading": {"grading", "批改", "评分", "判卷", "订正", "评估"},
    "needs_confirmation": {"needs_confirmation", "追问", "确认", "提问", "澄清"},
}


def _normalize_skill_tags(raw_tags: List[str] | None) -> set[str]:
    normalized: set[str] = set()
    if not raw_tags:
        return normalized
    for tag in raw_tags:
        if not tag:
            continue
        tag_str = str(tag).strip().lower()
        matched = False
        for canonical, synonyms in TASK_TAG_SYNONYMS.items():
            if tag_str == canonical or tag_str in synonyms:
                normalized.add(canonical)
                matched = True
                break
        if not matched:
            normalized.add(tag_str)
    return normalized


def _build_default_intent(raw: dict | None) -> dict:
    base = {
        "task_type": ["explain"],
        "needs_practice": False,
        "needs_grading": False,
        "needs_followup": False,
        "primary_questions": [],
        "notes": "",
    }
    if not isinstance(raw, dict):
        return base
    allowed = {"task_type", "needs_practice", "needs_grading", "needs_followup", "primary_questions", "notes"}
    for key in allowed:
        if key in raw and raw[key] is not None:
            base[key] = raw[key]
    whitelist = {"explain", "practice", "grading", "review", "summarize"}
    task_types = base.get("task_type")
    normalized: list[str] = []
    if isinstance(task_types, list):
        for item in task_types:
            item_str = str(item).strip().lower()
            if item_str in whitelist:
                normalized.append(item_str)
    if not normalized:
        normalized = ["explain"]
    base["task_type"] = normalized
    return base


class AgentState(TypedDict, total=False):
    tenant_id: int
    user_id: int
    ui_context: str
    preferred_language: str | None
    session_id: int | None
    messages: Annotated[List[AgentMessageEntry], _append_messages]
    base_messages: List[AgentMessageEntry]
    session_profile: dict | None
    dialogue_window: List[AgentMessageEntry]
    session_state: dict | None
    session_state_patch: dict | None
    history_summary: str | None
    document_id: int | None
    document_title: str | None
    snapshot_questions: list
    question_index_map: dict
    question_contexts: list
    vision_focus_questions: list
    ag_ui_events: Annotated[list, _append_events]
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
    batch_config_epoch: int | None
    supervisor_expected_new_questions: int | None
    tool_error: str | None
    tool_error_detail: str | None
    tool_retry_count: int | None
    solver_tool_feedback_count: int | None
    solver_tool_feedback_reason: str | None
    assistant_reply: str | None
    enable_batch_config_skill: bool | None
    supervisor_allow_tools: bool | None
    active_skills: List[str]
    task_intent: dict
    doc_context: str | None
    solver_context_bundle: dict | None
    solver_context_fingerprint: str | None
    solver_context_sections: dict | None
    retrieved_snippets: List[str]
    rag_enabled: bool | None
    token_usage_events: Annotated[list, _append_events]
    request_total_tokens: int | None

__all__ = [
    "AgentMessageEntry",
    "AgentState",
    "TASK_TAG_SYNONYMS",
    "_append_events",
    "_append_messages",
    "_append_strings",
    "_build_default_intent",
    "_extract_role_content",
    "_limit_text",
    "_normalize_role",
    "_normalize_skill_tags",
    "_student_answer_snapshot",
]
