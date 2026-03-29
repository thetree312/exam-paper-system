import atexit
import json
import logging
import queue
import re
import threading
import time
from datetime import datetime
from typing import Any, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import SessionLocal, get_db
from .assistant_graph.adapters.message_adapter import (
    from_state_messages,
    is_fresh_conversation,
    sanitize_conversation_messages,
    to_state_messages,
    visible_conversation_messages,
)
from .final_answer_citations import build_final_answer_payload
from .assistant_graph.runtime_bootstrap import get_compiled_agent_app
from ..config import get_settings
from .services.agent_invocation_service import build_run_thread_id
from .assistant_graph.session_runtime import (
    resolve_resume_runtime_context,
    resolve_run_runtime_context,
    resolve_source_file_ids,
)
from .assistant_graph.router_runtime import (
    StreamTraceReducer,
    build_agent_router_context,
    build_environment_state,
    iter_stream_trace_events,
    normalize_stream_event,
    persist_agent_messages,
)
from .services.agent_service import AgentService
from ..services.qwen_client import QwenClient
from ..services.workroom.service import WorkroomService
from ..services.workroom_scope_service import assert_workroom_scope, assert_studio_document_scope
from ..models import AgentSession, AgentMessage
from ..utils.rate_limiter import rate_limit

logger = logging.getLogger("agent.router")


router = APIRouter(prefix="/api/agent", tags=["agent_v2"])
settings = get_settings()
agent_run_limit = rate_limit("agent-run", limit=30, window_seconds=60)
agent_stream_limit = rate_limit("agent-run-stream", limit=30, window_seconds=60)
agent_resume_limit = rate_limit("agent-run-resume", limit=30, window_seconds=60)
grade_limit = rate_limit("agent-grade", limit=10, window_seconds=60)
split_limit = rate_limit("agent-split", limit=10, window_seconds=60)
sync_limit = rate_limit("agent-sync", limit=60, window_seconds=60)
snapshot_limit = rate_limit("agent-snapshot", limit=60, window_seconds=60)


def _extract_final_reply(messages: list[dict[str, Any]] | None) -> str:
    visible = visible_conversation_messages(messages or [])
    for item in reversed(visible):
        if str(item.get("role") or "").strip().lower() != "assistant":
            continue
        text = str(item.get("content") or "").strip()
        if text:
            return text
    return ""


def _resolve_final_answer_payload(result: dict[str, Any]) -> dict[str, Any] | None:
    existing = result.get("final_answer_payload")
    if isinstance(existing, dict):
        return existing
    final_reply = _extract_final_reply(result.get("conversation_messages") or result.get("messages"))
    return build_final_answer_payload(final_reply, list(result.get("tool_results") or []))

class AgentMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str


class NoteFocusPayload(BaseModel):
    studio_document_id: Optional[int] = None
    file_id: Optional[int] = None
    block_index: Optional[int] = None
    snippet: Optional[str] = None
    title: Optional[str] = None


class AgentRunRequest(BaseModel):
    tenant_id: int
    user_id: int
    workroom_id: int
    ui_context: Literal["blank", "exam_editor", "code_editor", "other", "batch_question"] = "blank"
    studio_document_id: int | None = None
    studio_snapshot: str | None = None
    source_file_ids: List[int] = Field(default_factory=list)
    messages: List[AgentMessage]
    note_focus: Optional[NoteFocusPayload] = None
    view_id: Optional[str] = None
    session_id: Optional[int] = None
    agent_max_steps: Optional[int] = None


class AgentResumeRequest(BaseModel):
    """Resume execution from a LangGraph interrupt checkpoint."""

    tenant_id: int
    user_id: int
    workroom_id: int
    ui_context: Literal["blank", "exam_editor", "code_editor", "other", "batch_question"] = "blank"
    studio_document_id: int | None = None
    session_id: Optional[int] = None
    thread_id: Optional[str] = None
    resume_payload: Any
    agent_max_steps: Optional[int] = None


class AgentRunResponse(BaseModel):
    session_id: Optional[int] = None
    messages: List[AgentMessage]
    halt_reason: Optional[str] = None
    interrupt_payload: Optional[dict] = None
    ag_ui_events: List[dict] = Field(default_factory=list)
    final_answer_payload: Optional[dict[str, Any]] = None


class AgentSessionMeta(BaseModel):
    id: int
    tenant_id: int
    user_id: int
    studio_document_id: int | None = None
    view_id: str | None = None
    title: Optional[str] = None
    last_message_preview: Optional[str] = None
    message_count: int
    status: str
    archived: bool
    created_at: datetime
    updated_at: datetime


class AgentSessionListResponse(BaseModel):
    sessions: List[AgentSessionMeta]


class AgentSessionUpdateRequest(BaseModel):
    tenant_id: int
    user_id: int
    title: Optional[str] = None
    archived: Optional[bool] = None
    status: Optional[str] = None


class AgentCitationAnchor(BaseModel):
    citation_id: str
    citation_index: int
    source_ref: str
    anchor_type: Optional[str] = None
    file_id: int
    page_no: int
    unit_key: Optional[str] = None
    chunk_id: Optional[int] = None
    chunk_type: Optional[str] = None
    title: Optional[str] = None
    excerpt: Optional[str] = None
    asset_kind: Optional[str] = None
    asset_ref: Optional[str] = None
    preview_url: Optional[str] = None
    bbox_norm: Optional[dict[str, Any]] = None
    bbox_abs: Optional[dict[str, Any]] = None


class AgentHistoryMessage(BaseModel):
    id: int
    role: Literal["system", "user", "assistant", "tool"]
    content: str
    created_at: datetime
    citations: List[AgentCitationAnchor] = Field(default_factory=list)
    citation_status: Optional[str] = None
    used_rag_evidence: bool = False


class AgentSessionMessagesResponse(BaseModel):
    session_id: int
    messages: List[AgentHistoryMessage]


class GradeQuestionPayload(BaseModel):
    sequence_index: int
    content: str
    user_answer: str | None = None
    legend_images: List[str] | None = None
    page: int | None = None
    file_name: str | None = None


class GradeRunRequest(BaseModel):
    tenant_id: int
    user_id: int
    workroom_id: int
    studio_document_id: int | None = None
    title: str | None = None
    questions: List[GradeQuestionPayload]


class GradeQuestionResult(BaseModel):
    sequence_index: int
    judgement: Literal["correct", "incorrect", "skipped", "uncertain", "error"]
    predicted_answer: Optional[str] = None
    reasoning: Optional[str] = None
    confidence: Optional[float] = None
    raw_response: Optional[str] = None
    error: Optional[str] = None


class GradeRunResponse(BaseModel):
    results: List[GradeQuestionResult]


class SnapshotRequest(BaseModel):
    tenant_id: int
    user_id: int
    workroom_id: int
    studio_document_id: int


class SplitQuestionsRequest(BaseModel):
    tenant_id: int
    user_id: int
    text: str
    max_questions: int | None = 20


class SplitQuestionItem(BaseModel):
    index: int
    text: str


class SplitQuestionsResponse(BaseModel):
    questions: List[SplitQuestionItem]


class DeleteQuestionRequest(BaseModel):
    tenant_id: int
    user_id: int
    workroom_id: int
    studio_document_id: int
    question_id: int

def _log_messages_preview(tag: str, messages: List[dict]) -> None:
    preview: List[dict] = []
    for m in messages:
        role = m.get("role")
        content = str(m.get("content", ""))
        preview.append({"role": role, "content": content[:200]})
    logger.info("%s messages_preview=%s", tag, preview)


def _compute_incremental_visible_messages(
    *,
    db: Session,
    tenant_id: int,
    session_id: int | None,
    sanitized_messages: List[dict[str, str]],
) -> List[dict[str, str]]:
    if session_id is None:
        return list(sanitized_messages)

    svc = AgentService(db)
    existing_rows = svc.list_messages(tenant_id=tenant_id, session_id=session_id, limit=5000)
    existing_rows = sorted(existing_rows, key=lambda m: m.id)
    existing_visible: list[tuple[str, str]] = [
        (str(row.role or "").lower().strip(), str(row.content or ""))
        for row in existing_rows
        if str(row.role or "").lower().strip() in ("user", "assistant")
    ]
    current_visible = [
        (str(item.get("role") or "").lower().strip(), str(item.get("content") or ""))
        for item in sanitized_messages
        if str(item.get("role") or "").lower().strip() in ("user", "assistant")
    ]
    if not existing_visible:
        return list(sanitized_messages)
    if len(current_visible) >= len(existing_visible) and current_visible[: len(existing_visible)] == existing_visible:
        append_batch = current_visible[len(existing_visible) :]
    elif len(existing_visible) >= len(current_visible) and existing_visible[-len(current_visible) :] == current_visible:
        append_batch = []
    else:
        max_overlap = min(len(existing_visible), len(current_visible))
        overlap = 0
        for size in range(max_overlap, 0, -1):
            if existing_visible[-size:] == current_visible[:size]:
                overlap = size
                break
        append_batch = current_visible[overlap:]
    return [{"role": role, "content": content} for role, content in append_batch]


