from __future__ import annotations

import json
from typing import Any, List

from ..runtime import logger
from ..state import AgentMessageEntry, AgentState
from ..stream_registry import _get_stream_handler, emit_trace_event
from .question_tools import (
    apply_question_state_delta_from_tool_messages,
    get_question_resolver_tool_def,
)
from ..tool_runtime import run_tool_runtime
from ...services.qwen_client import QwenClient


SYSTEM_PROMPT = """你是学生的私人学习助手中的【检索 Search】子代理。

- 基于学生的问题和当前文档上下文，给出知识性的解释、定理、例子等；
- 当前实现不访问外部互联网，只基于已有上下文与通用知识回答。
- 采用 Agentic 迭代：每轮先判断是否已完成任务，未完成则调用工具继续行动；
- 中间的“计划/行动/反思”仅用于过程事件，不要把中间行动话术当作最终答复。
"""


def _latest_user(dialogue_window: List[AgentMessageEntry]) -> str:
    for msg in reversed(dialogue_window):
        if msg.get("role") == "user":
            return str(msg.get("content") or "")
    return ""


def _build_question_catalog(snapshot_items: list) -> list[dict[str, Any]]:
    """从 snapshot_items 构建题目目录，供模型在工具调用阶段理解“第几题”等引用。"""

    catalog: list[dict[str, Any]] = []
    for item in snapshot_items or []:
        if not isinstance(item, dict):
            continue
        if item.get("type") != "question":
            continue
        try:
            qid = int(item.get("id"))
        except (TypeError, ValueError):
            continue
        seq_raw = item.get("sequence_index")
        try:
            seq_int = int(seq_raw) if seq_raw is not None else None
        except (TypeError, ValueError):
            seq_int = None
        entry: dict[str, Any] = {"question_id": qid}
        if seq_int is not None:
            entry["sequence_index"] = seq_int
            entry["display_index"] = seq_int + 1
        catalog.append(entry)
    return catalog


def _normalize_id_list(raw: Any) -> list[int]:
    ids: list[int] = []
    if not isinstance(raw, list):
        return ids
    for v in raw:
        try:
            qid = int(v)
        except (TypeError, ValueError):
            continue
        if qid not in ids:
            ids.append(qid)
    return ids


def _dialogue_context(dialogue_window: List[AgentMessageEntry]) -> list[dict[str, str]]:
    """Convert dialogue_window to compact structured context (not replay turns)."""

    context: list[dict[str, str]] = []
    for m in dialogue_window:
        if not isinstance(m, dict):
            continue
        role = str(m.get("role") or "").strip().lower()
        if role not in ("user", "assistant"):
            continue
        content = str(m.get("content") or "").strip()
        if not content:
            continue
        context.append({"role": role, "content": content})
    return context


def _apply_focus_tool_calls(
    *,
    tool_calls: List[dict],
    snapshot_items: list,
    active_ids: list[int],
    recent_ids: list[int],
    max_active: int,
    max_recent: int,
) -> tuple[list[int], list[int], List[dict]]:
    """执行纯函数工具 focus_questions：更新检索场景的 active/recent，并返回工具结果消息列表。"""

    catalog = _build_question_catalog(snapshot_items)
    id_from_seq: dict[int, int] = {}
    for entry in catalog:
        qid = entry.get("question_id")
        seq = entry.get("sequence_index")
        if isinstance(qid, int) and isinstance(seq, int):
            id_from_seq[seq] = qid

    new_active = list(active_ids)
    new_recent = list(recent_ids)
    tool_messages: List[dict] = []

    for tc in tool_calls:
        if not isinstance(tc, dict):
            continue
        fn = tc.get("function") or {}
        name = fn.get("name")
        if name != "focus_questions":
            continue
        args_raw = fn.get("arguments") or "{}"
        try:
            args = json.loads(args_raw)
        except Exception:  # noqa: BLE001
            logger.warning("assistant.search.focus.invalid_tool_args args_preview=%s", str(args_raw)[:200])
            continue

        cand_ids = _normalize_id_list(args.get("question_ids"))
        seq_list: list[int] = []
        for key in ("sequence_indices", "display_indices"):
            raw = args.get(key)
            if not isinstance(raw, list):
                continue
            for v in raw:
                try:
                    seq_int = int(v)
                except (TypeError, ValueError):
                    continue
                seq_list.append(seq_int)

        if seq_list:
            seq_values = _normalize_id_list(args.get("sequence_indices"))
            display_values = _normalize_id_list(args.get("display_indices"))
            for seq in seq_values:
                qid = id_from_seq.get(seq)
                if isinstance(qid, int) and qid not in cand_ids:
                    cand_ids.append(qid)
            for display_idx in display_values:
                qid = id_from_seq.get(display_idx - 1)
                if isinstance(qid, int) and qid not in cand_ids:
                    cand_ids.append(qid)

        if not cand_ids:
            continue

        new_active = cand_ids[:max_active]

        merged: list[int] = []
        for qid in new_active:
            if qid not in merged:
                merged.append(qid)
        for qid in new_recent:
            if qid not in merged:
                merged.append(qid)
            if len(merged) >= max_recent:
                break
        new_recent = merged

        tool_messages.append(
            {
                "role": "tool",
                "tool_call_id": tc.get("id"),
                "name": name,
                "content": json.dumps(
                    {
                        "active_question_ids": new_active,
                        "recent_question_ids": new_recent,
                    },
                    ensure_ascii=False,
                ),
            }
        )

    return new_active, new_recent, tool_messages


