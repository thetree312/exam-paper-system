from __future__ import annotations

import json
from typing import Any, List

from ..runtime import logger
from ..state import AgentMessageEntry, AgentState
from ..stream_registry import _get_stream_handler, emit_trace_event
from .question_tools import (
    _legend_fingerprint,
    _resolve_legend_source,
    apply_question_state_delta_from_tool_messages,
    get_question_resolver_tool_def,
)
from ..tool_runtime import run_tool_runtime
from ...services.qwen_client import QwenClient


SYSTEM_PROMPT = """你是学生的私人学习助手中的【讲解/解题 Tutor】子代理。

- 面向学生，用中文进行讲解与推导；
- 可以引用系统提供的 doc_context 和 snapshot_items 中的题目/内容；
- 禁止编造题目或文档中不存在的内容；
- 当前仅负责本轮的讲解或简短回答，不要承诺后台出题或修改题库。
- 采用 Agentic 迭代：每轮先判断是否已完成任务，未完成则调用工具继续行动；
- 中间的“计划/行动/反思”仅用于过程事件，不要把中间行动话术当作最终答复。
"""


def _latest_user(dialogue_window: List[AgentMessageEntry]) -> str:
    for msg in reversed(dialogue_window):
        if msg.get("role") == "user":
            return str(msg.get("content") or "")
    return ""


def _build_question_catalog(snapshot_items: list) -> list[dict[str, Any]]:
    """从 snapshot_items 构建题目目录，供模型在工具调用阶段理解“第几题”等引用。

    - 仅提供 question_id / sequence_index / display_index，避免注入完整题面；
    - 不在这里做任何自然语言解析，仅做结构整理。
    """

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


def _collect_focused_questions(
    snapshot_items: list,
    active_ids: list[int],
    *,
    max_active: int,
) -> list[dict[str, Any]]:
    focused: list[dict[str, Any]] = []
    id_set = set()
    for qid in active_ids:
        if len(focused) >= max_active:
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
            focused.append(
                {
                    "id": item.get("id"),
                    "sequence_index": item.get("sequence_index"),
                    "page": item.get("page"),
                    "content": item.get("content"),
                    "legend_images": item.get("legend_images"),
                    "vision_legend_images": item.get("vision_legend_images"),
                }
            )
            id_set.add(q_int)
            break
    return focused


def _find_vision_summary(
    vision_evidence: list,
    *,
    question_id: int,
    legend_fingerprint: str,
) -> str | None:
    for item in vision_evidence or []:
        if not isinstance(item, dict):
            continue
        qids = item.get("question_ids")
        if not isinstance(qids, list) or question_id not in qids:
            continue
        if str(item.get("legend_fingerprint") or "") != legend_fingerprint:
            continue
        summary = str(item.get("summary") or "").strip()
        if summary:
            return summary
    return None


def _summarize_vision(
    *,
    client: QwenClient,
    image_urls: list[str],
    question_text: str,
) -> str | None:
    clean_urls = [str(u).strip() for u in image_urls if str(u).strip()]
    if not clean_urls:
        return None
    content: list[dict[str, Any]] = [
        {"type": "image_url", "image_url": {"url": url}} for url in clean_urls[:2]
    ]
    prompt = "请只描述图片中的关键可见信息（例如图例/示意图/表格/标注），不要解题、不要推断。"
    if question_text:
        prompt = f"题目文本：{question_text}\n{prompt}"
    content.append({"type": "text", "text": prompt})
    try:
        summary, _usage = client.chat([{"role": "user", "content": content}])
    except Exception:  # noqa: BLE001
        logger.exception("assistant.vision_summary.failed")
        return None
    summary = (summary or "").strip()
    return summary or None


def _ensure_vision_evidence(
    *,
    client: QwenClient,
    focused_questions: list[dict[str, Any]],
    vision_evidence: list,
) -> tuple[list, list[dict[str, Any]], set[tuple[int, str]]]:
    updated = list(vision_evidence or [])
    summaries: list[dict[str, Any]] = []
    summary_keys: set[tuple[int, str]] = set()
    for q in focused_questions:
        qid_raw = q.get("id")
        try:
            qid = int(qid_raw)
        except (TypeError, ValueError):
            continue
        raw_legend = _resolve_legend_source(q)
        fingerprint = _legend_fingerprint(raw_legend)
        if fingerprint == "none":
            continue
        summary = _find_vision_summary(updated, question_id=qid, legend_fingerprint=fingerprint)
        if not summary:
            summary = _summarize_vision(
                client=client,
                image_urls=raw_legend,
                question_text=str(q.get("content") or ""),
            )
            if summary:
                updated.append(
                    {
                        "question_ids": [qid],
                        "summary": summary,
                        "legend_fingerprint": fingerprint,
                        "coverage": "full",
                        "confidence": "model",
                    }
                )
        if summary:
            summaries.append(
                {
                    "question_id": qid,
                    "legend_fingerprint": fingerprint,
                    "summary": summary,
                }
            )
            summary_keys.add((qid, fingerprint))
    return updated, summaries, summary_keys