def _build_note_focus_state(note_focus: NoteFocusPayload | None) -> dict[str, Any] | None:
    if note_focus is None:
        return None
    payload = note_focus.model_dump(exclude_none=True)
    return payload or None


def _load_agent_environment_state(
    *,
    db: Session,
    tenant_id: int,
    user_id: int,
    workroom_id: int,
    ui_context: str,
    studio_document_id: int | None,
    note_focus: dict[str, Any] | None = None,
) -> dict[str, Any]:
    svc = WorkroomService(db)
    workroom = svc.get_workroom(tenant_id=tenant_id, user_id=user_id, workroom_id=workroom_id) or {"id": workroom_id}
    runtime_state = svc.repo.get_runtime_state(
        tenant_id=tenant_id,
        user_id=user_id,
        workroom_id=workroom_id,
    ) or {}
    sources = svc.list_sources(
        tenant_id=tenant_id,
        user_id=user_id,
        workroom_id=workroom_id,
    )
    artifacts = svc.repo.list_artifacts(
        tenant_id=tenant_id,
        user_id=user_id,
        workroom_id=workroom_id,
    )
    return build_environment_state(
        workroom=workroom,
        runtime_state=runtime_state,
        sources=sources,
        artifacts=artifacts,
        ui_context=ui_context,
        studio_document_id=studio_document_id,
        note_focus=note_focus,
    )


_DATA_URL_LOG_RE = re.compile(r"^(data:[^;]+;base64,)([A-Za-z0-9+/=\s]+)$", re.IGNORECASE)


def _sanitize_log_value(value: Any, *, max_len: int = 1200) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        raw = value.strip()
        matched = _DATA_URL_LOG_RE.match(raw)
        if matched:
            prefix, payload = matched.group(1), matched.group(2)
            compact = re.sub(r"\s+", "", payload)
            head = compact[:24]
            return f"{prefix}{head}...[base64_len={len(compact)}]"
        if len(raw) <= max_len:
            return raw
        return raw[:max_len] + f"...[truncated {len(raw) - max_len} chars]"
    if isinstance(value, dict):
        return {str(k): _sanitize_log_value(v, max_len=max_len) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_sanitize_log_value(v, max_len=max_len) for v in value]
    return _sanitize_log_value(str(value), max_len=max_len)


_QUESTION_REF_PATTERNS = [
    re.compile(r"@题目(\d+)", re.IGNORECASE),
    re.compile(r"题目\s*#\s*(\d+)", re.IGNORECASE),
    re.compile(r"第\s*(\d+)\s*(?:题目|题|道|问)"),
]
_QUESTION_RANGE_PATTERN = re.compile(
    r"第\s*([0-9一二三四五六七八九十百零〇两、，,.-－—~～至到]+)\s*(?:题目|题|道|问)",
    re.IGNORECASE,
)
_FULLWIDTH_DIGIT_TRANS = str.maketrans({ord("０") + i: str(i) for i in range(10)})
_CHINESE_DIGITS = {
    "零": 0,
    "〇": 0,
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
}
_CHINESE_UNITS = {"十": 10, "百": 100, "千": 1000}


_app = get_compiled_agent_app()


def _extract_question_numbers(text: str | None) -> List[int]:
    if not text:
        return []
    normalized_text = text.translate(_FULLWIDTH_DIGIT_TRANS)
    found: set[int] = set()
    for pattern in _QUESTION_REF_PATTERNS:
        for match in pattern.findall(normalized_text):
            try:
                num = int(match)
            except (TypeError, ValueError):
                continue
            if num > 0:
                found.add(num)
    for match in _QUESTION_RANGE_PATTERN.finditer(normalized_text):
        chunk = match.group(1)
        for num in _parse_question_chunk(chunk):
            if num > 0:
                found.add(num)
    return sorted(found)


def _parse_question_chunk(chunk: str | None) -> List[int]:
    if not chunk:
        return []
    text = chunk.replace("、", ",").replace("，", ",")
    text = re.sub(r"\s+", "", text)
    text = re.sub(r"[～~－—–−至到]+", "-", text)
    tokens = [tok for tok in text.split(",") if tok]
    numbers: list[int] = []
    for token in tokens:
        if "-" in token:
            parts = [p for p in token.split("-") if p]
            if len(parts) != 2:
                continue
            start = _parse_single_question_number(parts[0])
            end = _parse_single_question_number(parts[1])
            if start is None or end is None:
                continue
            low, high = sorted((start, end))
            numbers.extend(range(low, high + 1))
            continue
        num = _parse_single_question_number(token)
        if num is not None:
            numbers.append(num)
    return numbers


def _parse_single_question_number(token: str | None) -> int | None:
    if token is None:
        return None
    stripped = token.strip()
    if not stripped:
        return None
    if stripped.isdigit():
        value = int(stripped)
        return value if value > 0 else None
    try:
        value = int(stripped)
        return value if value > 0 else None
    except (TypeError, ValueError):
        pass
    value = _chinese_numeral_to_int(stripped)
    if value is None or value <= 0:
        return None
    return value


def _chinese_numeral_to_int(token: str) -> int | None:
    if not token:
        return None
    total = 0
    current = 0
    for char in token:
        if char in _CHINESE_DIGITS:
            current = _CHINESE_DIGITS[char]
        elif char in _CHINESE_UNITS:
            unit_val = _CHINESE_UNITS[char]
            if current == 0:
                current = 1
            total += current * unit_val
            current = 0
        else:
            return None
    return total + current


def _collect_question_contexts(
    *,
    svc: AgentService,
    tenant_id: int,
    studio_document_id: int,
    question_numbers: List[int],
    question_index_map: dict,
) -> tuple[list[dict], list[dict]]:
    if not question_numbers or not studio_document_id:
        return [], []

    display_to_id = question_index_map.get("display_to_id") or {}
    contexts: list[dict] = []
    vision_candidates: list[dict] = []
    fetched_ids: set[int] = set()
    for display_num in question_numbers:
        question_id = display_to_id.get(display_num)
        if not question_id or question_id in fetched_ids:
            continue
        try:
            raw = svc.get_question_context(
                tenant_id=tenant_id,
                document_id=studio_document_id,
                question_id=question_id,
            )
        except HTTPException as exc:
            logger.warning(
                "question_context.fetch_failed tenant=%s studio_document=%s question_id=%s detail=%s",
                tenant_id,
                studio_document_id,
                question_id,
                getattr(exc, "detail", None),
            )
            continue
        fetched_ids.add(question_id)

        # 将题目上下文收缩为轻量快照，避免将冗长题干/解析反复灌入 LLM。
        if not isinstance(raw, dict):
            continue

        content = (raw.get("content") or "").strip()
        # 题干在此处做一次保守截断，后续 _build_doc_context 会再次控制展示长度。
        if len(content) > 800:
            content = content[:800]

        ctx: dict = {
            "question_id": raw.get("question_id") or raw.get("id") or question_id,
            "sequence_index": raw.get("sequence_index"),
            "display_index": display_num,
            "page": raw.get("page"),
            "content": content,
            "student_answer": raw.get("student_answer"),
            "grading": raw.get("grading"),
            "has_vision_asset": raw.get("has_vision_asset"),
            # legend_images 供 vision_node 使用，保持原样透传
            "legend_images": raw.get("legend_images"),
        }

        contexts.append(ctx)
        if ctx.get("has_vision_asset"):
            vision_candidates.append(ctx)
    return contexts, vision_candidates

_CONCLUSION_RE = re.compile(
    r"最终结论：\s*正确答案是\s*(?P<correct>[^，,。；;]+)\s*[，,]\s*学生答案是\s*(?P<student>[^，,。；;]+)\s*[，,]\s*判定为\s*(?P<verdict>正确|错误|无法确定)\s*(?:。|\.|$)"
)


def _extract_final_conclusion(reasoning: Optional[str]) -> dict | None:
    if not reasoning:
        return None
    lines = [line.strip() for line in reasoning.splitlines() if line.strip()]
    if not lines:
        return None
    last_line = lines[-1]
    match = _CONCLUSION_RE.search(last_line)
    if not match:
        return None
    verdict_text = match.group("verdict")
    judgement_map = {
        "正确": "correct",
        "错误": "incorrect",
        "无法确定": "uncertain",
    }
    judgement = judgement_map.get(verdict_text)
    if not judgement:
        return None
    return {
        "correct_answer": match.group("correct").strip(),
        "student_answer": match.group("student").strip(),
        "judgement": judgement,
    }


