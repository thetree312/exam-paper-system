from __future__ import annotations

from typing import List

from langgraph.types import interrupt

from ...db import SessionLocal
from ...services.question_type_service import QuestionTypeService
from ..prompts import get_collect_batch_config_prompt
from ..runtime import logger
from ..stream_registry import _get_stream_handler
from ..types import AgentState

REQUIRED_BATCH_FIELDS = ("count", "difficulty", "similarity")

DEFAULT_QUESTION_TYPES = [
    "单选题",
    "多选题",
    "填空题",
    "解答题",
    "判断题",
    "简答题",
]

DIFFICULTY_LABELS = {
    "easy": "容易",
    "medium": "中等",
    "hard": "较难",
}

SIMILARITY_LABELS = {
    "high": "高",
    "medium": "中",
    "low": "低",
}


def _log_subgraph_event(event: str, state: AgentState, **extra: object) -> None:
    logger.info(
        "agent.graph.batch_config.%s thread=%s session=%s details=%s",
        event,
        state.get("thread_id"),
        state.get("session_id"),
        extra or None,
    )


def _require_fields(payload: dict) -> tuple[bool, list[str]]:
    missing = [field for field in REQUIRED_BATCH_FIELDS if payload.get(field) in (None, "")]
    return (not missing, missing)


def _compose_supervisor_instruction(batch_cfg: dict, fallback: str | None = None) -> str:
    count_raw = batch_cfg.get("count")
    try:
        count_int = int(count_raw) if count_raw is not None else None
    except (TypeError, ValueError):
        count_int = None

    count_text = f"{count_int}道" if count_int else ""
    difficulty = DIFFICULTY_LABELS.get(str(batch_cfg.get("difficulty")) or "", batch_cfg.get("difficulty") or "")
    similarity = SIMILARITY_LABELS.get(str(batch_cfg.get("similarity")) or "", batch_cfg.get("similarity") or "")
    question_type = (batch_cfg.get("question_type") or "练习题").strip()

    segments: list[str] = ["请生成"]
    if count_text:
        segments.append(count_text)
    if difficulty:
        segments.append(f"{difficulty}难度")
    if similarity:
        segments.append(f"、与原题{similarity}相似度的")
    else:
        segments.append("的")
    segments.append(question_type)
    core = "".join(segments)
    instruction = f"{core}，并严格遵守批量配置。"

    if not count_text and fallback:
        instruction = f"{fallback}\n{instruction}"
    return instruction


def _increment_epoch(state: AgentState, new_state: AgentState) -> None:
    previous = state.get("batch_config_epoch") or 0
    new_state["batch_config_epoch"] = previous + 1


def _flip_permissions(new_state: AgentState, has_missing_fields: bool) -> None:
    expected = new_state.get("supervisor_expected_new_questions")
    batch_ready = bool(new_state.get("batch_config"))
    allow_tools = (
        not has_missing_fields
        and isinstance(expected, int)
        and expected > 0
        and batch_ready
    )

    new_state["batch_config_required"] = bool(has_missing_fields)
    if not has_missing_fields:
        new_state["batch_config_missing_fields"] = []
        new_state["batch_config_reason"] = None

    previous_allow = bool(new_state.get("supervisor_allow_tools"))
    if allow_tools and not previous_allow:
        new_state["supervisor_allow_tools"] = True

    _log_subgraph_event(
        "permission_update",
        new_state,
        allow_tools=allow_tools,
        previous_allow=previous_allow,
        expected=expected,
        batch_ready=batch_ready,
        has_missing_fields=has_missing_fields,
    )


def _merge_with_defaults(fetched: List[str], defaults: List[str]) -> List[str]:
    fetched_set = {name.strip() for name in fetched if name and name.strip()}
    ordered_defaults = [name for name in defaults if name not in fetched_set]
    return ordered_defaults + sorted(fetched_set)


def _load_question_type_options(tenant_id: int | None) -> List[str]:
    if tenant_id is None:
        return DEFAULT_QUESTION_TYPES[:]

    db = SessionLocal()
    try:
        service = QuestionTypeService(db)
        types = service.get_types(tenant_id)
        names = [t.name for t in types if t and t.name]
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "agent.graph.batch_config.load_question_types_failed tenant=%s error=%s",
            tenant_id,
            exc,
        )
        names = []
    finally:
        db.close()

    merged = _merge_with_defaults(names, DEFAULT_QUESTION_TYPES)
    return merged if merged else DEFAULT_QUESTION_TYPES[:]


