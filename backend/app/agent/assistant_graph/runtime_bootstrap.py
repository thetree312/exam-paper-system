from __future__ import annotations

import atexit
import json
import logging
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import ExitStack
from typing import Any, Callable, Literal, TypedDict

from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt
from typing_extensions import Annotated

from ...config import get_settings
from ...services.qwen_client import QwenClient, QwenRequestError
from .adapters.message_adapter import (
    build_continuity_prompt as _build_continuity_prompt,
    dedupe_preserve_order as _dedupe_preserve_order,
    latest_tool_observation_summary as _latest_tool_observation_summary,
    latest_user_query as _latest_user_query,
    normalize_messages as _normalize_messages,
    sanitize_tool_content_for_history as _sanitize_tool_content_for_history,
    strip_meta_system_messages as _strip_meta_system_messages,
)
from .llm_tools import (
    build_tool_schemas,
    execute_tool_call,
    parse_tool_arguments,
    tool_result_to_trace as _tool_result_to_trace,
)
from .router_runtime import (
    build_runtime_snapshot as _build_runtime_snapshot,
    compact_short_term_messages as _compact_short_term_messages,
    evolve_runtime_snapshot as _evolve_runtime_snapshot,
    normalize_stream_event as _normalize_stream_event,
)
from .world_model import (
    init_world_model as _init_world_model,
    observe_environment as _observe_environment,
    query_world_model as _query_world_model,
    record_tool_result as _record_tool_result,
    record_user_input as _record_user_input,
)

logger = logging.getLogger("agent.graph")

_SHORT_TERM_ROUNDS = 12
_A2UI_PROTOCOL_VERSION = "0.9"
_META_TOOL_QUERY_ENV = "query_environment_model"
_META_TOOL_REQUEST_CLARIFICATION = "request_user_clarification"
_AGENT_POLICY_TEXT = (
    "你是嵌入网页工作区中的学习教练型智能体。"
    "你的职责是围绕用户当前问题，在当前网页环境中观察、定位对象、读取证据并给出帮助。"
    "可以调用提供的工具；禁止虚构事实、证据或工具。"
    "不确定时直接说明不确定，必要时再向用户提问。"
    "输出语言必须与最新用户消息一致。"
)


def _build_world_priors() -> dict[str, Any]:
    return {
        "scene": "workroom",
        "surfaces": ["knowledge_base", "studio", "agent_panel", "favorites"],
        "relations": [
            "studio对象可引用knowledge_base证据",
            "agent_panel负责决策与工具调用，不直接创造证据",
            "favorites是可复用对象池，可映射进入studio",
        ],
        "invariants": [
            "回答必须可追溯到证据来源",
            "目标未唯一解析时先澄清或继续查询",
            "环境详情按需查询，不一次性注入",
        ],
    }


def _append_list(existing: list | None, new_items: list | None) -> list:
    out = list(existing or [])
    if new_items:
        out.extend(new_items)
    return out