@router.post("/run", response_model=AgentRunResponse, dependencies=[Depends(agent_run_limit)])
def agent_run(payload: AgentRunRequest, db: Session = Depends(get_db)) -> AgentRunResponse:
    assert_workroom_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
    )
    resolved_document_id = payload.studio_document_id
    logger.info(
        "agent_run start tenant=%s user=%s workroom=%s ui=%s studio_document_id=%s msg_count=%s",
        payload.tenant_id,
        payload.user_id,
        payload.workroom_id,
        payload.ui_context,
        resolved_document_id,
        len(payload.messages),
    )

    resolved_source_file_ids = resolve_source_file_ids(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        explicit_source_ids=list(payload.source_file_ids or []),
    )

    is_fresh_turn = is_fresh_conversation(payload.messages)

    session_id: int | None = payload.session_id
    thread_id: str | None = None
    view_id = payload.view_id or "default"

    session_profile: dict | None = None
    history_summary: str | None = None
    continuation_seed: dict = {}

    if view_id:
        try:
            runtime_ctx = resolve_run_runtime_context(
                db=db,
                tenant_id=payload.tenant_id,
                user_id=payload.user_id,
                workroom_id=payload.workroom_id,
                resolved_document_id=resolved_document_id,
                payload_session_id=session_id,
                is_fresh_turn=is_fresh_turn,
                view_id=view_id,
                unique_thread_fallback=False,
            )
            session_id = runtime_ctx.get("session_id")
            thread_id = runtime_ctx.get("thread_id")
            session_profile = runtime_ctx.get("session_profile")
            history_summary = runtime_ctx.get("history_summary")
            continuation_seed = runtime_ctx.get("continuation_seed") or {}
        except HTTPException as exc:
            logger.warning(
                "agent_run session_failed tenant=%s user=%s studio_document_id=%s view_id=%s detail=%s",
                payload.tenant_id,
                payload.user_id,
                resolved_document_id,
                view_id,
                getattr(exc, "detail", None),
            )

    if not thread_id:
        thread_id = build_run_thread_id(
            tenant_id=payload.tenant_id,
            user_id=payload.user_id,
            workroom_id=payload.workroom_id,
            studio_document_id=resolved_document_id,
            with_suffix=True,
        )

    messages = sanitize_conversation_messages(payload.messages)
    incremental_messages = _compute_incremental_visible_messages(
        db=db,
        tenant_id=payload.tenant_id,
        session_id=session_id,
        sanitized_messages=messages,
    )
    note_focus_state = _build_note_focus_state(payload.note_focus)
    environment_state = _load_agent_environment_state(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        ui_context=payload.ui_context,
        studio_document_id=resolved_document_id,
        note_focus=note_focus_state,
    )
    context = build_agent_router_context(
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        studio_document_id=resolved_document_id,
        source_file_ids=resolved_source_file_ids,
        ui_context=payload.ui_context,
        session_id=session_id,
        thread_id=thread_id,
        environment_state=environment_state,
    )
    if payload.agent_max_steps is not None and int(payload.agent_max_steps) > 0:
        context["agent_max_steps"] = int(payload.agent_max_steps)
    if session_profile:
        context["session_profile"] = session_profile
    if history_summary:
        context["history_summary"] = history_summary
    ingress_messages = [
        {"role": m["role"], "content": m["content"]}
        for m in incremental_messages
        if m["role"] in ("user", "assistant")
    ]
    _log_messages_preview("agent_run.before_invoke", ingress_messages)

    config = {"configurable": {"thread_id": thread_id}}
    result = _app.invoke({**context, "ingress_messages": ingress_messages}, config=config)
    final_answer_payload = result.get("final_answer_payload") if isinstance(result.get("final_answer_payload"), dict) else None
    persist_agent_messages(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        session_id=session_id,
        result_messages=result["messages"],
        final_answer_payload=final_answer_payload,
    )
    return AgentRunResponse(
        session_id=session_id,
        messages=[AgentMessage(**m) for m in from_state_messages(result["messages"])],
        halt_reason=result.get("halt_reason"),
        interrupt_payload=result.get("interrupt_payload"),
        ag_ui_events=list(result.get("ag_ui_events") or []),
        final_answer_payload=final_answer_payload,
    )


# ===== Legacy-compatible tools: sync-question & snapshot =====


class QuestionSyncRequest(BaseModel):
    tenant_id: int
    user_id: int
    workroom_id: int
    studio_document_id: int | None = None
    session_id: int | None = None
    file_id: int | None = None
    question_id: int | None = None
    sequence_index: int
    page: int | None = None
    content: str
    legend_images: List[str] | None = None
    student_answer: str | None = None
    title: str | None = None
    source_type: str | None = None  # 'upload' 或 'favorite'


class EnsureDocumentRequest(BaseModel):
    tenant_id: int
    user_id: int
    workroom_id: int
    studio_document_id: int | None = None
    session_id: int | None = None
    file_id: int | None = None
    title: str | None = None
    source_type: str | None = None


class EnsureDocumentResponse(BaseModel):
    studio_document_id: int
    title: str


@router.post("/sync-question", dependencies=[Depends(sync_limit)])
def sync_question(payload: QuestionSyncRequest, db: Session = Depends(get_db)) -> dict:
    """与旧前端兼容的题目同步接口。

    使用 AgentService.sync_question 将 OCR 结果持久化为 questions/document，
    返回 studio_document_id 及题目 id/sequence_index。
    """

    assert_workroom_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
    )
    assert_studio_document_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        studio_document_id=payload.studio_document_id,
    )
    if payload.session_id is not None:
        session_ok = db.execute(
            text(
                """
                SELECT 1
                FROM extraction_sessions
                WHERE id = :session_id
                  AND tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND workroom_id = :workroom_id
                LIMIT 1
                """
            ),
            {
                "session_id": int(payload.session_id),
                "tenant_id": int(payload.tenant_id),
                "user_id": int(payload.user_id),
                "workroom_id": int(payload.workroom_id),
            },
        ).fetchone()
        if not session_ok:
            raise HTTPException(status_code=409, detail="session_id not in workroom scope")
    if payload.file_id is not None:
        file_ok = db.execute(
            text(
                """
                SELECT 1
                FROM workroom_source_bindings
                WHERE file_id = :file_id
                  AND tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND workroom_id = :workroom_id
                  AND is_active = TRUE
                LIMIT 1
                """
            ),
            {
                "file_id": int(payload.file_id),
                "tenant_id": int(payload.tenant_id),
                "user_id": int(payload.user_id),
                "workroom_id": int(payload.workroom_id),
            },
        ).fetchone()
        if not file_ok:
            raise HTTPException(status_code=409, detail="file_id not in workroom scope")

    svc = AgentService(db)
    document, question = svc.sync_question(
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        document_id=payload.studio_document_id,
        session_id=payload.session_id,
        file_id=payload.file_id,
        question_id=payload.question_id,
        sequence_index=payload.sequence_index,
        page=payload.page,
        content=payload.content,
        legend_images=payload.legend_images,
        student_answer=payload.student_answer,
        title=payload.title,
        source_type=payload.source_type,
    )
    return {
        "studio_document_id": document.id,
        "question": {
            "id": question.id,
            "sequence_index": question.sequence_index,
        },
    }


@router.post("/ensure-document", response_model=EnsureDocumentResponse)
def ensure_document(payload: EnsureDocumentRequest, db: Session = Depends(get_db)) -> EnsureDocumentResponse:
    assert_workroom_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
    )
    assert_studio_document_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        studio_document_id=payload.studio_document_id,
    )
    if payload.session_id is not None:
        session_ok = db.execute(
            text(
                """
                SELECT 1
                FROM extraction_sessions
                WHERE id = :session_id
                  AND tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND workroom_id = :workroom_id
                LIMIT 1
                """
            ),
            {
                "session_id": int(payload.session_id),
                "tenant_id": int(payload.tenant_id),
                "user_id": int(payload.user_id),
                "workroom_id": int(payload.workroom_id),
            },
        ).fetchone()
        if not session_ok:
            raise HTTPException(status_code=409, detail="session_id not in workroom scope")
    if payload.file_id is not None:
        file_ok = db.execute(
            text(
                """
                SELECT 1
                FROM workroom_source_bindings
                WHERE file_id = :file_id
                  AND tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND workroom_id = :workroom_id
                  AND is_active = TRUE
                LIMIT 1
                """
            ),
            {
                "file_id": int(payload.file_id),
                "tenant_id": int(payload.tenant_id),
                "user_id": int(payload.user_id),
                "workroom_id": int(payload.workroom_id),
            },
        ).fetchone()
        if not file_ok:
            raise HTTPException(status_code=409, detail="file_id not in workroom scope")
    svc = AgentService(db)
    svc.require_active_subscription(payload.tenant_id)

    if payload.source_type == "favorite" and payload.studio_document_id is None:
        document = svc._ensure_favorite_document(
            tenant_id=payload.tenant_id,
            user_id=payload.user_id,
            workroom_id=payload.workroom_id,
            title=payload.title,
        )
    else:
        document = svc._ensure_document(
            tenant_id=payload.tenant_id,
            user_id=payload.user_id,
            workroom_id=payload.workroom_id,
            document_id=payload.studio_document_id,
            session_id=payload.session_id,
            file_id=payload.file_id,
            title=payload.title,
        )

    return EnsureDocumentResponse(studio_document_id=document.id, title=document.title)