def batch_config_node(state: AgentState) -> AgentState:
    _log_subgraph_event("subgraph_start", state)
    handler = _get_stream_handler(state)

    missing_fields = state.get("batch_config_missing_fields") or []
    reason = state.get("batch_config_reason")
    tenant_id = state.get("tenant_id")
    question_type_names = _load_question_type_options(tenant_id if isinstance(tenant_id, int) else None)
    question_type_options = [
        {"value": name, "label": name}
        for name in question_type_names
    ]

    lang = (state.get("preferred_language") or "zh").lower()
    is_en = lang.startswith("en")

    if is_en:
        title = "Batch question settings"
        label_count = "Number of questions"
        label_difficulty = "Difficulty"
        label_similarity = "Similarity to original question"
        label_question_type = "Question type"
        label_reason_other = "Other notes"
        submit_label = "Start generation"
        difficulty_options = [
            {"value": "easy", "label": "Easy"},
            {"value": "medium", "label": "Medium"},
            {"value": "hard", "label": "Hard"},
        ]
        similarity_options = [
            {"value": "high", "label": "High"},
            {"value": "medium", "label": "Medium"},
            {"value": "low", "label": "Low"},
        ]
    else:
        title = "批量出题设置"
        label_count = "题目数量"
        label_difficulty = "难度"
        label_similarity = "与原题相似度"
        label_question_type = "题型"
        label_reason_other = "其他说明"
        submit_label = "开始出题"
        difficulty_options = [
            {"value": "easy", "label": "容易"},
            {"value": "medium", "label": "中等"},
            {"value": "hard", "label": "较难"},
        ]
        similarity_options = [
            {"value": "high", "label": "高"},
            {"value": "medium", "label": "中"},
            {"value": "low", "label": "低"},
        ]

    form_spec = {
        "type": "form",
        "id": "batch-question-config",
        "title": title,
        "meta": {
            "reason": reason,
            "missing_fields": missing_fields,
        },
        "fields": [
            {
                "id": "count",
                "type": "number",
                "label": label_count,
                "min": 1,
                "max": 5,
                "default": 3,
            },
            {
                "id": "difficulty",
                "type": "select",
                "label": label_difficulty,
                "options": difficulty_options,
                "default": "medium",
            },
            {
                "id": "similarity",
                "type": "select",
                "label": label_similarity,
                "options": similarity_options,
                "default": "medium",
            },
            {
                "id": "question_type",
                "type": "select",
                "label": label_question_type,
                "options": question_type_options,
                "placeholder": "选择或输入题型",
                "default": "",
                "allowCustom": True,
            },
            {
                "id": "reason_other",
                "type": "textarea",
                "label": label_reason_other,
            },
        ],
        "submit": {
            "label": submit_label,
            "actionId": "batch-question-config.submit",
        },
        "prompt": get_collect_batch_config_prompt(state.get("preferred_language")),
    }

    _log_subgraph_event(
        "form_prepared",
        state,
        missing=missing_fields,
        reason=reason,
        handler=bool(handler),
    )
    logger.info(
        "agent.graph.batch_config.form_spec tenant=%s session=%s form_spec=%s",
        state.get("tenant_id"),
        state.get("session_id"),
        form_spec,
    )

    if handler:
        handler({"type": "ag_ui", "event": {"action": "form.show", "payload": {"ui": form_spec}}})
    else:
        logger.warning(
            "agent.graph.batch_config.no_stream_handler thread=%s session=%s ui_context=%s",
            state.get("thread_id"),
            state.get("session_id"),
            state.get("ui_context"),
        )

    resume_value = interrupt({"kind": "batch_config", "ui": form_spec})
    logger.info(
        "agent.graph.batch_config.resume_raw tenant=%s session=%s resume_value=%s",
        state.get("tenant_id"),
        state.get("session_id"),
        resume_value,
    )
    payload_keys = list(resume_value.keys()) if isinstance(resume_value, dict) else None
    _log_subgraph_event(
        "resume_payload",
        state,
        payload_type=type(resume_value).__name__,
        payload_keys=payload_keys,
    )

    new_state = dict(state)
    if not isinstance(resume_value, dict):
        new_state["batch_config"] = None
        logger.warning(
            "agent.graph.batch_config.resume_missing thread=%s session=%s resume_type=%s",
            state.get("thread_id"),
            state.get("session_id"),
            type(resume_value).__name__,
        )
        raise ValueError("Batch config resume payload is not a dict")

    question_type_raw = resume_value.get("question_type")
    if isinstance(question_type_raw, str):
        resume_value["question_type"] = question_type_raw.strip() or None
    else:
        resume_value["question_type"] = None

    valid_payload, missing = _require_fields(resume_value)
    if not valid_payload:
        new_state["batch_config"] = None
        new_state["batch_config_missing_fields"] = missing
        logger.warning(
            "agent.graph.batch_config.resume_invalid thread=%s session=%s missing=%s payload_keys=%s",
            state.get("thread_id"),
            state.get("session_id"),
            missing,
            payload_keys,
        )
        raise ValueError(f"Batch config resume payload missing fields: {missing}")

    new_state["batch_config"] = resume_value

    # 同步题量信息，便于后续重新放开工具
    count_raw = resume_value.get("count")
    try:
        count_int = int(count_raw)
        if count_int <= 0:
            raise ValueError
    except Exception:
        count_int = None

    payload = dict(state.get("supervisor_payload") or {})
    payload["batch_config"] = resume_value
    if count_int:
        payload["expected_new_question_count"] = count_int
        new_state["supervisor_expected_new_questions"] = count_int

    fallback_instruction = payload.get("solver_instruction") or state.get("supervisor_directive")
    batch_instruction = _compose_supervisor_instruction(resume_value, fallback_instruction)
    payload["solver_instruction"] = batch_instruction
    new_state["supervisor_directive"] = batch_instruction

    new_state["supervisor_payload"] = payload
    _increment_epoch(state, new_state)
    _log_subgraph_event(
        "resume_ok",
        new_state,
        payload_keys=payload_keys,
        epoch=new_state.get("batch_config_epoch"),
    )
    _flip_permissions(new_state, has_missing_fields=False)

    _log_subgraph_event("subgraph_end", new_state)
    return new_state


__all__ = ["batch_config_node"]
