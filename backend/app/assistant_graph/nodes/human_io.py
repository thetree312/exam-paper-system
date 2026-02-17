from __future__ import annotations

from langgraph.types import interrupt

from ..runtime import logger
from ..state import AgentState
from ..stream_registry import _get_stream_handler


def _form_to_a2ui_payload(form_spec: dict) -> dict:
    return {
        "protocol": "a2ui",
        "version": "0.8",
        "components": [
            {
                "id": str(form_spec.get("id") or "exercise.batch_config"),
                "type": "form",
                "props": form_spec,
            }
        ],
    }


def _emit_form(state: AgentState, form_spec: dict) -> None:
    handler = _get_stream_handler(state)
    if handler:
        handler({"type": "ag_ui", "event": {"action": "form.show", "payload": {"ui": form_spec}}})
        handler(
            {
                "type": "ag_ui",
                "event": {
                    "action": "a2ui.render",
                    "payload": {"a2ui": _form_to_a2ui_payload(form_spec)},
                },
            }
        )
    else:
        logger.warning(
            "assistant.human_io.no_stream_handler thread=%s session=%s ui_context=%s",
            state.get("thread_id"),
            state.get("session_id"),
            state.get("ui_context"),
        )


def exercise_batch_config_node(state: AgentState) -> AgentState:
    """通过中断表单收集出题配置。

    - 表单结构尽量与旧 batch_config 保持兼容，便于前端直接复用；
    - 收集到的配置写入 exercise_batch_config 字段。
    """

    reason = "配置本次出题的题量、难度和相似度。"

    form_spec = {
        "type": "form",
        "id": "exercise.batch_config",
        "title": "出题配置",
        "description": reason,
        "fields": [
            {
                "id": "count",
                "type": "number",
                "label": "题目数量",
                "min": 1,
                "max": 10,
                "default": 3,
            },
            {
                "id": "difficulty",
                "type": "select",
                "label": "难度",
                "options": [
                    {"value": "easy", "label": "容易"},
                    {"value": "medium", "label": "中等"},
                    {"value": "hard", "label": "较难"},
                ],
                "default": "medium",
            },
            {
                "id": "similarity",
                "type": "select",
                "label": "与原题相似度",
                "options": [
                    {"value": "high", "label": "高"},
                    {"value": "medium", "label": "中"},
                    {"value": "low", "label": "低"},
                ],
                "default": "medium",
            },
        ],
        "submit": {
            "label": "开始出题",
            "actionId": "exercise.batch_config.submit",
        },
    }

    _emit_form(state, form_spec)

    resume_value = interrupt({"kind": "exercise_batch_config", "ui": form_spec})
    logger.info(
        "assistant.human_io.exercise_batch_config.resume tenant=%s session=%s payload_type=%s",
        state.get("tenant_id"),
        state.get("session_id"),
        type(resume_value).__name__,
    )

    if not isinstance(resume_value, dict):
        raise ValueError("Exercise batch config resume payload must be a dict")

    payload = dict(resume_value)

    count_raw = payload.get("count")
    try:
        count_int = int(count_raw)
        if count_int <= 0:
            raise ValueError
    except Exception:
        count_int = None

    if count_int is None:
        raise ValueError("Exercise batch config requires a positive integer count")

    new_state = dict(state)
    new_state["exercise_batch_config"] = payload
    new_state["exercise_need_batch_config"] = False

    return new_state


__all__ = ["exercise_batch_config_node"]