@router.post("/snapshot", dependencies=[Depends(snapshot_limit)])
def get_snapshot(payload: SnapshotRequest, db: Session = Depends(get_db)) -> dict:
    """返回指定试卷的题目快照，兼容旧前端 AgentSnapshotResponse 结构。"""
    assert_workroom_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
    )
    assert_studio_document_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        studio_document_id=payload.studio_document_id,
    )

    svc = AgentService(db)
    document, questions = svc.get_snapshot(
        tenant_id=payload.tenant_id,
        document_id=payload.studio_document_id,
    )

    def _parse_legend_images(raw: str | None) -> List[str]:
        import json

        if not raw:
            return []
        try:
            val = json.loads(raw)
            if isinstance(val, list):
                return [str(x) for x in val]
        except Exception:  # noqa: BLE001 - 容错
            pass
        return []

    return {
        "studio_document_id": document.id,
        "title": document.title,
        "status": document.status,
        "questions": [
            {
                "id": q.id,
                "sequenceIndex": q.sequence_index,
                "groupId": getattr(q, "group_id", None),
                "page": q.page,
                "content": q.content,
                "legendImages": _parse_legend_images(q.legend_images),
                "studentAnswer": getattr(q, "student_answer", None),
                "gradingJudgement": getattr(q, "grading_judgement", None),
                "gradingPredictedAnswer": getattr(q, "grading_predicted_answer", None),
                "gradingReasoning": getattr(q, "grading_reasoning", None),
                "gradingConfidence": getattr(q, "grading_confidence", None),
                "versions": getattr(q, "versions", []) or [],
            }
            for q in questions
        ],
    }


@router.post("/delete-question", dependencies=[Depends(sync_limit)])
def delete_question(payload: DeleteQuestionRequest, db: Session = Depends(get_db)) -> dict:
    """删除单道题目，供前端题卡删除后同步更新 agent 快照使用。"""
    assert_workroom_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
    )
    assert_studio_document_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        studio_document_id=payload.studio_document_id,
    )

    svc = AgentService(db)
    svc.delete_question(
        tenant_id=payload.tenant_id,
        document_id=payload.studio_document_id,
        question_id=payload.question_id,
    )
    return {"ok": True}


GRADING_SYSTEM_PROMPT = (
    "你是一个严格的数学/理科阅卷老师，负责对单道题的作答进行机器阅卷。"
    "你会拿到：题目原文、（可选的）图像文字描述、以及学生答案。"
    "你的任务是：先在可见的 reasoning 中完整推理出该题的正确答案，再根据该最终推理结论，给出结构化的 JSON 判定结果。"
    "\n\n【判分规则（务必遵守）】"
    "1. 请在 reasoning 中用中文分步骤且简洁地推理。允许进行至多一次简短复查，但不要多次反复推翻之前的结论。最后必须明确给出："
    "   - 你最终认可的正确答案 correct_answer（例如：正确答案是 C，或正确答案是 1 等）；"
    "   - 学生答案是否等于 correct_answer，以及因此学生作答是正确/错误/无法确定。"
    "2. 完成推理后，根据该结论填写 JSON："
    "   - predicted_answer 必须等于你在 reasoning 最后给出的正确答案；"
    "   - judgement 必须与 reasoning 最后一行的结论完全一致（只能为 'correct', 'incorrect', 'skipped', 'uncertain'）；"
    "   - 严禁出现 reasoning 的最终结论与 JSON 中的 predicted_answer 或 judgement 相矛盾的情况。"
    "3. 将学生答案 student_answer 与 correct_answer 做严格比较："
    "   - 若能够明确比较且二者相同，则 judgement 必须为 'correct'；"
    "   - 若能够明确比较且二者不同，则 judgement 必须为 'incorrect'；"
    "   - 若题目信息不足或存在多解、无解等情况，无法可靠判断对错时，judgement 必须为 'uncertain'；"
    "   - 学生未作答在上游已处理，这里不会出现 judgement='skipped' 的场景。"
    "4. reasoning 内容需覆盖：求解过程 + 正确答案 + 学生答案为何被判为当前 judgement，并避免无意义的来回修改。"
    "5. 在 reasoning 的最后一行必须使用固定格式总结："
    "   “最终结论：正确答案是 {correct_answer}，学生答案是 {student_answer}，判定为 {正确/错误/无法确定}。”"
    "   其中 {correct_answer}、{student_answer}、{判定为…} 均需与 JSON 字段完全一致。"
    "6. confidence 为 0~1 之间的小数，表示你对当前判定的主观把握程度（例如 0.95）。"
    "7. reasoning 不宜过长，通常 8~12 行推理即可，确保逻辑清晰。"
    "\n\n【输出要求】"
    "- 最终回复中必须只输出一个 JSON 对象，不能包含任何 JSON 之外的额外文本、评论或 Markdown。"
    "- JSON 字段必须完整且仅包含：predicted_answer, judgement, confidence, reasoning。"
    "- judgement 取值只能是: 'correct', 'incorrect', 'skipped', 'uncertain' 之一（小写）。"
    '示例 JSON：{"predicted_answer": "C", "judgement": "incorrect", "confidence": 0.87, "reasoning": "……最终结论：正确答案是 C，学生答案是 A，判定为 错误。"}'
)


def _parse_json_response(payload: str) -> dict:
    text = payload.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            snippet = text[start : end + 1]
            return json.loads(snippet)
        raise


@router.post("/split-questions", response_model=SplitQuestionsResponse, dependencies=[Depends(split_limit)])
def split_questions(
    payload: SplitQuestionsRequest, db: Session = Depends(get_db)
) -> SplitQuestionsResponse:
    svc = AgentService(db)
    svc.require_active_subscription(payload.tenant_id)

    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text 不能为空")

    max_q = payload.max_questions or 20

    system_prompt = (
        "你是一个试卷整理助手，负责将一段可能包含多道题目的中文文本拆分成可以独立编辑的题目块。"
        "题目可能是选择题、填空题、解答题等，你需要根据题号、结构和语义判断题目边界。"
        "输出必须是一个 JSON 对象，形如：{\"questions\":[{\"index\":1,\"text\":\"...\"}, ...]}。"
        "只输出 JSON，不要包含任何额外解释、注释或 Markdown。"
        "每个 text 字段应包含该题目的完整题干，可以保留题号和选项。"
        "不要把不同题目合并为一题，也不要把同一题拆得过细（例如将一个大题拆成多个无意义的碎片）。"
    )

    user_prompt_lines = [
        "下面是一段可能包含多道试题的文本，请按\"单道题\"的粒度进行拆分：",
        "\n【原始文本】\n",
        text,
        "\n【任务要求】\n",
        "1. 仔细识别题号（如：1.、2、（1）、一、二、三等）和题干结构，推断题目边界。",
        "2. 每道题的 text 中应包含完整题干以及紧随其后的与本题紧密相关的内容（包括选项）。",
        "3. 如果无法明显拆出多题，则只输出一条 questions，text 为原文或适度清理后的完整文本。",
        "4. 最多返回",
        str(max_q),
        "道题目，多余的题目可以忽略。",
        "5. 严格按照 {\"questions\":[{\"index\":number,\"text\":string}]} 的结构输出 JSON，不要输出任何多余文字。",
    ]
    user_prompt = "".join(user_prompt_lines)

    client = QwenClient()
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    raw_response = ""
    try:
        raw_response, _usage = client.chat(messages, temperature=0.1, top_p=0.8)
        parsed = _parse_json_response(raw_response)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "split_questions failed tenant=%s user=%s error=%s raw_preview=%s",
            payload.tenant_id,
            payload.user_id,
            exc,
            (raw_response[:300] + "...") if raw_response else "",
        )
        raise HTTPException(status_code=500, detail="LLM 返回结果解析失败") from exc

    items = parsed.get("questions")
    questions: List[SplitQuestionItem] = []
    if isinstance(items, list):
        for i, item in enumerate(items, start=1):
            if not isinstance(item, dict):
                continue
            text_val = str(item.get("text", "")).strip()
            if not text_val:
                continue
            idx_raw = item.get("index")
            try:
                idx = int(idx_raw) if idx_raw is not None else i
            except (TypeError, ValueError):
                idx = i
            questions.append(SplitQuestionItem(index=idx, text=text_val))

    if not questions:
        questions.append(SplitQuestionItem(index=1, text=text))

    questions = questions[:max_q]
    return SplitQuestionsResponse(questions=questions)


