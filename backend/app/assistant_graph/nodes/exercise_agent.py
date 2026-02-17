from __future__ import annotations

import json
from typing import Any, List

from langgraph.types import interrupt

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


SYSTEM_PROMPT = """你是学生的私人学习助手中的【出题/练习 Exercise】子代理。

- 首先理解学生当前的问题与目标；
- 在需要时，规划如何调用题目编辑工具（SimilarQuestionTool）来改写或插入题目；
- 同时给出自然语言说明，向学生解释你打算生成怎样的练习题；
- 工具规划必须通过 JSON 形式的 plans 给出，不要直接修改题库。
- 采用 Agentic 迭代：每轮先判断是否已完成任务，未完成则调用工具继续行动；
- 中间的“计划/行动/反思”仅用于过程事件，不要把中间行动话术当作最终答复。
- 是否需要收集出题配置（题量/难度/相似度）必须由你基于上下文自主推理决定；
- 当用户意图存在歧义、缺少关键约束、或无法稳定生成可执行计划时，应优先通过 similar_question_planner 输出 batch_config_required=true；
- 当 batch_config_required=true 时，plans 应为空或仅保留等待配置的说明，不要输出会直接落库的执行计划。
- 若输出 batch_config_ui，字段必须使用 id（例如 count/difficulty/similarity），不要使用 name。
- similar_question_planner 的 plans 只允许 action=similar_insert，必须输出 questions 数组（包含 stem）。
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


def _default_batch_config_form(reason: str) -> dict[str, Any]:
    return {
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


def _normalize_batch_config_ui(form_spec: dict[str, Any]) -> dict[str, Any]:
    form_ui = dict(form_spec or {})
    fields = form_ui.get("fields")
    if isinstance(fields, list):
        normalized_fields: list[dict[str, Any]] = []
        for field in fields:
            if not isinstance(field, dict):
                continue
            normalized = dict(field)
            raw_id = normalized.get("id")
            if isinstance(raw_id, str):
                field_id = raw_id.strip()
                if field_id:
                    normalized["id"] = field_id
                    normalized_fields.append(normalized)
        form_ui["fields"] = normalized_fields
    if not form_ui.get("type"):
        form_ui["type"] = "form"
    return form_ui


def _form_to_a2ui_payload(form_spec: dict[str, Any]) -> dict[str, Any]:
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


def _emit_batch_config_form(
    state: AgentState,
    reason: str,
    form_spec: dict[str, Any] | None = None,
) -> dict[str, Any]:
    raw_form = form_spec if isinstance(form_spec, dict) else _default_batch_config_form(reason)
    form_ui = _normalize_batch_config_ui(raw_form)
    if not form_ui.get("fields"):
        form_ui = _default_batch_config_form(reason)

    handler = _get_stream_handler(state)
    if handler:
        handler({"type": "ag_ui", "event": {"action": "form.show", "payload": {"ui": form_ui}}})
        handler(
            {
                "type": "ag_ui",
                "event": {
                    "action": "a2ui.render",
                    "payload": {"a2ui": _form_to_a2ui_payload(form_ui)},
                },
            }
        )
    else:
        logger.warning(
            "assistant.exercise_agent.no_stream_handler thread=%s session=%s ui_context=%s",
            state.get("thread_id"),
            state.get("session_id"),
            state.get("ui_context"),
        )
    return form_ui


def _apply_focus_tool_calls(
    *,
    tool_calls: List[dict],
    snapshot_items: list,
    active_ids: list[int],
    recent_ids: list[int],
    max_active: int,
    max_recent: int,
) -> tuple[list[int], list[int], List[dict]]:
    """执行纯函数工具 focus_questions：更新出题工作集 active/recent，并返回工具结果消息列表。"""

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
            logger.warning("assistant.exercise.focus.invalid_tool_args args_preview=%s", str(args_raw)[:200])
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


def _extract_planner_outputs(tool_calls: List[dict]) -> tuple[list[dict], bool, dict | None, dict | None]:
    plans: list[dict] = []
    need_batch_cfg = False
    batch_from_tool: dict | None = None
    batch_ui_from_tool: dict | None = None

    for tc in tool_calls:
        if not isinstance(tc, dict):
            continue
        fn = tc.get("function") or {}
        if fn.get("name") != "similar_question_planner":
            continue
        args_raw = fn.get("arguments") or "{}"
        try:
            args = json.loads(args_raw)
        except Exception:  # noqa: BLE001
            logger.warning("assistant.exercise_agent.invalid_tool_args args_preview=%s", str(args_raw)[:200])
            continue
        raw_plans = args.get("plans") or []
        if isinstance(raw_plans, list):
            for p in raw_plans:
                if isinstance(p, dict):
                    plans.append(p)
        if bool(args.get("batch_config_required")):
            need_batch_cfg = True
        cfg = args.get("batch_config")
        if isinstance(cfg, dict) and cfg:
            batch_from_tool = cfg

        cfg_ui = args.get("batch_config_ui")
        if isinstance(cfg_ui, dict) and cfg_ui:
            batch_ui_from_tool = cfg_ui

    return plans, need_batch_cfg, batch_from_tool, batch_ui_from_tool


def exercise_agent_node(state: AgentState) -> AgentState:
    if state.get("skip_model"):
        return state

    client = QwenClient()

    dialogue_window = state.get("dialogue_window") or []
    doc_context = state.get("doc_context") or ""
    history_summary = state.get("history_summary") or ""
    hydrated_facts = state.get("hydrated_facts") or []
    snapshot_items = state.get("snapshot_items") or []
    batch_cfg = state.get("exercise_batch_config") or {}
    active_ids = _normalize_id_list(state.get("active_question_ids") or [])
    recent_ids = _normalize_id_list(state.get("recent_question_ids") or [])
    vision_evidence = state.get("vision_evidence") or []

    latest_user_text = _latest_user(dialogue_window)

    max_active = 3
    max_recent = 16

    def _build_messages(
        batch_config: dict,
        prior_tool_messages: list[dict],
        vision_summaries: list[dict[str, Any]],
    ) -> list[dict]:
        context_obj: dict[str, Any] = {
            "latest_user": latest_user_text,
            "dialogue_window": _dialogue_context(dialogue_window),
            "doc_context": doc_context,
            "history_summary": history_summary,
            "hydrated_facts": hydrated_facts,
            "vision_evidence": vision_summaries,
            "question_catalog_mode": "tool_only",
            "batch_config": batch_config,
        }
        next_messages: List[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
        next_messages.append(
            {
                "role": "user",
                "content": "请基于以下上下文，用Agentic方式迭代判断是否完成：若未完成则调用工具继续行动；仅在确认完成后输出最终答复。\n"
                + json.dumps(context_obj, ensure_ascii=False),
            }
        )
        if isinstance(prior_tool_messages, list) and prior_tool_messages:
            next_messages.extend(prior_tool_messages)
        return next_messages

    planner_tool_def = {
        "type": "function",
        "function": {
            "name": "similar_question_planner",
            "description": "规划如何调用 SimilarQuestionTool 在原题卡后插入类似题，并给出 plans 数组。若上下文不足以稳定执行，请输出 batch_config_required=true 并暂缓可执行 plans。batch_config_ui 字段必须使用 id（count/difficulty/similarity）。",
            "parameters": {
                "type": "object",
                "properties": {
                    "plans": {
                        "type": "array",
                        "description": "要执行的类似题插入计划列表。",
                        "items": {
                            "type": "object",
                            "properties": {
                                "action": {
                                    "type": "string",
                                    "description": "仅允许 similar_insert。",
                                },
                                "base_question_id": {"type": "integer"},
                                "target_sequence_index": {"type": "integer"},
                                "question_type": {"type": "string"},
                                "questions": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "stem": {"type": "string"},
                                            "options": {"type": "array", "items": {"type": "string"}},
                                            "solution": {"type": "object"},
                                            "metadata": {"type": "object"},
                                        },
                                        "required": ["stem"],
                                    },
                                },
                                "note_source": {"type": "object"},
                            },
                            "required": ["action", "questions"],
                        },
                    },
                    "batch_config_required": {
                        "type": "boolean",
                        "description": "是否需要通过表单补充出题配置。",
                    },
                    "batch_config": {
                        "type": "object",
                        "description": "当模型已确定题量/难度/相似度等配置时，可以在此直接给出。",
                    },
                    "batch_config_ui": {
                        "type": "object",
                        "description": "可选：A2UI 风格的动态表单定义。用于在需要补充配置时由 Agent 给出可渲染 UI。",
                    },
                },
            },
        },
    }

    tools: List[dict] = [
        {
            "type": "function",
            "function": {
                "name": "focus_questions",
                "description": "根据学生请求选择本轮用于出题的依据题目。若需要‘第N题’映射，可直接配合 resolve_questions 使用 display_indices/sequence_indices。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "question_ids": {
                            "type": "array",
                            "items": {"type": "integer"},
                        },
                        "sequence_indices": {
                            "type": "array",
                            "items": {"type": "integer"},
                        },
                        "display_indices": {
                            "type": "array",
                            "items": {"type": "integer"},
                        },
                    },
                },
            },
        },
        get_question_resolver_tool_def(),
        planner_tool_def,
    ]
    planner_only_tools: List[dict] = [planner_tool_def]
    reply = ""
    usage: int | None = None
    plans: List[dict] = []
    need_batch_cfg = False
    batch_from_tool: dict | None = None
    batch_ui_from_tool: dict | None = None
    tool_messages: List[dict] = []
    tool_calls: List[dict] = []
    should_run_full = False
    final_reply = ""
    reflect_done = False

    focused_questions = _collect_focused_questions(
        snapshot_items, active_ids, max_active=max_active
    )
    vision_evidence, vision_summaries, summary_keys = _ensure_vision_evidence(
        client=client,
        focused_questions=focused_questions,
        vision_evidence=vision_evidence,
    )

    if not batch_cfg:
        messages = _build_messages(
            batch_cfg,
            state.get("last_tool_results") or [],
            vision_summaries,
        )
        stream_handler = _get_stream_handler(state)
        stream, result = client.chat_with_tools_stream(
            messages,
            tools=planner_only_tools,
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
                            "agent": "exercise",
                            "round": 0,
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

        plans, need_batch_cfg, batch_from_tool, batch_ui_from_tool = _extract_planner_outputs(tool_calls)
        if need_batch_cfg:
            form_spec = _emit_batch_config_form(
                state,
                "配置本次出题的题量、难度和相似度。",
                form_spec=batch_ui_from_tool,
            )
            resume_value = interrupt({"kind": "exercise_batch_config", "ui": form_spec})
            logger.info(
                "assistant.exercise_agent.batch_config.resume tenant=%s session=%s payload_type=%s",
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
            batch_cfg = payload
            need_batch_cfg = False
            should_run_full = True
        elif batch_from_tool:
            batch_cfg = batch_from_tool
            should_run_full = True
        else:
            should_run_full = True
    else:
        should_run_full = True

    if should_run_full:
        messages = _build_messages(
            batch_cfg,
            state.get("last_tool_results") or [],
            vision_summaries,
        )

    max_reflection_rounds = 3
    for round_idx in range(1, max_reflection_rounds + 1):
        if not should_run_full:
            break
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
                            "agent": "exercise",
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

        round_plans, round_need_cfg, round_batch_cfg, round_batch_ui = _extract_planner_outputs(tool_calls)
        plans.extend(round_plans)
        if round_need_cfg:
            need_batch_cfg = True
        if round_batch_cfg:
            batch_from_tool = round_batch_cfg
        if round_batch_ui:
            batch_ui_from_tool = round_batch_ui

        if not tool_calls:
            emit_trace_event(
                state,
                "self_reflect",
                {
                    "agent": "exercise",
                    "round": round_idx,
                    "status": "done",
                    "reason": "模型判定任务已完成。",
                },
            )
            final_reply = reply
            reflect_done = True
            break

        emit_trace_event(
            state,
            "action",
            {
                "agent": "exercise",
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
            include_planner=True,
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
            unseen = [
                s
                for s in vision_summaries
                if (s["question_id"], s["legend_fingerprint"]) not in summary_keys
            ]
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
                "agent": "exercise",
                "round": round_idx,
                "tool_message_count": len(tool_messages),
                "plan_count": len(plans),
                "active_question_ids": active_ids,
                "recent_question_ids": recent_ids,
            },
        )
        emit_trace_event(
            state,
            "self_reflect",
            {
                "agent": "exercise",
                "round": round_idx,
                "status": "need_action",
                "reason": decision_excerpt or "模型仍判定需下一轮行动。",
            },
        )
        if round_idx == max_reflection_rounds:
            emit_trace_event(
                state,
                "self_reflect",
                {
                    "agent": "exercise",
                    "round": round_idx,
                    "status": "done",
                    "reason": "达到最大反思轮次，基于现有证据收敛输出。",
                },
            )
            final_reply = reply
            reflect_done = True
            break

    if not final_reply:
        final_reply = reply
    if not reflect_done:
        emit_trace_event(
            state,
            "self_reflect",
            {
                "agent": "exercise",
                "round": max_reflection_rounds,
                "status": "done",
                "reason": "流程结束，基于现有证据收敛输出。",
            },
        )

    logger.info(
        "assistant.exercise_agent.tool_calls tenant=%s user=%s usage=%s plan_count=%s need_batch_cfg=%s",
        state.get("tenant_id"),
        state.get("user_id"),
        usage,
        len(plans),
        need_batch_cfg,
    )

    emit_trace_event(
        state,
        "final",
        {
            "agent": "exercise",
            "reply_preview": final_reply[:200],
            "plan_count": len(plans),
        },
    )

    new_state = dict(state)
    new_state["assistant_reply"] = final_reply or reply
    new_state["exercise_plan"] = plans[-1] if plans else None
    new_state["pending_tools"] = plans
    new_state["exercise_need_batch_config"] = need_batch_cfg
    new_state["exercise_batch_config"] = batch_cfg or {}
    new_state["active_question_ids"] = active_ids
    new_state["recent_question_ids"] = recent_ids
    if vision_evidence:
        new_state["vision_evidence"] = vision_evidence
    return new_state


__all__ = ["exercise_agent_node"]