def _apply_focus_tool_calls(
    *,
    tool_calls: List[dict],
    snapshot_items: list,
    active_ids: list[int],
    recent_ids: list[int],
    max_active: int,
    max_recent: int,
) -> tuple[list[int], list[int], List[dict]]:
    """执行纯函数工具 focus_questions：只更新 active/recent，并返回工具结果消息列表。

    - 不在这里做任何 LLM 调用；
    - 工具参数由上游 agent 决定（question_ids / sequence_indices），这里只做结构化映射。"""

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
            logger.warning("assistant.tutor.focus.invalid_tool_args args_preview=%s", str(args_raw)[:200])
            continue

        cand_ids = _normalize_id_list(args.get("question_ids"))
        # 允许通过 sequence_indices / display_indices 间接选择题目。
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

        # 替换工作集为 cand_ids 截断后的结果
        new_active = cand_ids[:max_active]

        # 更新 recent：新 active 在前，后面接原 recent，去重并截断
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

        # 将工具结果作为 tool 消息返回给模型，供下一轮使用
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


def tutor_agent_node(state: AgentState) -> AgentState:
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
    vision_evidence = state.get("vision_evidence") or []

    latest_user_text = _latest_user(dialogue_window)

    max_active = 3
    max_recent = 16

    focused_questions = _collect_focused_questions(
        snapshot_items, active_ids, max_active=max_active
    )
    vision_evidence, vision_summaries, summary_keys = _ensure_vision_evidence(
        client=client,
        focused_questions=focused_questions,
        vision_evidence=vision_evidence,
    )
    context_obj: dict[str, Any] = {
        "latest_user": latest_user_text,
        "dialogue_window": _dialogue_context(dialogue_window),
        "doc_context": doc_context,
        "history_summary": history_summary,
        "hydrated_facts": hydrated_facts,
        "vision_evidence": vision_summaries,
        "question_catalog_mode": "tool_only",
    }

    messages: List[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    # 这里刻意不再重放整个 dialogue_window 中的每条用户请求，
    # 避免把历史多轮指令当作“本轮待处理请求”再次塞给模型。
    #
    # 对 tutor 而言，每次 HTTP 调用只处理本轮 latest_user，
    # 过往对话通过 history_summary / hydrated_facts / active_question_ids 等结构化状态体现。
    messages.append(
        {
            "role": "user",
            "content": "下面是本轮学生请求及题目/文档上下文。请用Agentic方式迭代判断是否完成：若未完成则调用工具；仅在确认完成后输出最终答复。\n"
            + json.dumps(context_obj, ensure_ascii=False),
        }
    )

    tools: List[dict] = [
        {
            "type": "function",
            "function": {
                "name": "focus_questions",
                "description": "根据学生请求选择本轮要重点讲解的题目。若需要‘第N题’映射，可直接配合 resolve_questions 使用 display_indices/sequence_indices。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "question_ids": {
                            "type": "array",
                            "items": {"type": "integer"},
                            "description": "直接给出要聚焦的题目 ID 列表。",
                        },
                        "sequence_indices": {
                            "type": "array",
                            "items": {"type": "integer"},
                            "description": "基于题目顺序的索引，例如第1题可以是0或1。",
                        },
                        "display_indices": {
                            "type": "array",
                            "items": {"type": "integer"},
                            "description": "直接使用题目前的人类可见编号（1,2,3,...）。",
                        },
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
                            "agent": "tutor",
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
                "agent": "tutor",
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

        if round_idx < max_reflection_rounds:
            focused_questions = _collect_focused_questions(
                snapshot_items, active_ids, max_active=max_active
            )
            vision_evidence, vision_summaries, new_keys = _ensure_vision_evidence(
                client=client,
                focused_questions=focused_questions,
                vision_evidence=vision_evidence,
            )
            unseen = [s for s in vision_summaries if (s["question_id"], s["legend_fingerprint"]) not in summary_keys]
            if unseen:
                summary_keys.update(
                    (s["question_id"], s["legend_fingerprint"]) for s in unseen
                )
                messages.append(
                    {
                        "role": "user",
                        "content": "以下是本轮新增的题目图像摘要：\n"
                        + json.dumps(unseen, ensure_ascii=False),
                    }
                )

        emit_trace_event(
            state,
            "tool_feedback",
            {
                "agent": "tutor",
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
                            "agent": "tutor",
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

    # 基于更新后的 active_question_ids 从 snapshot_items 中筛选出本轮需要重点关注的题目，
    # 保证工作集规模为常数级（例如最多 3 道），避免随题目总数线性膨胀。
    focused_questions = _collect_focused_questions(
        snapshot_items, active_ids, max_active=max_active
    )

    # 将最终用于讲解的题目集合也写入日志上下文，便于排查 focus 行为。
    logger.info(
        "assistant.tutor.focus.final active=%s recent=%s focused_count=%s",
        active_ids,
        recent_ids,
        len(focused_questions),
    )

    logger.info(
        "assistant.tutor.reply tenant=%s user=%s usage=%s preview=%s",
        state.get("tenant_id"),
        state.get("user_id"),
        usage,
        reply[:160],
    )

    emit_trace_event(
        state,
        "final",
        {
            "agent": "tutor",
            "reply_preview": reply[:200],
        },
    )

    new_state = dict(state)
    new_state["assistant_reply"] = reply
    new_state["active_question_ids"] = active_ids
    new_state["recent_question_ids"] = recent_ids
    if vision_evidence:
        new_state["vision_evidence"] = vision_evidence
    return new_state


__all__ = ["tutor_agent_node"]