@router.post("/grade", response_model=GradeRunResponse, dependencies=[Depends(grade_limit)])
def grade_document(payload: GradeRunRequest, db: Session = Depends(get_db)) -> GradeRunResponse:
    if not payload.questions:
        raise HTTPException(status_code=400, detail="无题目可批改")

    svc = AgentService(db)
    # 仅用于校验订阅状态
    svc.require_active_subscription(payload.tenant_id)
    assert_workroom_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
    )
    assert_studio_document_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        studio_document_id=payload.studio_document_id,
    )

    client = QwenClient()
    results: List[GradeQuestionResult] = []

    for q in payload.questions:
        seq = q.sequence_index
        user_answer = (q.user_answer or "").strip()
        if not q.content.strip():
            results.append(
                GradeQuestionResult(
                    sequence_index=seq,
                    judgement="error",
                    error="题目内容为空，无法批改",
                )
            )
            if payload.studio_document_id is not None:
                svc.update_question_grading(
                    tenant_id=payload.tenant_id,
                    document_id=payload.studio_document_id,
                    sequence_index=seq,
                    student_answer=user_answer or None,
                    judgement="error",
                    predicted_answer=None,
                    reasoning="题目内容为空，无法批改",
                    confidence=None,
                )
            continue

        if not user_answer:
            results.append(
                GradeQuestionResult(
                    sequence_index=seq,
                    judgement="skipped",
                    predicted_answer=None,
                    reasoning="学生未作答",
                    confidence=None,
                )
            )
            if payload.studio_document_id is not None:
                svc.update_question_grading(
                    tenant_id=payload.tenant_id,
                    document_id=payload.studio_document_id,
                    sequence_index=seq,
                    student_answer=None,
                    judgement="skipped",
                    predicted_answer=None,
                    reasoning="学生未作答",
                    confidence=None,
                )
            continue

        user_prompt_lines = [
            "【题目】",
            q.content.strip(),
        ]
        user_prompt_lines.append("\n【学生答案】")
        user_prompt_lines.append(user_answer)
        user_prompt_lines.append(
            "\n请根据题目与学生答案判断对错，并填充指定 JSON。不要输出多余文字。"
        )
        user_prompt = "\n".join(user_prompt_lines)

        messages = [
            {"role": "system", "content": GRADING_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ]

        raw_response = ""
        try:
            raw_response, _usage = client.chat(messages, temperature=0.2, top_p=0.8)
            logger.info(
                "grade raw_response seq=%s length=%s raw=%s",
                seq,
                len(raw_response),
                raw_response,
            )
            parsed = _parse_json_response(raw_response)
            logger.info("grade parsed seq=%s parsed=%s", seq, parsed)
            judgement = str(parsed.get("judgement", "")).strip().lower()
            if judgement not in {"correct", "incorrect", "skipped", "uncertain"}:
                judgement = "uncertain"
            predicted_answer = parsed.get("predicted_answer")
            reasoning = parsed.get("reasoning")
            reasoning_text = str(reasoning).strip() if reasoning is not None else ""
            confidence = parsed.get("confidence")
            try:
                confidence_val = float(confidence) if confidence is not None else None
            except (TypeError, ValueError):
                confidence_val = None

            conclusion = _extract_final_conclusion(reasoning_text)
            if not conclusion:
                error_msg = "LLM reasoning 缺少固定格式的最终结论，拒绝采纳本次批改结果。"
                logger.warning(
                    "grade canonical_failed seq=%s reason=%s raw_preview=%s",
                    seq,
                    error_msg,
                    (raw_response[:300] + "...") if len(raw_response) > 300 else raw_response,
                )
                results.append(
                    GradeQuestionResult(
                        sequence_index=seq,
                        judgement="error",
                        error=error_msg,
                        raw_response=raw_response,
                        reasoning=reasoning_text or None,
                    )
                )
                if payload.studio_document_id is not None:
                    svc.update_question_grading(
                        tenant_id=payload.tenant_id,
                        document_id=payload.studio_document_id,
                        sequence_index=seq,
                        student_answer=user_answer or None,
                        judgement="error",
                        predicted_answer=None,
                        reasoning=error_msg,
                        confidence=None,
                    )
                continue

            final_predicted = conclusion["correct_answer"]
            final_judgement = conclusion["judgement"]
            conclusion_student_answer = conclusion["student_answer"]

            if str(predicted_answer).strip() != final_predicted:
                logger.warning(
                    "grade predicted_mismatch seq=%s json_pred=%s conclusion_pred=%s",
                    seq,
                    predicted_answer,
                    final_predicted,
                )
            if judgement != final_judgement:
                logger.warning(
                    "grade judgement_mismatch seq=%s json_judgement=%s conclusion_judgement=%s",
                    seq,
                    judgement,
                    final_judgement,
                )
            if conclusion_student_answer and conclusion_student_answer.strip() != user_answer:
                logger.warning(
                    "grade student_answer_mismatch seq=%s conclusion_student=%s user_answer=%s",
                    seq,
                    conclusion_student_answer,
                    user_answer,
                )
            judgement = final_judgement
            predicted_answer = final_predicted
            reasoning = reasoning_text

            # 详细记录每道题的批改结果，便于排查 judgement 与解析文字不一致的问题。
            logger.info(
                "grade result seq=%s judgement=%s predicted=%s user_answer=%s confidence=%s raw_preview=%s",
                seq,
                judgement,
                predicted_answer,
                user_answer,
                confidence_val,
                (raw_response[:300] + "...") if len(raw_response) > 300 else raw_response,
            )

            results.append(
                GradeQuestionResult(
                    sequence_index=seq,
                    judgement=judgement,  # type: ignore[arg-type]
                    predicted_answer=predicted_answer,
                    reasoning=reasoning,
                    confidence=confidence_val,
                    raw_response=raw_response,
                )
            )

            if payload.studio_document_id is not None:
                svc.update_question_grading(
                    tenant_id=payload.tenant_id,
                    document_id=payload.studio_document_id,
                    sequence_index=seq,
                    student_answer=user_answer or None,
                    judgement=judgement,
                    predicted_answer=str(predicted_answer) if predicted_answer is not None else None,
                    reasoning=str(reasoning) if reasoning is not None else None,
                    confidence=confidence_val,
                )
        except Exception as exc:  # noqa: BLE001
            logger.exception("grade question failed seq=%s", seq)
            results.append(
                GradeQuestionResult(
                    sequence_index=seq,
                    judgement="error",
                    error=str(exc),
                    raw_response=raw_response or None,
                )
            )

            if payload.studio_document_id is not None:
                svc.update_question_grading(
                    tenant_id=payload.tenant_id,
                    document_id=payload.studio_document_id,
                    sequence_index=seq,
                    student_answer=user_answer or None,
                    judgement="error",
                    predicted_answer=None,
                    reasoning=str(exc),
                    confidence=None,
                )

    return GradeRunResponse(results=results)


@router.post("/run-stream", dependencies=[Depends(agent_stream_limit)])
def agent_run_stream(payload: AgentRunRequest, db: Session = Depends(get_db)) -> StreamingResponse:
    """流式输出版本的 Agent 接口。

    - 与 /run 使用相同的请求体（tenant_id/user_id/workroom_id/ui_context/studio_document_id/messages）。
    - 在服务端拼好 SYSTEM_PROMPT + 试卷快照 + 对话历史，然后通过 QwenClient.chat_stream
      将生成的文本逐块推送给前端。
    """

    assert_workroom_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
    )
    assert_studio_document_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        studio_document_id=payload.studio_document_id,
    )
    logger.info(
        "agent_run_stream start tenant=%s user=%s workroom=%s ui=%s studio_document_id=%s msg_count=%s",
        payload.tenant_id,
        payload.user_id,
        payload.workroom_id,
        payload.ui_context,
        payload.studio_document_id,
        len(payload.messages),
    )

    conversation_messages: list[dict] = []
    resolved_document_id = payload.studio_document_id
    resolved_source_file_ids = resolve_source_file_ids(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        explicit_source_ids=list(payload.source_file_ids or []),
    )

    is_fresh_turn = is_fresh_conversation(payload.messages)

    stream_queue: "queue.Queue[dict | None]" = queue.Queue()

    session_id: int | None = payload.session_id
    thread_id: str | None = None
    view_id = payload.view_id or "default"
    session_profile: dict | None = None
    history_summary: str | None = None

    if view_id:
        try:
            runtime_ctx = resolve_run_runtime_context(
                db=db,
                tenant_id=payload.tenant_id,
                user_id=payload.user_id,
                workroom_id=payload.workroom_id,
                resolved_document_id=resolved_document_id,
                payload_session_id=session_id,
                is_fresh_turn=is_fresh_turn,
                view_id=view_id,
                unique_thread_fallback=True,
            )
            session_id = runtime_ctx.get("session_id")
            thread_id = runtime_ctx.get("thread_id")
            session_profile = runtime_ctx.get("session_profile")
            history_summary = runtime_ctx.get("history_summary")
        except HTTPException as exc:  # pragma: no cover - 容错
            logger.warning(
                "agent_run_stream session_failed tenant=%s user=%s studio_document_id=%s view_id=%s detail=%s",
                payload.tenant_id,
                payload.user_id,
                resolved_document_id,
                view_id,
                getattr(exc, "detail", None),
            )

    if not thread_id:
        thread_id = build_run_thread_id(
            tenant_id=payload.tenant_id,
            user_id=payload.user_id,
            workroom_id=payload.workroom_id,
            studio_document_id=resolved_document_id,
            with_suffix=True,
        )

    for m in sanitize_conversation_messages(payload.messages):
        role = m["role"] if m["role"] in ("system", "user", "assistant") else "user"
        conversation_messages.append({"role": role, "content": m["content"]})

    incremental_messages = _compute_incremental_visible_messages(
        db=db,
        tenant_id=payload.tenant_id,
        session_id=session_id,
        sanitized_messages=conversation_messages,
    )

    _log_messages_preview("agent_run_stream.before_qwen", incremental_messages)

    config = {"configurable": {"thread_id": thread_id}}

    def run_graph_thread() -> None:
        start_ts = time.time()
        db_local = SessionLocal()
        try:
            ingress_messages = [
                {"role": m["role"], "content": m["content"]}
                for m in incremental_messages
                if m["role"] in ("user", "assistant")
            ]
            logger.info(
                "agent_run_stream.graph_thread_start tenant=%s user=%s session=%s thread=%s base_len=%s ingress_len=%s",
                payload.tenant_id,
                payload.user_id,
                session_id,
                thread_id,
                len(conversation_messages),
                len(ingress_messages),
            )
            note_focus_state = _build_note_focus_state(payload.note_focus)
            environment_state = _load_agent_environment_state(
                db=db_local,
                tenant_id=payload.tenant_id,
                user_id=payload.user_id,
                workroom_id=payload.workroom_id,
                ui_context=payload.ui_context,
                studio_document_id=resolved_document_id,
                note_focus=note_focus_state,
            )
            context = build_agent_router_context(
                tenant_id=payload.tenant_id,
                user_id=payload.user_id,
                workroom_id=payload.workroom_id,
                studio_document_id=resolved_document_id,
                source_file_ids=resolved_source_file_ids,
                ui_context=payload.ui_context,
                session_id=session_id,
                thread_id=thread_id,
                environment_state=environment_state,
            )
            if payload.agent_max_steps is not None and int(payload.agent_max_steps) > 0:
                context["agent_max_steps"] = int(payload.agent_max_steps)
            if session_profile:
                context["session_profile"] = session_profile
            if history_summary:
                context["history_summary"] = history_summary
            logger.info(
                "agent_run_stream.environment tenant=%s user=%s thread=%s env_summary=%s",
                payload.tenant_id,
                payload.user_id,
                thread_id,
                {
                    "studio_document_id": context.get("studio_document_id"),
                    "source_count": len(list(context.get("source_file_ids") or [])),
                    "studio_view": (((context.get("environment_state") or {}).get("layout") or {}).get("center_panel") or {}).get("studio_view"),
                },
            )
            streamed_messages: list[Any] = []
            streamed_tool_results: list[Any] = []
            streamed_conversation_messages: list[Any] = []
            streamed_tool_results: list[Any] = []
            emitted_text: dict[str, str] = {}
            trace_reducer = StreamTraceReducer()
            emitted_final_text = False
            stream_stats = {"events_total": 0, "assistant_chunks": 0, "agent_traces": 0, "ag_ui": 0}
            stream = _app.stream(
                {**context, "ingress_messages": ingress_messages},
                config=config,
                stream_mode=["messages", "updates", "custom"],
            )
            for raw_event in stream:
                mode, event_payload = normalize_stream_event(raw_event)
                stream_stats["events_total"] += 1
                if mode == "custom" and isinstance(event_payload, dict):
                    stream_type = str(event_payload.get("stream_type") or "").strip().lower()
                    if stream_type == "assistant_delta":
                        delta = str(event_payload.get("delta") or "")
                        if delta:
                            stream_stats["assistant_chunks"] += 1
                    elif stream_type == "thinking_delta":
                        content = str(event_payload.get("content") or "")
                        if content:
                            stream_stats["agent_traces"] += 1
                            stream_queue.put(
                                {
                                    "type": "agent_trace",
                                    "payload": {
                                        "trace_type": "model_native_thinking",
                                        "node": str(event_payload.get("node") or "decide"),
                                        "content": content,
                                    },
                                }
                            )
                    elif stream_type == "tool_call":
                        stream_stats["agent_traces"] += 1
                        stream_queue.put(
                            {
                                "type": "agent_trace",
                                "payload": {
                                    "trace_type": "tool_call",
                                    "node": str(event_payload.get("node") or "execute_tools"),
                                    "tool_name": event_payload.get("tool_name"),
                                    "status": event_payload.get("status"),
                                    "tool_call_id": event_payload.get("tool_call_id"),
                                    "observation": event_payload.get("observation"),
                                    "query": event_payload.get("query"),
                                },
                            }
                        )
                    continue
                trace_events = trace_reducer.reduce(iter_stream_trace_events(mode, event_payload))
                for trace_event in trace_events:
                    kind = trace_event.get("kind")
                    if kind == "assistant_text":
                        message_id = str(trace_event.get("id") or "")
                        text = str(trace_event.get("text") or "")
                        if not text:
                            continue
                        previous = emitted_text.get(message_id, "")
                        delta = text
                        if message_id and previous and text.startswith(previous):
                            delta = text[len(previous):]
                        if not delta:
                            continue
                        emitted_text[message_id] = previous + delta if message_id else previous
                        stream_stats["assistant_chunks"] += 1
                        emitted_final_text = True
                        stream_queue.put({"type": "delta", "role": "assistant", "delta": delta})
                        continue
                    if kind == "agent_trace":
                        trace_payload = trace_event.get("payload")
                        if not isinstance(trace_payload, dict) or not trace_payload:
                            continue
                        trace_type = str(trace_payload.get("trace_type") or "").strip().lower()
                        if trace_type == "tool_call":
                            stream_stats["agent_traces"] += 1
                            stream_queue.put({"type": "agent_trace", "payload": trace_payload})
                        elif trace_type == "model_event":
                            tool_calls = trace_payload.get("tool_calls")
                            if isinstance(tool_calls, list) and tool_calls:
                                stream_stats["agent_traces"] += 1
                                stream_queue.put({"type": "agent_trace", "payload": trace_payload})
                        continue
                    if kind == "ag_ui":
                        event_obj = trace_event.get("event")
                        if isinstance(event_obj, dict):
                            stream_stats["ag_ui"] += 1
                            stream_queue.put({"type": "ag_ui", "event": event_obj})
                        continue
                if mode == "updates" and isinstance(event_payload, dict):
                    for node_update in event_payload.values():
                        if not isinstance(node_update, dict):
                            continue
                        messages = node_update.get("messages")
                        if isinstance(messages, list):
                            streamed_messages = messages
                        conversation_messages_update = node_update.get("conversation_messages")
                        if isinstance(conversation_messages_update, list):
                            streamed_conversation_messages = conversation_messages_update
                        tool_results_update = node_update.get("tool_results")
                        if isinstance(tool_results_update, list):
                            streamed_tool_results = tool_results_update
            result = {
                "messages": streamed_messages,
                "conversation_messages": streamed_conversation_messages,
                "tool_results": streamed_tool_results,
            }
            final_reply = _extract_final_reply(result.get("conversation_messages") or result["messages"])
            final_answer_payload = _resolve_final_answer_payload(result)
            persist_agent_messages(
                db=db_local,
                tenant_id=payload.tenant_id,
                user_id=payload.user_id,
                session_id=session_id,
                result_messages=result.get("conversation_messages") or result["messages"],
                final_answer_payload=final_answer_payload if isinstance(final_answer_payload, dict) else None,
            )
            if (
                isinstance(final_answer_payload, dict)
                and bool(final_answer_payload.get("used_rag_evidence"))
                and isinstance(final_answer_payload.get("citations"), list)
                and final_answer_payload.get("citations")
            ):
                stream_queue.put(
                    {
                        "type": "assistant_citations",
                        "citations": final_answer_payload.get("citations"),
                        "citation_status": str(final_answer_payload.get("citation_status") or "partial"),
                    }
                )
                stream_queue.put(
                    {
                        "type": "assistant_final",
                        "answer_text": str(final_answer_payload.get("answer_text") or final_reply),
                        "citation_status": str(final_answer_payload.get("citation_status") or "partial"),
                    }
                )
            if final_reply and not emitted_final_text:
                stream_queue.put({"type": "delta", "role": "assistant", "delta": final_reply})
                emitted_final_text = True
            logger.info(
                "agent_run_stream.summary tenant=%s user=%s thread=%s stats=%s final_reply_len=%s",
                payload.tenant_id,
                payload.user_id,
                thread_id,
                stream_stats,
                len(final_reply or ""),
            )
        except Exception:
            logger.exception("agent_run_stream.graph_failed tenant=%s user=%s", payload.tenant_id, payload.user_id)
            stream_queue.put(
                {
                    "type": "error",
                    "message": "agent_runtime_error",
                }
            )
        finally:
            db_local.close()
            duration = (time.time() - start_ts) * 1000
            logger.info(
                "agent_run_stream.graph_thread_finish tenant=%s user=%s thread=%s duration_ms=%.2f",
                payload.tenant_id,
                payload.user_id,
                thread_id,
                duration,
            )
            stream_queue.put(None)

    threading.Thread(target=run_graph_thread, daemon=True).start()

    def merged_stream():
        # 首先向前端发送一次会话事件，告知本次对话对应的 session_id，便于后续 resume。
        if session_id is not None:
            yield json.dumps(
                {
                    "type": "session",
                    "session_id": session_id,
                    "studio_document_id": resolved_document_id,
                    "workroom_id": payload.workroom_id,
                },
                ensure_ascii=False,
            ) + "\n"

        while True:
            item = stream_queue.get()
            if item is None:
                break
            yield json.dumps(item, ensure_ascii=False) + "\n"

    return StreamingResponse(merged_stream(), media_type="text/plain; charset=utf-8")