def _append_messages(
    existing: list[dict[str, Any]] | None,
    incoming: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    out = list(existing or [])
    if incoming:
        out.extend(incoming)
    return out


def _preview_text(value: Any, *, limit: int = 220) -> str:
    text = str(value or "").replace("\r", " ").replace("\n", " ").strip()
    if len(text) <= limit:
        return text
    return text[:limit] + f"...[truncated {len(text) - limit} chars]"


def _summarize_messages_for_log(messages: list[dict[str, Any]] | None, *, limit: int = 8) -> list[dict[str, Any]]:
    summary: list[dict[str, Any]] = []
    for item in list(messages or [])[:limit]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip().lower()
        content = item.get("content")
        tool_calls = item.get("tool_calls") if isinstance(item.get("tool_calls"), list) else []
        if isinstance(content, str):
            preview = _preview_text(content, limit=160)
        elif isinstance(content, list):
            preview = f"<list:{len(content)}>"
        elif isinstance(content, dict):
            preview = f"<dict:{','.join(list(content.keys())[:6])}>"
        else:
            preview = f"<{type(content).__name__}>"
        summary.append(
            {
                "role": role,
                "preview": preview,
                "tool_calls": [
                    str(((call.get("function") or {}).get("name") if isinstance(call, dict) else "" ) or "")
                    for call in tool_calls[:4]
                ],
            }
        )
    return summary


def _summarize_observation_packet_for_log(packet: dict[str, Any] | None) -> dict[str, Any]:
    packet = packet if isinstance(packet, dict) else {}
    studio = packet.get("studio") if isinstance(packet.get("studio"), dict) else {}
    kb = packet.get("knowledge_base") if isinstance(packet.get("knowledge_base"), dict) else {}
    latest_tool = packet.get("latest_tool_observation") if isinstance(packet.get("latest_tool_observation"), dict) else {}
    resource_summary = studio.get("resource_summary") if isinstance(studio.get("resource_summary"), dict) else {}
    world_model = packet.get("world_model") if isinstance(packet.get("world_model"), dict) else {}
    focus = world_model.get("focus") if isinstance(world_model.get("focus"), dict) else {}
    return {
        "studio_document_id": studio.get("studio_document_id"),
        "studio_view": studio.get("studio_view"),
        "resource_summary": {
            "question_card_count": int(resource_summary.get("question_card_count") or 0),
            "flashcard_count": int(resource_summary.get("flashcard_count") or 0),
            "mindmap_node_count": int(resource_summary.get("mindmap_node_count") or 0),
            "ocr_item_count": int(resource_summary.get("ocr_item_count") or 0),
        },
        "kb_source_count": int(kb.get("source_count") or 0),
        "latest_tool": {
            "tool_name": latest_tool.get("tool_name"),
            "status": latest_tool.get("status"),
            "summary": latest_tool.get("summary"),
        },
        "world_focus": {
            "primary_surface": focus.get("primary_surface"),
            "primary_object": focus.get("primary_object"),
        },
    }


class GraphState(TypedDict, total=False):
    context: dict[str, Any]
    messages: list[dict[str, Any]]
    model_messages: list[dict[str, Any]]
    transient_tool_messages: list[dict[str, Any]]
    tool_results: Annotated[list[dict[str, Any]], _append_list]
    recent_changes: Annotated[list[dict[str, Any]], _append_list]
    ag_ui_events: Annotated[list[dict[str, Any]], _append_list]
    runtime_snapshot: dict[str, Any]
    task_phase: str
    step_count: int
    observation_packet: dict[str, Any] | None
    world_model: dict[str, Any]
    policy_raw: str | None
    goal_anchor: str | None
    action_journal: Annotated[list[dict[str, Any]], _append_list]
    halt_reason: str | None
    interrupt_payload: dict[str, Any] | None
    last_error: str | None
    short_term_rounds: int
    short_term_summary: str | None
    model_native_traces: Annotated[list[dict[str, Any]], _append_list]
    thinking_chain_id: str | None
    thinking_accumulator: str | None
    planning_packet: dict[str, Any] | None
    reflection_packet: dict[str, Any] | None
    last_model_decision: dict[str, Any] | None
    model_turn: dict[str, Any] | None


def _extract_goal_anchor(messages: list[dict[str, Any]] | None) -> str:
    latest = _latest_user_query(messages)
    return str(latest or "").strip()


def _build_observation_packet(state: GraphState, *, context: dict[str, Any]) -> dict[str, Any]:
    runtime_snapshot = state.get("runtime_snapshot") or _build_runtime_snapshot(context)
    recent_changes = list(state.get("recent_changes") or [])
    latest_tool = {}
    for change in reversed(recent_changes):
        if not isinstance(change, dict):
            continue
        if str(change.get("change_type") or "").strip().lower() in {"tool_result", "tool_error"}:
            latest_tool = {
                "tool_name": change.get("tool_name"),
                "status": change.get("status"),
                "summary": change.get("summary"),
                "query": change.get("query"),
                "source_refs": change.get("source_refs") or [],
                "feedback": change.get("feedback") if isinstance(change.get("feedback"), dict) else {},
            }
            break
    world_model = state.get("world_model") if isinstance(state.get("world_model"), dict) else {}
    env = context.get("environment") if isinstance(context.get("environment"), dict) else {}
    surfaces = env.get("surfaces") if isinstance(env.get("surfaces"), dict) else {}
    kb_surface = surfaces.get("knowledge_base") if isinstance(surfaces.get("knowledge_base"), dict) else {}
    studio_surface = surfaces.get("studio") if isinstance(surfaces.get("studio"), dict) else {}
    favorites_surface = surfaces.get("favorites") if isinstance(surfaces.get("favorites"), dict) else {}
    source_ids = list(kb_surface.get("source_file_ids") or context.get("source_file_ids") or [])
    packet = {
        "studio": {
            "studio_document_id": studio_surface.get("studio_document_id", context.get("studio_document_id")),
            "ui_context": context.get("ui_context"),
            "studio_view": studio_surface.get("studio_view"),
            "resource_summary": studio_surface.get("resource_summary") if isinstance(studio_surface.get("resource_summary"), dict) else {},
        },
        "knowledge_base": {
            "source_file_ids": source_ids,
            "source_count": int(kb_surface.get("source_count") or len(source_ids)),
        },
        "favorites": {
            "favorite_question_count": int(favorites_surface.get("favorite_question_count") or 0),
        },
        "task": {
            "phase": state.get("task_phase") or "observing",
            "step_count": int(state.get("step_count") or 0),
            "goal_anchor": state.get("goal_anchor") or "",
        },
        "latest_tool_observation": latest_tool,
        "world_model": world_model,
        "runtime_snapshot": runtime_snapshot,
    }
    logger.info("agent.observe packet=%s", _summarize_observation_packet_for_log(packet))
    return packet


def _build_model_snapshot(
    *,
    state: GraphState,
    observation_packet: dict[str, Any],
    memory_summary: str,
) -> str:
    studio = observation_packet.get("studio") if isinstance(observation_packet.get("studio"), dict) else {}
    kb = observation_packet.get("knowledge_base") if isinstance(observation_packet.get("knowledge_base"), dict) else {}
    world_model = observation_packet.get("world_model") if isinstance(observation_packet.get("world_model"), dict) else {}
    world_focus = world_model.get("focus") if isinstance(world_model.get("focus"), dict) else {}
    resource_summary = studio.get("resource_summary") if isinstance(studio.get("resource_summary"), dict) else {}
    source_file_ids = list(kb.get("source_file_ids") or [])
    lines = [
        "[环境前景上下文]",
        f"surface={str(world_focus.get('primary_surface') or studio.get('ui_context') or 'unknown')}",
        f"focus={str(world_focus.get('primary_object') or 'none')}",
        f"studio_document_id={str(studio.get('studio_document_id') or 'none')}",
        f"studio_view={str(studio.get('studio_view') or 'unknown')}",
        (
            "studio_resources="
            f"question_cards:{int(resource_summary.get('question_card_count') or 0)},"
            f"flashcards:{int(resource_summary.get('flashcard_count') or 0)},"
            f"mindmap_nodes:{int(resource_summary.get('mindmap_node_count') or 0)},"
            f"ocr_items:{int(resource_summary.get('ocr_item_count') or 0)}"
        ),
        f"knowledge_base_source_count={int(kb.get('source_count') or 0)}",
    ]
    if source_file_ids:
        lines.append("knowledge_base_source_ids=" + ",".join(str(item) for item in source_file_ids[:8]))
    memory_preview = memory_summary[:120].strip() if memory_summary else ""
    if memory_preview:
        lines.append("memory=" + memory_preview)
    return "\n".join(lines)


def _build_interrupt_payload(
    prompt: str,
    *,
    form_fields: list[dict[str, Any]] | None = None,
    a2ui_protocol: dict[str, Any] | None = None,
) -> dict[str, Any]:
    interrupt_id = f"intr-{uuid.uuid4().hex}"
    prompt_text = str(prompt).strip()
    if not prompt_text:
        raise ValueError("interrupt_payload_error: empty_prompt")
    normalized_fields = form_fields if isinstance(form_fields, list) and form_fields else []
    if not isinstance(a2ui_protocol, dict):
        if not normalized_fields:
            raise ValueError("interrupt_payload_error: missing_a2ui_protocol_and_fields")
        a2ui_action_payload = {
            "type": "agent_to_client_actions",
            "actions": [
                {
                    "id": "ask_user_form",
                    "payload": {
                        "kind": "form_request",
                        "interrupt_id": interrupt_id,
                        "prompt": prompt_text,
                        "fields": normalized_fields,
                        "submit_action": {"name": "ask_user.submit"},
                    },
                    "status": "completed",
                }
            ],
        }
    else:
        a2ui_action_payload = a2ui_protocol
    return {
        "interrupt_id": interrupt_id,
        "prompt": prompt_text,
        "a2ui_protocol": a2ui_action_payload,
        "a2ui_messages": [
            {
                "messageId": f"ask-user-{interrupt_id}",
                "role": "agent",
                "parts": [
                    {"kind": "text", "text": prompt_text},
                    {
                        "kind": "data",
                        "mimeType": f"application/vnd.a2ui+json;version={_A2UI_PROTOCOL_VERSION}",
                        "data": a2ui_action_payload,
                    },
                ],
            }
        ],
    }


def _all_decision_tool_schemas() -> list[dict[str, Any]]:
    external = list(build_tool_schemas())
    meta: list[dict[str, Any]] = [
        {
            "type": "function",
            "function": {
                "name": _META_TOOL_QUERY_ENV,
                "description": "按路径查询当前环境与世界模型。在行动不确定前优先查询。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "点路径，例如 observation_packet.knowledge_base"},
                        "tail": {"type": "integer", "minimum": 1, "maximum": 20},
                    },
                    "additionalProperties": False,
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": _META_TOOL_REQUEST_CLARIFICATION,
                "description": "当缺失关键约束时，向用户发起澄清中断。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "prompt": {"type": "string"},
                        "fields": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": {"type": "string"},
                                    "label": {"type": "string"},
                                    "type": {"type": "string"},
                                    "required": {"type": "boolean"},
                                },
                                "required": ["name", "label"],
                                "additionalProperties": False,
                            },
                        },
                        "a2ui_protocol": {"type": "object"},
                    },
                    "required": ["prompt"],
                    "additionalProperties": False,
                },
            },
        },
    ]
    return [*external, *meta]


