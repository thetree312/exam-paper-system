from __future__ import annotations

import uuid
from typing import Any, Dict, List

from ...db import SessionLocal
from ...services.agent_service import AgentService
from ...services.similar_question_tool import SimilarQuestionTool
from ..runtime import logger
from ..state import AgentState
from ..stream_registry import _get_stream_handler


def _latest_user_text(state: AgentState) -> str:
    messages = state.get("messages") or []
    for msg in reversed(messages):
        if isinstance(msg, dict) and msg.get("role") == "user":
            return str(msg.get("content") or "")[:200]
    return ""


def _apply_events_to_snapshot(state: AgentState, events: List[Dict[str, Any]]) -> tuple[List[Dict[str, Any]], Dict[str, Any] | None]:
    """根据工具事件更新 snapshot_questions，复用旧架构的语义。

    - question.replace: 替换对应序号的题目内容与版本；
    - question.insert: 在指定序号之后插入新题目。
    """

    updated_snapshot: List[Dict[str, Any]] = [dict(q) for q in (state.get("snapshot_questions") or []) if isinstance(q, dict)]
    latest_replaced: Dict[str, Any] | None = state.get("latest_replaced_question") or None  # type: ignore[assignment]

    for event in events:
        if not isinstance(event, dict):
            continue
        action = event.get("action")
        target = event.get("target") or {}
        payload = event.get("payload") or {}
        seq = target.get("sequenceIndex")

        if action == "question.replace" and isinstance(seq, int) and 0 <= seq < len(updated_snapshot):
            content = payload.get("newContent")
            versions = payload.get("versions")
            try:
                item = updated_snapshot[seq]
                if isinstance(item, dict) and content:
                    item["content"] = content
                    if versions is not None:
                        item["versions"] = versions
            except Exception:  # noqa: BLE001
                logger.warning("assistant.tool_node.snapshot_update_failed seq=%s", seq)
            latest_replaced = {
                "question_id": target.get("questionId"),
                "sequence_index": seq,
                "content": content,
            }

        elif action == "question.insert":
            content = payload.get("content")
            if not content:
                continue
            versions = payload.get("versions")
            insert_index = (
                seq + 1 if isinstance(seq, int) and 0 <= seq < len(updated_snapshot) else len(updated_snapshot)
            )
            updated_snapshot.insert(
                insert_index,
                {
                    "id": target.get("questionId"),
                    "sequence_index": target.get("sequenceIndex"),
                    "group_id": target.get("groupId"),
                    "content": content,
                    "versions": versions or [],
                },
            )

    return updated_snapshot, latest_replaced


def tool_node(state: AgentState) -> AgentState:
    """统一的工具执行节点，目前主要承载 SimilarQuestionTool。

    - 读取 pending_tools 作为计划数组；
    - 调用 SimilarQuestionTool 执行数据库更新；
    - 更新 snapshot_questions 与 ag_ui_events；
    - 写入 tool_execution_report 便于上游总结。"""

    document_id = state.get("document_id")
    if not document_id:
        return state

    raw_plans = state.get("pending_tools") or []
    plans: List[Dict[str, Any]] = [p for p in raw_plans if isinstance(p, dict)]

    if not plans:
        new_state = dict(state)
        new_state["pending_tools"] = []
        new_state["tool_execution_report"] = {
            "status": "skipped",
            "reason": "no_pending_tools",
        }
        return new_state

    run_id = state.get("run_id") or uuid.uuid4().hex
    tenant_id = state.get("tenant_id")

    events: List[Dict[str, Any]] = []
    error: str | None = None

    db = SessionLocal()
    try:
        svc = AgentService(db)
        tool = SimilarQuestionTool(svc)
        events = tool.execute_plans(
            plans=plans,
            tenant_id=tenant_id,
            document_id=document_id,
            run_id=run_id,
            request_label=_latest_user_text(state),
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("assistant.tool_node.failed tenant=%s user=%s", tenant_id, state.get("user_id"))
        error = str(exc)
        events = []
    finally:
        db.close()

    logger.info(
        "assistant.tool_node.events tenant=%s document_id=%s event_count=%s", tenant_id, document_id, len(events)
    )

    updated_snapshot, latest_replaced = _apply_events_to_snapshot(state, events)

    new_state: AgentState = dict(state)
    new_state["snapshot_questions"] = updated_snapshot
    if latest_replaced is not None:
        new_state["latest_replaced_question"] = latest_replaced  # type: ignore[assignment]

    ui_events = list(new_state.get("ag_ui_events") or [])
    ui_events.extend(events)
    new_state["ag_ui_events"] = ui_events

    # 将工具产生的 UI 事件实时推送给前端，保持与旧 tool_exec 节点一致的事件格式。
    handler = _get_stream_handler(state)
    if handler:
        for event in events:
            handler({"type": "ag_ui", "event": event})

    new_state["pending_tools"] = []
    new_state["tool_execution_report"] = {
        "status": "error" if error else "ok",
        "error": error,
        "event_count": len(events),
        "run_id": run_id,
    }

    return new_state


__all__ = ["tool_node"]