@router.get("/sessions", response_model=AgentSessionListResponse)
def list_agent_sessions(
    tenant_id: int,
    user_id: int,
    workroom_id: int | None = None,
    studio_document_id: int | None = None,
    view_id: str | None = None,
    include_archived: bool = False,
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db),
) -> AgentSessionListResponse:
    """列出当前用户的 Agent 会话列表。

    - 按 tenant_id + user_id 做强隔离；
    - 可选按 studio_document_id/view_id 过滤；
    - 默认仅返回未归档会话。
    """

    svc = AgentService(db)
    sessions = svc.list_sessions(
        tenant_id=tenant_id,
        user_id=user_id,
        workroom_id=workroom_id,
        document_id=studio_document_id,
        view_id=view_id,
        include_archived=include_archived,
        limit=min(max(limit, 1), 200),
        offset=max(offset, 0),
    )

    items: list[AgentSessionMeta] = []
    for s in sessions:
        items.append(
            AgentSessionMeta(
                id=s.id,
                tenant_id=s.tenant_id,
                user_id=s.user_id,
                studio_document_id=s.document_id,
                view_id=s.view_id,
                title=getattr(s, "title", None),
                last_message_preview=getattr(s, "last_message_preview", None),
                message_count=getattr(s, "message_count", 0) or 0,
                status=s.status,
                archived=bool(getattr(s, "archived", False)),
                created_at=s.created_at,
                updated_at=s.updated_at,
            )
        )

    return AgentSessionListResponse(sessions=items)