def _execute_meta_tool(
    *,
    tool_name: str,
    tool_arguments: dict[str, Any],
    state_snapshot: dict[str, Any],
) -> dict[str, Any]:
    if tool_name == _META_TOOL_QUERY_ENV:
        path = str(tool_arguments.get("path") or "").strip()
        logger.info("agent.meta.query_env request path=%s args=%s", path or "<root>", tool_arguments)
        if "tail" not in tool_arguments:
            return {"error": "invalid_meta_args", "feedback": {"status": "error", "message": "query_environment_model 缺少 tail"}}
        tail = int(tool_arguments.get("tail"))
        if tail < 1:
            return {"error": "invalid_meta_args", "feedback": {"status": "error", "message": "tail 必须 >= 1"}}
        if tail > 20:
            return {"error": "invalid_meta_args", "feedback": {"status": "error", "message": "tail 必须 <= 20"}}
        root_view = {
            "world_model": _query_world_model(
                state_snapshot.get("world_model") if isinstance(state_snapshot.get("world_model"), dict) else {},
                path="",
                tail=tail,
            ),
            "observation_packet": state_snapshot.get("observation_packet") or {},
            "recent_changes": list(state_snapshot.get("recent_changes") or [])[-tail:],
            "action_journal": list(state_snapshot.get("action_journal") or [])[-tail:],
        }
        if path:
            cursor: Any = root_view
            for seg in [x for x in str(path).split(".") if x]:
                if not isinstance(cursor, dict):
                    cursor = None
                    break
                cursor = cursor.get(seg)
            payload = cursor
        else:
            payload = root_view
        logger.info(
            "agent.meta.query_env response path=%s payload_type=%s payload_preview=%s",
            path or "<root>",
            type(payload).__name__,
            _preview_text(payload, limit=320),
        )
        return {
            "feedback": {"status": "ok", "message": f"已查询环境模型路径：{path or '<根路径>'}"},
            "model_message_content": {"path": path or "<根路径>", "payload": payload},
        }
    if tool_name == _META_TOOL_REQUEST_CLARIFICATION:
        prompt = str(tool_arguments.get("prompt") or "").strip()
        logger.info("agent.meta.request_clarification prompt=%s args=%s", _preview_text(prompt), tool_arguments)
        protocol_obj = tool_arguments.get("a2ui_protocol") if isinstance(tool_arguments.get("a2ui_protocol"), dict) else None
        fields_raw = tool_arguments.get("fields") if isinstance(tool_arguments.get("fields"), list) else []
        fields: list[dict[str, Any]] = []
        for item in fields_raw:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()
            label = str(item.get("label") or "").strip()
            if not name or not label:
                continue
            fields.append(
                {
                    "name": name,
                    "label": label,
                    "type": str(item.get("type") or "text"),
                    "required": bool(item.get("required", False)),
                }
            )
        intr_payload = _build_interrupt_payload(
            prompt=prompt,
            form_fields=fields or None,
            a2ui_protocol=protocol_obj,
        )
        return {
            "feedback": {"status": "ok", "message": "已发起澄清请求"},
            "interrupt_request": intr_payload,
            "model_message_content": {"interrupt_requested": True},
        }
    return {"error": "unknown_meta_tool", "tool_name": tool_name}