def search_agent_node(state: AgentState) -> AgentState:
    if state.get("skip_model"):
        return state

    client = QwenClient()

    dialogue_window = state.get("dialogue_window") or []
    doc_context = state.get("doc_context") or ""
    history_summary = state.get("history_summary") or ""
    hydrated_facts = state.get("hydrated_facts") or []
    snapshot_items = state.get("snapshot_items") or []
    active_ids = _normalize_id_list(state.get("active_question_ids") or [])
    recent_ids = _normalize_id_list(state.get("recent_question_ids") or [])

    latest_user_text = _latest_user(dialogue_window)

    max_active = 3
    max_recent = 16

    context_obj: dict[str, Any] = {
        "latest_user": latest_user_text,
        "dialogue_window": _dialogue_context(dialogue_window),
        "doc_context": doc_context,
        "history_summary": history_summary,
        "hydrated_facts": hydrated_facts,
        "question_catalog_mode": "tool_only",
    }

    messages: List[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages.append(
        {
            "role": "user",
            "content": "请结合下面的上下文，用Agentic方式迭代判断是否完成：若未完成则调用工具继续行动；仅在确认完成后输出最终答复。\n"
            + json.dumps(context_obj, ensure_ascii=False),
        }
    )

    tools: List[dict] = [
        {
            "type": "function",
            "function": {
                "name": "focus_questions",
                "description": "选择本轮需要重点参考的题目。若需要‘第N题’映射，可直接配合 resolve_questions 使用 display_indices/sequence_indices。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "question_ids": {"type": "array", "items": {"type": "integer"}},
                        "sequence_indices": {"type": "array", "items": {"type": "integer"}},
                        "display_indices": {"type": "array", "items": {"type": "integer"}},
                    },
                },
            },
        },
        get_question_resolver_tool_def(),
    ]
    reply = ""
    usage: int | None = None
    max_reflection_rounds = 3
    for round_idx in range(1, max_reflection_rounds + 1):
        stream_handler = _get_stream_handler(state)
        stream, result = client.chat_with_tools_stream(
            messages,
            tools=tools,
            tool_choice="auto",
            return_events=True,
        )
        for event in stream:
            if isinstance(event, dict):
                if event.get("type") == "thinking":
                    emit_trace_event(
                        state,
                        "thought",
                        {
                            "agent": "search",
                            "round": round_idx,
                            "text": event.get("content"),
                            "append": True,
                        },
                    )
                    continue
                if event.get("type") == "delta":
                    delta_text = event.get("content")
                    if stream_handler and delta_text:
                        stream_handler({"type": "delta", "role": "assistant", "delta": delta_text})
                    continue
            if stream_handler and event:
                stream_handler({"type": "delta", "role": "assistant", "delta": event})
        reply_parts = result.get("content_parts") or []
        reply = "".join(str(part) for part in reply_parts)
        tool_calls = result.get("tool_calls") or []
        usage = result.get("usage")
        decision_excerpt = (reply or "").strip().replace("\n", " ")[:180]

        if not tool_calls:
            break

        emit_trace_event(
            state,
            "action",
            {
                "agent": "search",
                "round": round_idx,
                "tool_names": [
                    (tc.get("function") or {}).get("name")
                    for tc in tool_calls
                    if isinstance(tc, dict)
                ],
                "reason": decision_excerpt,
            },
        )

        messages.append(
            {
                "role": "assistant",
                "content": reply or "",
                "tool_calls": tool_calls,
            }
        )

        runtime_result = run_tool_runtime(
            state=state,
            tool_calls=tool_calls,
            active_ids=active_ids,
            recent_ids=recent_ids,
            max_active=max_active,
            max_recent=max_recent,
            focus_handler=_apply_focus_tool_calls,
        )
        tool_messages = runtime_result.tool_messages
        active_ids = runtime_result.active_ids
        recent_ids = runtime_result.recent_ids

        if tool_messages:
            messages.extend(tool_messages)

        active_ids, recent_ids = apply_question_state_delta_from_tool_messages(
            tool_messages=tool_messages,
            active_ids=active_ids,
            recent_ids=recent_ids,
            max_active=max_active,
            max_recent=max_recent,
        )

        emit_trace_event(
            state,
            "tool_feedback",
            {
                "agent": "search",
                "round": round_idx,
                "tool_message_count": len(tool_messages),
                "active_question_ids": active_ids,
                "recent_question_ids": recent_ids,
            },
        )
        if round_idx == max_reflection_rounds:
            stream_handler = _get_stream_handler(state)
            reply_parts: list[str] = []
            for event in client.chat_stream(messages, return_events=True):
                if isinstance(event, dict) and event.get("type") == "thinking":
                    emit_trace_event(
                        state,
                        "thought",
                        {
                            "agent": "search",
                            "round": round_idx,
                            "text": event.get("content"),
                            "append": True,
                        },
                    )
                    continue
                if isinstance(event, dict) and event.get("type") == "delta":
                    delta_text = event.get("content")
                    if isinstance(delta_text, str):
                        reply_parts.append(delta_text)
                        if stream_handler and delta_text:
                            stream_handler({"type": "delta", "role": "assistant", "delta": delta_text})
                    continue
                if isinstance(event, str) and event:
                    reply_parts.append(event)
                    if stream_handler:
                        stream_handler({"type": "delta", "role": "assistant", "delta": event})
            reply = "".join(reply_parts)
            usage = client.last_usage_total_tokens

    # 将最终用于检索解释的题目集合也写入日志，便于排查 focus 行为。
    focused_questions: list[dict[str, Any]] = []
    id_set = set()
    for qid in active_ids:
        if len(focused_questions) >= max_active:
            break
        try:
            q_int = int(qid)
        except (TypeError, ValueError):
            continue
        if q_int in id_set:
            continue
        for item in snapshot_items:
            if item.get("type") != "question":
                continue
            if int(item.get("id") or -1) != q_int:
                continue
            focused_questions.append(
                {
                    "id": item.get("id"),
                    "sequence_index": item.get("sequence_index"),
                    "page": item.get("page"),
                    "content": item.get("content"),
                    "legend_images": item.get("legend_images"),
                }
            )
            id_set.add(q_int)
            break

    logger.info(
        "assistant.search.focus.final active=%s recent=%s focused_count=%s",
        active_ids,
        recent_ids,
        len(focused_questions),
    )

    logger.info(
        "assistant.search.reply tenant=%s user=%s usage=%s preview=%s",
        state.get("tenant_id"),
        state.get("user_id"),
        usage,
        reply[:160],
    )

    emit_trace_event(
        state,
        "final",
        {
            "agent": "search",
            "reply_preview": reply[:200],
        },
    )

    new_state = dict(state)
    new_state["assistant_reply"] = reply
    new_state["active_question_ids"] = active_ids
    new_state["recent_question_ids"] = recent_ids
    return new_state


__all__ = ["search_agent_node"]