@router.patch("/sessions/{session_id}", response_model=AgentSessionMeta)
def update_agent_session(
    session_id: int,
    payload: AgentSessionUpdateRequest,
    db: Session = Depends(get_db),
) -> AgentSessionMeta:
    """更新指定会话的元数据（标题 / 归档状态 / 自定义状态）。"""

    svc = AgentService(db)
    session = svc.update_session(
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        session_id=session_id,
        title=payload.title,
        archived=payload.archived,
        status=payload.status,
    )

    return AgentSessionMeta(
        id=session.id,
        tenant_id=session.tenant_id,
        user_id=session.user_id,
        studio_document_id=session.document_id,
        view_id=session.view_id,
        title=getattr(session, "title", None),
        last_message_preview=getattr(session, "last_message_preview", None),
        message_count=getattr(session, "message_count", 0) or 0,
        status=session.status,
        archived=bool(getattr(session, "archived", False)),
        created_at=session.created_at,
        updated_at=session.updated_at,
    )


class AgentSessionDeleteRequest(BaseModel):
    tenant_id: int
    user_id: int


@router.delete("/sessions/{session_id}")
def delete_agent_session(
    session_id: int,
    payload: AgentSessionDeleteRequest,
    db: Session = Depends(get_db),
) -> dict:
    """软删除指定会话：标记为 deleted/archived，但保留历史记录。"""

    svc = AgentService(db)
    svc.soft_delete_session(
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        session_id=session_id,
    )
    return {"ok": True}


@router.get("/sessions/{session_id}/messages", response_model=AgentSessionMessagesResponse)
def get_agent_session_messages(
    session_id: int,
    tenant_id: int,
    user_id: int,
    limit: int = 200,
    db: Session = Depends(get_db),
) -> AgentSessionMessagesResponse:
    """返回指定会话的历史消息列表（按时间正序）。"""

    svc = AgentService(db)
    # 校验会话归属，避免跨租户/跨用户访问
    svc.get_session(tenant_id=tenant_id, session_id=session_id, user_id=user_id)

    raw_messages = svc.list_messages(
        tenant_id=tenant_id,
        session_id=session_id,
        limit=min(max(limit, 1), 500),
    )

    # list_messages 默认按 id 倒序，这里翻转为时间正序
    raw_messages = list(sorted(raw_messages, key=lambda m: m.id))

    items: list[AgentHistoryMessage] = []
    for m in raw_messages:
        metadata = m.metadata_json if isinstance(getattr(m, "metadata_json", None), dict) else {}
        raw_citations = metadata.get("citations") if isinstance(metadata.get("citations"), list) else []
        items.append(
            AgentHistoryMessage(
                id=m.id,
                role=m.role,  # 已由 AgentService 保证 role 为简单字符串
                content=m.content,
                created_at=m.created_at,
                citations=[AgentCitationAnchor(**item) for item in raw_citations if isinstance(item, dict)],
                citation_status=str(metadata.get("citation_status") or "").strip() or None,
                used_rag_evidence=bool(metadata.get("used_rag_evidence")),
            )
        )

    return AgentSessionMessagesResponse(session_id=session_id, messages=items)


@router.post("/run-resume", response_model=AgentRunResponse, dependencies=[Depends(agent_resume_limit)])
def agent_run_resume(payload: AgentResumeRequest, db: Session = Depends(get_db)) -> AgentRunResponse:
    assert_workroom_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
    )
    assert_studio_document_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        studio_document_id=payload.studio_document_id,
    )

    runtime_ctx = resolve_resume_runtime_context(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        payload_thread_id=payload.thread_id,
        payload_session_id=payload.session_id,
        studio_document_id=payload.studio_document_id,
    )
    session_id = runtime_ctx.get("session_id")
    thread_id = str(runtime_ctx.get("thread_id") or "").strip()
    session_profile = runtime_ctx.get("session_profile")
    history_summary = runtime_ctx.get("history_summary")
    if not thread_id:
        raise HTTPException(status_code=400, detail="thread_id is required for resume")
    resolved_source_file_ids = resolve_source_file_ids(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        explicit_source_ids=None,
    )
    environment_state = _load_agent_environment_state(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        ui_context=payload.ui_context,
        studio_document_id=payload.studio_document_id,
        note_focus=None,
    )

    context = build_agent_router_context(
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        studio_document_id=payload.studio_document_id,
        source_file_ids=resolved_source_file_ids,
        ui_context=payload.ui_context,
        session_id=session_id,
        thread_id=thread_id,
        environment_state=environment_state,
    )
    if payload.agent_max_steps is not None and int(payload.agent_max_steps) > 0:
        context["agent_max_steps"] = int(payload.agent_max_steps)
    if session_profile:
        context["session_profile"] = session_profile
    if history_summary:
        context["history_summary"] = history_summary
    config = {"configurable": {"thread_id": thread_id}}
    result = _app.invoke(
        {
            **context,
            "messages": [],
            "resume_payload": payload.resume_payload,
        },
        config=config,
    )
    final_answer_payload = _resolve_final_answer_payload(result)
    persist_agent_messages(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        session_id=session_id,
        result_messages=result.get("messages") or [],
        final_answer_payload=final_answer_payload if isinstance(final_answer_payload, dict) else None,
    )
    return AgentRunResponse(
        session_id=session_id,
        messages=[AgentMessage(**m) for m in from_state_messages(result.get("messages") or [])],
        halt_reason=result.get("halt_reason"),
        interrupt_payload=result.get("interrupt_payload"),
        ag_ui_events=list(result.get("ag_ui_events") or []),
        final_answer_payload=final_answer_payload if isinstance(final_answer_payload, dict) else None,
    )