def _normalize_native_tool_calls(raw_tool_calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in raw_tool_calls:
        if not isinstance(item, dict):
            continue
        fn = item.get("function") if isinstance(item.get("function"), dict) else {}
        name = str(fn.get("name") or item.get("name") or "").strip()
        if not name:
            continue
        raw_args = fn.get("arguments")
        args = parse_tool_arguments(raw_args)
        out.append({"name": name, "arguments": args})
    return out


def _invoke_model_action(
    *,
    client: QwenClient,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    stream_writer: Callable[[Any], Any] | None = None,
) -> tuple[str, list[dict[str, Any]], list[str]]:
    if hasattr(client, "chat_with_tools_stream"):
        stream_gen, stream_result = client.chat_with_tools_stream(
            messages,
            tools=tools,
            tool_choice="auto",
            return_events=True,
        )
        thinking_parts: list[str] = []
        for event in stream_gen:
            if not isinstance(event, dict):
                continue
            event_type = str(event.get("type") or "").strip().lower()
            if event_type == "thinking":
                text = str(event.get("content") or "")
                if text:
                    thinking_parts.append(text)
                    if callable(stream_writer):
                        stream_writer({"stream_type": "thinking_delta", "content": text, "node": "decide"})
        content = "".join(stream_result.get("content_parts") or []).strip()
        tool_calls = stream_result.get("tool_calls") if isinstance(stream_result.get("tool_calls"), list) else []
        return content, _normalize_native_tool_calls(tool_calls), thinking_parts

    content, tool_calls, _usage = client.chat_with_tools(messages, tools=tools, tool_choice="auto")
    return str(content or "").strip(), _normalize_native_tool_calls(tool_calls), []


def _new_client() -> QwenClient:
    return QwenClient()


def _node_prepare(state: GraphState) -> dict[str, Any]:
    context = state.get("context") or {}
    msgs = _strip_meta_system_messages(_normalize_messages(state.get("messages") or []))
    if not msgs or str((msgs[0] or {}).get("role") or "").lower() != "system":
        msgs = [{"role": "system", "content": _AGENT_POLICY_TEXT}, *msgs]
    else:
        msgs[0] = {"role": "system", "content": _AGENT_POLICY_TEXT}
    goal_anchor = _extract_goal_anchor(msgs)
    logger.info(
        "agent.prepare goal_anchor=%s messages=%s",
        _preview_text(goal_anchor, limit=120),
        _summarize_messages_for_log(msgs),
    )
    return {
        "messages": msgs,
        "model_messages": [],
        "transient_tool_messages": [],
        "step_count": 0,
        "task_phase": "created",
        "observation_packet": None,
        "world_model": _init_world_model({}),
        "policy_raw": None,
        "goal_anchor": goal_anchor,
        "action_journal": [],
        "halt_reason": None,
        "interrupt_payload": None,
        "last_error": None,
        "short_term_rounds": _SHORT_TERM_ROUNDS,
        "short_term_summary": None,
        "model_native_traces": [],
        "thinking_chain_id": f"think-{uuid.uuid4().hex}",
        "thinking_accumulator": "",
        "planning_packet": None,
        "reflection_packet": None,
        "last_model_decision": None,
        "model_turn": None,
        "runtime_snapshot": _evolve_runtime_snapshot(
            previous=state.get("runtime_snapshot"),
            context=context,
            task_phase="created",
            step_count=0,
        ),
    }


def _node_memory_sync(state: GraphState) -> dict[str, Any]:
    context = state.get("context") or {}
    short_rounds = int(state.get("short_term_rounds") or _SHORT_TERM_ROUNDS)
    canonical_messages = _normalize_messages(state.get("messages") or [])
    base_messages = _strip_meta_system_messages(canonical_messages)
    if not base_messages or str((base_messages[0] or {}).get("role") or "").lower() != "system":
        base_messages = [{"role": "system", "content": _AGENT_POLICY_TEXT}, *base_messages]
    else:
        base_messages[0] = {"role": "system", "content": _AGENT_POLICY_TEXT}

    model_window, compressed_summary = _compact_short_term_messages(base_messages, max_rounds=short_rounds)
    memory_summary = str((context.get("history_summary") or "")).strip()
    prior_short = str(state.get("short_term_summary") or "").strip()
    if prior_short:
        memory_summary = f"{memory_summary}\n{prior_short}".strip()
    if compressed_summary:
        memory_summary = f"{memory_summary}\n{compressed_summary}".strip()

    step_count = int(state.get("step_count") or 0)
    logger.info(
        "agent.memory_sync start step=%s memory_summary_preview=%s recent_changes=%s",
        step_count,
        _preview_text(memory_summary, limit=220),
        _preview_text(state.get("recent_changes"), limit=320),
    )
    observation_packet = _build_observation_packet(state, context=context)
    world_model_prev = state.get("world_model") if isinstance(state.get("world_model"), dict) else {}
    world_model_next, world_diff = _observe_environment(
        world_model_prev,
        observation_packet=observation_packet,
        step_count=step_count,
    )
    observation_packet["world_model"] = world_model_next
    model_snapshot = _build_model_snapshot(
        state=state,
        observation_packet=observation_packet,
        memory_summary=memory_summary,
    )
    model_messages = [{"role": "system", "content": model_snapshot}]
    logger.info(
        "agent.memory_sync snapshot step=%s snapshot_preview=%s world_diff=%s",
        step_count,
        _preview_text(model_snapshot, limit=420),
        _preview_text(world_diff, limit=320),
    )

    phase = "observing"
    return {
        "model_messages": model_messages,
        "model_turn": None,
        "observation_packet": observation_packet,
        "short_term_summary": memory_summary or None,
        "world_model": world_model_next,
        "task_phase": phase,
        "recent_changes": [
            {
                "change_type": "observation_built",
                "source_count": ((observation_packet.get("knowledge_base") or {}).get("source_count") or 0),
            },
            {"change_type": "world_model_updated", "diff": world_diff},
        ],
        "runtime_snapshot": _evolve_runtime_snapshot(
            previous=state.get("runtime_snapshot"),
            context=context,
            task_phase=phase,
            step_count=step_count,
        ),
    }


def _invoke_model_text(
    *,
    client: QwenClient,
    messages: list[dict[str, Any]],
    node_name: str,
    stream_writer: Callable[[Any], Any] | None = None,
) -> tuple[str, list[str]]:
    if hasattr(client, "chat_stream"):
        stream_gen, stream_result = client.chat_stream(messages, return_events=True)
        thinking_parts: list[str] = []
        for event in stream_gen:
            if not isinstance(event, dict):
                continue
            event_type = str(event.get("type") or "").strip().lower()
            if event_type == "thinking":
                text = str(event.get("content") or "")
                if text:
                    thinking_parts.append(text)
                    if callable(stream_writer):
                        stream_writer({"stream_type": "thinking_delta", "content": text, "node": node_name})
        content = "".join(stream_result.get("content_parts") or []).strip()
        return content, thinking_parts
    content, _usage = client.chat(messages)
    return str(content or "").strip(), []


def _node_decide(state: GraphState) -> Command[Literal["execute_tools", "__end__"]]:
    context = state.get("context") or {}
    step_count = int(state.get("step_count") or 0)
    persisted_messages = _normalize_messages(state.get("messages") or [])
    model_messages = _normalize_messages(state.get("model_messages") or [])
    llm_messages = list(persisted_messages)
    if model_messages:
        if llm_messages and str((llm_messages[0] or {}).get("role") or "").strip().lower() == "system":
            llm_messages = [llm_messages[0], *model_messages, *llm_messages[1:]]
        else:
            llm_messages = [*model_messages, *llm_messages]
    logger.info(
        "agent.decide input step=%s llm_messages=%s model_messages=%s persisted_messages=%s",
        step_count,
        _summarize_messages_for_log(llm_messages),
        _summarize_messages_for_log(model_messages),
        _summarize_messages_for_log(persisted_messages),
    )
    client = _new_client()
    try:
        stream_writer = get_stream_writer()
    except Exception:
        stream_writer = None

    try:
        response_text, tool_calls, thinking_parts = _invoke_model_action(
            client=client,
            messages=llm_messages,
            tools=_all_decision_tool_schemas(),
            stream_writer=stream_writer,
        )
    except Exception as exc:
        logger.exception("agent.decide invoke_failed step=%s", step_count)
        change = {"change_type": "agent_decision_failed", "reason": str(exc)}
        return Command(
            update={
                "task_phase": "failed",
                "halt_reason": "failed",
                "last_error": f"agent_decision_error: {exc}",
                "recent_changes": [change],
                "runtime_snapshot": _evolve_runtime_snapshot(
                    previous=state.get("runtime_snapshot"),
                    context=context,
                    task_phase="failed",
                    step_count=step_count,
                    recent_changes=[change],
                ),
            },
            goto=END,
        )
    logger.info(
        "agent.decide raw_result step=%s response_len=%s tool_calls=%s tool_call_types=%s thinking_chunks=%s",
        step_count,
        len(str(response_text or "").strip()),
        len(tool_calls or []),
        [type(x).__name__ for x in (tool_calls or [])[:10]],
        len(thinking_parts or []),
    )

    assistant_tool_calls: list[dict[str, Any]] = []
    pending_calls: list[dict[str, Any]] = []

    for call in tool_calls:
        if not isinstance(call, dict):
            continue
        tool_name = str(call.get("name") or "").strip()
        if not tool_name:
            continue
        call_id = f"call-{uuid.uuid4().hex}"
        call_args = call.get("arguments") if isinstance(call.get("arguments"), dict) else {}
        pending_calls.append({"name": tool_name, "arguments": call_args, "reason": "", "call_id": call_id})
        assistant_tool_calls.append(
            {
                "id": call_id,
                "type": "function",
                "function": {"name": tool_name, "arguments": json.dumps(call_args, ensure_ascii=False)},
            }
        )

    decision_snapshot = {
        "step": step_count,
        "tool_count": len(pending_calls),
        "tool_names": [str(x.get("name") or "") for x in pending_calls],
        "response_len": len(str(response_text or "").strip()),
        "thinking_chunks": len([x for x in thinking_parts if str(x or "").strip()]),
    }
    logger.info("agent.decide snapshot=%s", decision_snapshot)

    model_turn = {
        "response_text": str(response_text or "").strip(),
        "tool_calls": pending_calls,
        "assistant_tool_message": (
            {
                "role": "assistant",
                "content": str(response_text or "").strip(),
                "tool_calls": assistant_tool_calls,
            }
            if pending_calls
            else None
        ),
    }
    change = {
        "change_type": "agent_decision_made",
        "intent": "model_output",
        "tool_count": len(pending_calls),
    }
    return Command(
        update={
            "model_turn": model_turn,
            "last_model_decision": decision_snapshot,
            "task_phase": "acting",
            "model_native_traces": [
                {
                    "trace_type": "model_native_thinking",
                    "node": "decide",
                    "content": str(chunk or ""),
                }
                for chunk in thinking_parts
                if str(chunk or "").strip()
            ],
            "recent_changes": [change],
            "runtime_snapshot": _evolve_runtime_snapshot(
                previous=state.get("runtime_snapshot"),
                context=context,
                task_phase="acting",
                step_count=step_count,
                recent_changes=[change],
            ),
        },
        goto="execute_tools",
    )


def _execute_tool_action(
    *,
    tool_name: str,
    tool_arguments: dict[str, Any],
    context: dict[str, Any],
    state_snapshot: dict[str, Any],
    call_id: str | None = None,
) -> dict[str, Any] | None:
    tool_name = str(tool_name or "").strip()
    tool_arguments = tool_arguments if isinstance(tool_arguments, dict) else {}
    if not tool_name:
        return None

    logger.info(
        "agent.execute_tool start tool=%s args=%s state_snapshot=%s",
        tool_name,
        tool_arguments,
        _preview_text(
            {
                "observation_packet": _summarize_observation_packet_for_log(state_snapshot.get("observation_packet")),
                "recent_changes": list(state_snapshot.get("recent_changes") or [])[-3:],
                "action_journal": list(state_snapshot.get("action_journal") or [])[-3:],
            },
            limit=420,
        ),
    )

    call_id = str(call_id or f"call-{uuid.uuid4().hex}")
    allowed_tool_names = {
        str(x.get("function", {}).get("name") or "")
        for x in _all_decision_tool_schemas()
        if str(x.get("function", {}).get("name") or "").strip()
    }
    if tool_name not in allowed_tool_names:
        output: dict[str, Any] = {
            "error": f"unknown_tool:{tool_name}",
            "feedback": {"status": "error", "message": f"工具不存在：{tool_name}"},
            "model_message_content": {"error": "unknown_tool", "tool_name": tool_name},
        }
    elif tool_name in {_META_TOOL_QUERY_ENV, _META_TOOL_REQUEST_CLARIFICATION}:
        output = _execute_meta_tool(tool_name=tool_name, tool_arguments=tool_arguments, state_snapshot=state_snapshot)
    else:
        try:
            output = execute_tool_call(tool_name, tool_arguments, context)
        except Exception as exc:
            output = {
                "error": f"tool_execution_exception: {exc}",
                "error_type": "tool_execution_exception",
                "attempted_tool": tool_name,
            }

    ok = not bool(output.get("error"))
    trace = _tool_result_to_trace(tool_name, tool_arguments, output, ok=ok, tool_call_id=call_id)
    model_observation = output.get("model_message_content")
    if not model_observation:
        model_observation = output.get("model_input") if isinstance(output.get("model_input"), dict) else output
    tool_payload = json.dumps(model_observation, ensure_ascii=False) if isinstance(model_observation, dict) else model_observation
    logger.info(
        "agent.execute_tool done tool=%s ok=%s trace=%s output_preview=%s model_observation_preview=%s",
        tool_name,
        ok,
        _preview_text(trace, limit=420),
        _preview_text(output, limit=420),
        _preview_text(model_observation, limit=420),
    )
    return {
        "tool_name": tool_name,
        "trace": trace,
        "history_msg": {
            "role": "tool",
            "name": tool_name,
            "tool_call_id": call_id,
            "content": _sanitize_tool_content_for_history(tool_payload),
        },
        "transient_msg": {
            "role": "tool",
            "name": tool_name,
            "tool_call_id": call_id,
            "content": tool_payload,
        },
        "feedback": output.get("feedback") if isinstance(output.get("feedback"), dict) else {},
        "interrupt_request": output.get("interrupt_request") if isinstance(output.get("interrupt_request"), dict) else None,
    }


def _node_execute_tools(state: GraphState) -> Command[Literal["memory_sync", "interrupt_user", "__end__"]]:
    context = state.get("context") or {}
    persisted_messages = _normalize_messages(state.get("messages") or [])
    step_count = int(state.get("step_count") or 0)
    reason = "模型决策执行"
    changes: list[dict[str, Any]] = []
    traces: list[dict[str, Any]] = []
    tool_messages_history: list[dict[str, Any]] = []
    tool_messages_transient: list[dict[str, Any]] = []
    action_journal_updates: list[dict[str, Any]] = []
    requested_interrupt_payload: dict[str, Any] | None = None

    model_turn = state.get("model_turn") if isinstance(state.get("model_turn"), dict) else {}
    pending_assistant_tool_message = (
        model_turn.get("assistant_tool_message")
        if isinstance(model_turn.get("assistant_tool_message"), dict)
        else None
    )
    pending_tool_calls = model_turn.get("tool_calls") if isinstance(model_turn.get("tool_calls"), list) else []
    normalized_pending_calls: list[dict[str, Any]] = []
    for item in pending_tool_calls:
        if not isinstance(item, dict):
            continue
        nm = str(item.get("name") or "").strip()
        if not nm:
            continue
        normalized_pending_calls.append(
            {
                "name": nm,
                "arguments": item.get("arguments") if isinstance(item.get("arguments"), dict) else {},
                "reason": str(item.get("reason") or ""),
                "call_id": str(item.get("call_id") or ""),
            }
        )
    pending_response = str(model_turn.get("response_text") or "").strip()
    logger.info(
        "agent.execute_tools start step=%s pending_calls=%s pending_response=%s model_turn=%s",
        step_count,
        normalized_pending_calls,
        _preview_text(pending_response, limit=200),
        _preview_text(model_turn, limit=420),
    )

    if normalized_pending_calls:
        max_parallel = int(context.get("agent_max_parallel_tools") or 3)
        if max_parallel < 1:
            max_parallel = 1
        stream_writer = get_stream_writer()

        world_model = state.get("world_model") if isinstance(state.get("world_model"), dict) else {}
        state_snapshot = {
            "observation_packet": state.get("observation_packet") if isinstance(state.get("observation_packet"), dict) else {},
            "world_model": world_model,
            "recent_changes": list(state.get("recent_changes") or []),
            "action_journal": list(state.get("action_journal") or []),
        }
        history_prefix: list[dict[str, Any]] = []
        if isinstance(pending_assistant_tool_message, dict):
            history_prefix.append(pending_assistant_tool_message)

        # 执行有界并行批次，随后用已返回的部分结果立即继续推进。
        with ThreadPoolExecutor(max_workers=max_parallel) as pool:
            future_map = {}
            for call in normalized_pending_calls:
                call_id = str(call.get("call_id") or f"call-{uuid.uuid4().hex}")
                tool_name = str(call.get("name") or "")
                if callable(stream_writer):
                    try:
                        stream_writer(
                            {
                                "stream_type": "tool_call",
                                "node": "execute_tools",
                                "tool_name": tool_name,
                                "tool_call_id": call_id,
                                "status": "calling",
                            }
                        )
                    except Exception:
                        logger.debug("agent.execute_tool stream_start_emit_failed tool=%s", tool_name, exc_info=True)
                fut = pool.submit(
                    _execute_tool_action,
                    tool_name=tool_name,
                    tool_arguments=call.get("arguments") if isinstance(call.get("arguments"), dict) else {},
                    context=context,
                    state_snapshot=state_snapshot,
                    call_id=call_id,
                )
                future_map[fut] = {"call": call, "call_id": call_id, "tool_name": tool_name}
            for fut in as_completed(future_map):
                realized = fut.result()
                if not realized:
                    continue
                trace = realized["trace"]
                if callable(stream_writer):
                    try:
                        stream_writer(
                            {
                                "stream_type": "tool_call",
                                "node": "execute_tools",
                                "tool_name": trace.get("tool_name") or future_map[fut].get("tool_name"),
                                "tool_call_id": trace.get("tool_call_id") or future_map[fut].get("call_id"),
                                "status": str(trace.get("status") or "error"),
                                "observation": trace.get("observation"),
                                "query": (trace.get("observation") or {}).get("query")
                                if isinstance(trace.get("observation"), dict)
                                else None,
                            }
                        )
                    except Exception:
                        logger.debug(
                            "agent.execute_tool stream_done_emit_failed tool=%s",
                            trace.get("tool_name") or future_map[fut].get("tool_name"),
                            exc_info=True,
                        )
                traces.append(trace)
                tool_messages_history.append(realized["history_msg"])
                tool_messages_transient.append(realized["transient_msg"])
                intr_req = realized.get("interrupt_request")
                if isinstance(intr_req, dict) and requested_interrupt_payload is None:
                    requested_interrupt_payload = intr_req
                changes.append(
                    {
                        "change_type": "decision_tool_executed",
                        "tool_name": realized["tool_name"],
                        "reason": reason,
                    }
                )
                changes.append(
                    {
                        "change_type": "tool_result" if str(trace.get("status") or "") == "ok" else "tool_error",
                        "gap_id": "__decision__",
                        "tool_name": trace.get("tool_name"),
                        "status": trace.get("status"),
                        "query": (trace.get("observation") or {}).get("query"),
                        "summary": (trace.get("observation") or {}).get("summary"),
                        "source_refs": trace.get("source_refs") or [],
                        "feedback": realized.get("feedback") if isinstance(realized.get("feedback"), dict) else {},
                    }
                )
                world_model, world_diff = _record_tool_result(world_model, trace=trace, step_count=step_count)
                changes.append({"change_type": "world_model_changed", "diff": world_diff})
                action_journal_updates.append(
                    {
                        "step": step_count,
                        "phase": "execute_decision_tool",
                        "tool_name": realized["tool_name"],
                        "status": trace.get("status"),
                        "reason": reason,
                    }
                )

        if isinstance(requested_interrupt_payload, dict):
            change = {"change_type": "decision_requires_user", "reason": reason, "source": _META_TOOL_REQUEST_CLARIFICATION}
            return Command(
                update={
                    "messages": _append_messages(persisted_messages, [*history_prefix, *tool_messages_history]),
                    "transient_tool_messages": tool_messages_transient,
                    "tool_results": traces,
                    "recent_changes": [*changes, change],
                    "action_journal": action_journal_updates,
                    "model_turn": None,
                    "world_model": world_model,
                    "task_phase": "awaiting_user",
                    "halt_reason": "interrupt",
                    "interrupt_payload": requested_interrupt_payload,
                    "runtime_snapshot": _evolve_runtime_snapshot(
                        previous=state.get("runtime_snapshot"),
                        context=context,
                        task_phase="awaiting_user",
                        step_count=step_count,
                        tool_results=traces,
                        recent_changes=[*changes, change],
                    ),
                },
                goto="interrupt_user",
            )

        return Command(
            update={
                "messages": _append_messages(persisted_messages, [*history_prefix, *tool_messages_history]),
                "transient_tool_messages": tool_messages_transient,
                "tool_results": traces,
                "recent_changes": changes,
                "action_journal": action_journal_updates,
                "model_turn": None,
                "world_model": world_model,
                "task_phase": "observing",
                "runtime_snapshot": _evolve_runtime_snapshot(
                    previous=state.get("runtime_snapshot"),
                    context=context,
                    task_phase="observing",
                    step_count=step_count,
                    tool_results=traces,
                    recent_changes=changes,
                ),
            },
            goto="memory_sync",
        )

    if pending_response:
        assistant_turn = {"role": "assistant", "content": pending_response}
        change = {"change_type": "assistant_response_emitted", "reason": reason}
        return Command(
            update={
                "messages": _append_messages(persisted_messages, [assistant_turn]),
                "model_turn": None,
                "task_phase": "completed",
                "halt_reason": "answered",
                "recent_changes": [change],
                "runtime_snapshot": _evolve_runtime_snapshot(
                    previous=state.get("runtime_snapshot"),
                    context=context,
                    task_phase="completed",
                    step_count=step_count,
                    recent_changes=[change],
                ),
            },
            goto=END,
        )

    last_model_decision = (
        state.get("last_model_decision") if isinstance(state.get("last_model_decision"), dict) else {}
    )
    change = {
        "change_type": "execute_empty",
        "reason": "no_pending_response_or_tool_calls",
        "last_model_decision": last_model_decision,
    }
    logger.warning(
        "agent.execute_empty last_model_decision=%s model_turn=%s",
        last_model_decision,
        model_turn,
    )
    return Command(
        update={
            "recent_changes": [change],
            "task_phase": "failed",
            "halt_reason": "failed",
            "last_error": "execute_empty: no pending response or tool calls",
            "ag_ui_events": [
                {
                    "action": "agent.protocol_error",
                    "payload": {
                        "code": "execute_empty",
                        "message": "执行阶段无可执行动作或可见回复。",
                        "last_model_decision": last_model_decision,
                    },
                }
            ],
            "model_turn": None,
            "runtime_snapshot": _evolve_runtime_snapshot(
                previous=state.get("runtime_snapshot"),
                context=context,
                task_phase="failed",
                step_count=step_count,
                recent_changes=[change],
            ),
        },
        goto=END,
    )


def _extract_clarification(resume_payload: Any) -> str:
    def _search(value: Any) -> str:
        if isinstance(value, str):
            return value.strip()
        if isinstance(value, dict):
            for key in ("clarification", "answer", "text", "value"):
                v = value.get(key)
                if isinstance(v, str) and v.strip():
                    return v.strip()
            for v in value.values():
                found = _search(v)
                if found:
                    return found
            return ""
        if isinstance(value, list):
            for v in value:
                found = _search(v)
                if found:
                    return found
            return ""
        return str(value or "").strip()

    return _search(resume_payload)


def _node_interrupt_user(state: GraphState) -> Command[Literal["memory_sync", "__end__"]]:
    context = state.get("context") or {}
    intr = state.get("interrupt_payload")
    persisted_messages = _normalize_messages(state.get("messages") or [])
    if not isinstance(intr, dict):
        change = {"change_type": "interrupt_missing_payload"}
        return Command(
            update={
                "task_phase": "failed",
                "halt_reason": "failed",
                "last_error": "interrupt_missing_payload",
                "recent_changes": [change],
                "runtime_snapshot": _evolve_runtime_snapshot(
                    previous=state.get("runtime_snapshot"),
                    context=context,
                    task_phase="failed",
                    step_count=int(state.get("step_count") or 0),
                    recent_changes=[change],
                ),
            },
            goto=END,
        )

    resume_value = interrupt({"interrupt_payload": intr, "messages": _normalize_messages(state.get("messages") or [])})
    clarification = _extract_clarification(resume_value)
    step_count = int(state.get("step_count") or 0)

    updates: dict[str, Any] = {
        "interrupt_payload": None,
        "halt_reason": None,
        "task_phase": "observing",
        "model_turn": None,
        "runtime_snapshot": _evolve_runtime_snapshot(
            previous=state.get("runtime_snapshot"),
            context=context,
            task_phase="observing",
            step_count=step_count,
        ),
    }
    if clarification:
        world_model, world_diff = _record_user_input(
            state.get("world_model") if isinstance(state.get("world_model"), dict) else {},
            text=clarification,
            step_count=step_count,
        )
        updates["messages"] = _append_messages(
            persisted_messages,
            [{"role": "user", "content": clarification}],
        )
        updates["goal_anchor"] = clarification
        updates["world_model"] = world_model
        updates["recent_changes"] = [{"change_type": "world_model_changed", "diff": world_diff}]
    return Command(update=updates, goto="memory_sync")

def _normalize_checkpoint_conn_string(conn: str) -> str:
    value = str(conn or "").strip()
    if value.startswith("postgresql+psycopg2://"):
        return "postgresql://" + value[len("postgresql+psycopg2://") :]
    if value.startswith("postgresql+psycopg://"):
        return "postgresql://" + value[len("postgresql+psycopg://") :]
    if value.startswith("postgres+psycopg2://"):
        return "postgresql://" + value[len("postgres+psycopg2://") :]
    if value.startswith("postgres+psycopg://"):
        return "postgresql://" + value[len("postgres+psycopg://") :]
    if value.startswith("postgres://"):
        return "postgresql://" + value[len("postgres://") :]
    return value


class _CompiledAgentApp:
    def __init__(self) -> None:
        self._settings = get_settings()
        self._exit_stack = ExitStack()
        self._checkpointer = self._init_checkpointer()
        self._graph = self._build_graph()

    def _init_checkpointer(self):
        conn = _normalize_checkpoint_conn_string(
            getattr(self._settings, "agent_checkpoint_postgres_url", "")
        )
        if not conn.startswith("postgresql://"):
            raise RuntimeError(
                "agent_runtime_error: AGENT_CHECKPOINT_POSTGRES_URL (or DATABASE_URL) must be a PostgreSQL connection string"
            )
        saver = self._exit_stack.enter_context(PostgresSaver.from_conn_string(conn))
        if bool(getattr(self._settings, "agent_checkpoint_setup_on_boot", True)):
            saver.setup()
        return saver

    def _build_graph(self):
        builder = StateGraph(GraphState)
        builder.add_node("prepare", _node_prepare)
        builder.add_node("memory_sync", _node_memory_sync)
        builder.add_node("decide", _node_decide)
        builder.add_node("execute_tools", _node_execute_tools)
        builder.add_node("interrupt_user", _node_interrupt_user)

        builder.add_edge(START, "prepare")
        builder.add_edge("prepare", "memory_sync")
        builder.add_edge("memory_sync", "decide")
        return builder.compile(checkpointer=self._checkpointer)

    @staticmethod
    def _interrupt_to_result(interrupt_chunk: Any, fallback_messages: list[dict[str, Any]]) -> dict[str, Any]:
        messages = list(fallback_messages)
        intr_payload: dict[str, Any] | None = None
        if isinstance(interrupt_chunk, (list, tuple)) and interrupt_chunk:
            first = interrupt_chunk[0]
            value = getattr(first, "value", None)
            if isinstance(value, dict):
                maybe_messages = value.get("messages")
                if isinstance(maybe_messages, list):
                    messages = _normalize_messages(maybe_messages)
                payload = value.get("interrupt_payload")
                if isinstance(payload, dict):
                    intr_payload = payload
        if intr_payload is None:
            raise RuntimeError("interrupt_mapping_error: missing_interrupt_payload")

        return {
            "messages": messages,
            "model_messages": messages,
            "tool_results": [],
            "recent_changes": [],
            "model_turn": None,
            "observation_packet": None,
            "world_model": _init_world_model({}),
            "policy_raw": None,
            "action_journal": [],
            "runtime_snapshot": _build_runtime_snapshot({}),
            "task_phase": "awaiting_user",
            "halt_reason": "interrupt",
            "interrupt_payload": intr_payload,
            "ag_ui_events": [
                {
                    "action": "a2ui.protocol.actions",
                    "payload": {
                        "protocol": intr_payload.get("a2ui_protocol") or {},
                        "messages": intr_payload.get("a2ui_messages") or [],
                        "interrupt_id": intr_payload.get("interrupt_id"),
                    },
                }
            ],
        }

    def invoke(self, payload: dict[str, Any], config: dict[str, Any] | None = None) -> dict[str, Any]:
        cfg = dict(config or {})
        configurable = dict(cfg.get("configurable") or {})
        if not str(configurable.get("thread_id") or "").strip():
            configurable["thread_id"] = str(payload.get("thread_id") or f"thread-{uuid.uuid4().hex}")
        cfg["configurable"] = configurable
        context = dict(payload)
        incoming_messages = _normalize_messages(payload.get("messages") or [])
        resume_payload = payload.get("resume_payload")

        if resume_payload is None:
            result = self._graph.invoke({"context": context, "messages": incoming_messages}, config=cfg)
        else:
            result = self._graph.invoke(Command(resume=resume_payload), config=cfg)

        if isinstance(result, dict) and "__interrupt__" in result:
            mapped = self._interrupt_to_result(result.get("__interrupt__"), incoming_messages)
            mapped["runtime_snapshot"] = _evolve_runtime_snapshot(
                previous=mapped.get("runtime_snapshot"),
                context=context,
                task_phase="awaiting_user",
                step_count=int((result or {}).get("step_count") or 0),
            )
            return mapped

        if not isinstance(result, dict):
            raise RuntimeError("agent_runtime_error: invalid graph result")

        return {
            "messages": _normalize_messages(result.get("messages") or incoming_messages),
            "tool_results": list(result.get("tool_results") or []),
            "recent_changes": list(result.get("recent_changes") or []),
            "runtime_snapshot": result.get("runtime_snapshot") or _build_runtime_snapshot(context),
            "task_phase": result.get("task_phase"),
            "halt_reason": result.get("halt_reason"),
            "interrupt_payload": result.get("interrupt_payload"),
            "ag_ui_events": list(result.get("ag_ui_events") or []),
            "last_error": result.get("last_error"),
        }

    def stream(self, payload: dict[str, Any], config: dict[str, Any] | None = None, stream_mode: list[str] | None = None):
        cfg = dict(config or {})
        configurable = dict(cfg.get("configurable") or {})
        if not str(configurable.get("thread_id") or "").strip():
            configurable["thread_id"] = str(payload.get("thread_id") or f"thread-{uuid.uuid4().hex}")
        cfg["configurable"] = configurable
        context = dict(payload)
        incoming_messages = _normalize_messages(payload.get("messages") or [])
        resume_payload = payload.get("resume_payload")
        effective_modes = list(stream_mode or ["updates"])
        if not effective_modes:
            effective_modes = ["updates"]

        if resume_payload is None:
            src = self._graph.stream({"context": context, "messages": incoming_messages}, config=cfg, stream_mode=effective_modes)
        else:
            src = self._graph.stream(Command(resume=resume_payload), config=cfg, stream_mode=effective_modes)

        for raw in src:
            mode, payload_obj = _normalize_stream_event(raw)
            if isinstance(payload_obj, dict) and "__interrupt__" in payload_obj:
                mapped = self._interrupt_to_result(payload_obj.get("__interrupt__"), incoming_messages)
                mapped["runtime_snapshot"] = _evolve_runtime_snapshot(
                    previous=mapped.get("runtime_snapshot"),
                    context=context,
                    task_phase="awaiting_user",
                    step_count=0,
                )
                yield ("updates", {"interrupt_user": mapped})
                return
            yield (mode, payload_obj)

    def close(self) -> None:
        self._exit_stack.close()


_APP: _CompiledAgentApp | None = None


def get_compiled_agent_app() -> _CompiledAgentApp:
    global _APP
    if _APP is None:
        _APP = _CompiledAgentApp()
    return _APP


def _close_compiled_agent_app() -> None:
    global _APP
    if _APP is not None:
        try:
            _APP.close()
        finally:
            _APP = None


atexit.register(_close_compiled_agent_app)


__all__ = ["get_compiled_agent_app"]