@router.post("/run-resume-stream", dependencies=[Depends(agent_resume_limit)])
def agent_run_resume_stream(payload: AgentResumeRequest, db: Session = Depends(get_db)) -> StreamingResponse:
    assert_workroom_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
    )
    assert_studio_document_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        studio_document_id=payload.studio_document_id,
    )

    runtime_ctx = resolve_resume_runtime_context(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        payload_thread_id=payload.thread_id,
        payload_session_id=payload.session_id,
        studio_document_id=payload.studio_document_id,
    )
    session_id = runtime_ctx.get("session_id")
    thread_id = str(runtime_ctx.get("thread_id") or "").strip()
    session_profile = runtime_ctx.get("session_profile")
    history_summary = runtime_ctx.get("history_summary")
    if not thread_id:
        raise HTTPException(status_code=400, detail="thread_id is required for resume")

    resolved_source_file_ids = resolve_source_file_ids(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        explicit_source_ids=None,
    )
    environment_state = _load_agent_environment_state(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        ui_context=payload.ui_context,
        studio_document_id=payload.studio_document_id,
        note_focus=None,
    )
    context = build_agent_router_context(
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        studio_document_id=payload.studio_document_id,
        source_file_ids=resolved_source_file_ids,
        ui_context=payload.ui_context,
        session_id=session_id,
        thread_id=thread_id,
        environment_state=environment_state,
    )
    if payload.agent_max_steps is not None and int(payload.agent_max_steps) > 0:
        context["agent_max_steps"] = int(payload.agent_max_steps)
    if session_profile:
        context["session_profile"] = session_profile
    if history_summary:
        context["history_summary"] = history_summary
    config = {"configurable": {"thread_id": thread_id}}
    stream_queue: "queue.Queue[dict | None]" = queue.Queue()

    def run_resume_thread() -> None:
        db_local = SessionLocal()
        try:
            streamed_messages: list[Any] = []
            trace_reducer = StreamTraceReducer()
            emitted_text: dict[str, str] = {}
            emitted_final_text = False
            stream_stats = {"events_total": 0, "assistant_chunks": 0, "agent_traces": 0, "ag_ui": 0}
            stream = _app.stream(
                {
                    **context,
                    "messages": [],
                    "resume_payload": payload.resume_payload,
                },
                config=config,
                stream_mode=["messages", "updates", "custom"],
            )
            for raw_event in stream:
                mode, event_payload = normalize_stream_event(raw_event)
                stream_stats["events_total"] += 1
                if mode == "custom" and isinstance(event_payload, dict):
                    stream_type = str(event_payload.get("stream_type") or "").strip().lower()
                    if stream_type == "assistant_delta":
                        delta = str(event_payload.get("delta") or "")
                        if delta:
                            stream_stats["assistant_chunks"] += 1
                    elif stream_type == "thinking_delta":
                        content = str(event_payload.get("content") or "")
                        if content:
                            stream_stats["agent_traces"] += 1
                            stream_queue.put(
                                {
                                    "type": "agent_trace",
                                    "payload": {
                                        "trace_type": "model_native_thinking",
                                        "node": str(event_payload.get("node") or "decide"),
                                        "content": content,
                                    },
                                }
                            )
                    elif stream_type == "tool_call":
                        stream_stats["agent_traces"] += 1
                        stream_queue.put(
                            {
                                "type": "agent_trace",
                                "payload": {
                                    "trace_type": "tool_call",
                                    "node": str(event_payload.get("node") or "execute_tools"),
                                    "tool_name": event_payload.get("tool_name"),
                                    "status": event_payload.get("status"),
                                    "tool_call_id": event_payload.get("tool_call_id"),
                                    "observation": event_payload.get("observation"),
                                    "query": event_payload.get("query"),
                                },
                            }
                        )
                    continue
                trace_events = trace_reducer.reduce(iter_stream_trace_events(mode, event_payload))
                for trace_event in trace_events:
                    kind = trace_event.get("kind")
                    if kind == "assistant_text":
                        message_id = str(trace_event.get("id") or "")
                        text = str(trace_event.get("text") or "")
                        if not text:
                            continue
                        previous = emitted_text.get(message_id, "")
                        delta = text
                        if message_id and previous and text.startswith(previous):
                            delta = text[len(previous):]
                        if not delta:
                            continue
                        emitted_text[message_id] = previous + delta if message_id else previous
                        stream_stats["assistant_chunks"] += 1
                        emitted_final_text = True
                        stream_queue.put({"type": "delta", "role": "assistant", "delta": delta})
                        continue
                    if kind == "agent_trace":
                        payload_obj = trace_event.get("payload")
                        if isinstance(payload_obj, dict) and payload_obj:
                            trace_type = str(payload_obj.get("trace_type") or "").strip().lower()
                            if trace_type == "tool_call":
                                stream_stats["agent_traces"] += 1
                                stream_queue.put({"type": "agent_trace", "payload": payload_obj})
                            elif trace_type == "model_event":
                                tool_calls = payload_obj.get("tool_calls")
                                if isinstance(tool_calls, list) and tool_calls:
                                    stream_stats["agent_traces"] += 1
                                    stream_queue.put({"type": "agent_trace", "payload": payload_obj})
                        continue
                    if kind == "ag_ui":
                        event_obj = trace_event.get("event")
                        if isinstance(event_obj, dict):
                            stream_stats["ag_ui"] += 1
                            stream_queue.put({"type": "ag_ui", "event": event_obj})
                        continue
                if mode == "updates" and isinstance(event_payload, dict):
                    for node_update in event_payload.values():
                        if not isinstance(node_update, dict):
                            continue
                        messages = node_update.get("messages")
                        if isinstance(messages, list):
                            streamed_messages = messages
                        tool_results_update = node_update.get("tool_results")
                        if isinstance(tool_results_update, list):
                            streamed_tool_results = tool_results_update
            result = {
                "messages": streamed_messages,
                "tool_results": streamed_tool_results,
            }
            final_answer_payload = _resolve_final_answer_payload(result)
            persist_agent_messages(
                db=db_local,
                tenant_id=payload.tenant_id,
                user_id=payload.user_id,
                session_id=session_id,
                result_messages=streamed_messages,
                final_answer_payload=final_answer_payload if isinstance(final_answer_payload, dict) else None,
            )
            final_reply = _extract_final_reply(from_state_messages(streamed_messages))
            if (
                isinstance(final_answer_payload, dict)
                and bool(final_answer_payload.get("used_rag_evidence"))
                and isinstance(final_answer_payload.get("citations"), list)
                and final_answer_payload.get("citations")
            ):
                stream_queue.put(
                    {
                        "type": "assistant_citations",
                        "citations": final_answer_payload.get("citations"),
                        "citation_status": str(final_answer_payload.get("citation_status") or "partial"),
                    }
                )
                stream_queue.put(
                    {
                        "type": "assistant_final",
                        "answer_text": str(final_answer_payload.get("answer_text") or final_reply),
                        "citation_status": str(final_answer_payload.get("citation_status") or "partial"),
                    }
                )
            if final_reply and not emitted_final_text:
                stream_queue.put({"type": "delta", "role": "assistant", "delta": final_reply})
                emitted_final_text = True
            logger.info(
                "agent_run_resume_stream.summary tenant=%s user=%s thread=%s stats=%s final_reply_len=%s",
                payload.tenant_id,
                payload.user_id,
                thread_id,
                stream_stats,
                len(final_reply or ""),
            )
        except Exception:
            logger.exception("agent_run_resume_stream.failed tenant=%s user=%s", payload.tenant_id, payload.user_id)
            stream_queue.put({"type": "error", "message": "agent_runtime_error"})
        finally:
            db_local.close()
            stream_queue.put(None)

    threading.Thread(target=run_resume_thread, daemon=True).start()

    def merged_stream():
        if session_id is not None:
            yield json.dumps(
                {
                    "type": "session",
                    "session_id": session_id,
                    "studio_document_id": payload.studio_document_id,
                    "workroom_id": payload.workroom_id,
                },
                ensure_ascii=False,
            ) + "\n"
        while True:
            item = stream_queue.get()
            if item is None:
                break
            yield json.dumps(item, ensure_ascii=False) + "\n"

    return StreamingResponse(merged_stream(), media_type="text/plain; charset=utf-8")
