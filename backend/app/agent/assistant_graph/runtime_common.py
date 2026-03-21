from __future__ import annotations

import atexit
import json
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
from .evidence_register import summarize_evidence_register as _summarize_evidence_register
from .state import (
    _derive_default_exec_state,
    _derive_default_task_model,
)
from .world_model import (
    init_world_model as _init_world_model,
    observe_environment as _observe_environment,
    query_world_model as _query_world_model,
    record_tool_result as _record_tool_result,
    record_user_input as _record_user_input,
)

INTERRUPT_REASON_CODES = {
    "required_missing",
    "unresolved_ambiguity",
    "unresolved_conflict",
    "loop_guard_triggered",
}

_SHORT_TERM_ROUNDS = 12
_OPENUI_SCHEMA_VERSION = "1.0"
_META_TOOL_QUERY_ENV = "query_environment_model"
_META_TOOL_REQUEST_CLARIFICATION = "request_user_clarification"
_AGENT_POLICY_TEXT = (
    "你是一个嵌入在网页工作区中的环境驱动单体智能体。"
    "你的职责是基于当前消息、环境状态和工具反馈，选择下一步最小且有效的行动。"
    "优先使用原生工具调用主动查询环境与知识，而不是空谈计划。"
    "允许并鼓励并行工具调用（tool_calls）。"
    "当目标对象不唯一、关键约束缺失或证据仍不足时，调用 request_user_clarification 发起澄清。"
    "禁止虚构工具；只能调用已提供工具。"
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
    task_state: dict[str, Any]
    exec_state: dict[str, Any]
    observation_packet: dict[str, Any] | None
    world_state: dict[str, Any]
    policy_raw: str | None
    goal_anchor: str | None
    action_journal: Annotated[list[dict[str, Any]], _append_list]
    halt_reason: str | None
    interrupt_payload: dict[str, Any] | None
    last_error: str | None
    short_term_rounds: int
    short_term_summary: str | None
    model_native_traces: Annotated[list[dict[str, Any]], _append_list]
    evidence_register: list[dict[str, Any]]
    thinking_chain_id: str | None
    thinking_accumulator: str | None
    planning_packet: dict[str, Any] | None
    reflection_packet: dict[str, Any] | None


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
    world_state = state.get("world_state") if isinstance(state.get("world_state"), dict) else {}
    env = context.get("environment") if isinstance(context.get("environment"), dict) else {}
    surfaces = env.get("surfaces") if isinstance(env.get("surfaces"), dict) else {}
    kb_surface = surfaces.get("knowledge_base") if isinstance(surfaces.get("knowledge_base"), dict) else {}
    studio_surface = surfaces.get("studio") if isinstance(surfaces.get("studio"), dict) else {}
    favorites_surface = surfaces.get("favorites") if isinstance(surfaces.get("favorites"), dict) else {}
    source_ids = list(kb_surface.get("source_file_ids") or context.get("source_file_ids") or [])
    return {
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
        "world_state": world_state,
        "runtime_snapshot": runtime_snapshot,
    }


def _build_model_snapshot(
    *,
    state: GraphState,
    observation_packet: dict[str, Any],
    memory_summary: str,
) -> dict[str, Any]:
    latest_user_query = _latest_user_query(_normalize_messages(state.get("messages") or []))
    studio = observation_packet.get("studio") if isinstance(observation_packet.get("studio"), dict) else {}
    kb = observation_packet.get("knowledge_base") if isinstance(observation_packet.get("knowledge_base"), dict) else {}
    latest_tool = (
        observation_packet.get("latest_tool_observation")
        if isinstance(observation_packet.get("latest_tool_observation"), dict)
        else {}
    )
    world_state = observation_packet.get("world_state") if isinstance(observation_packet.get("world_state"), dict) else {}
    world_facts = world_state.get("facts") if isinstance(world_state.get("facts"), dict) else {}
    world_topology = world_state.get("topology") if isinstance(world_state.get("topology"), dict) else {}
    recent_tools = world_state.get("recent_tool_results") if isinstance(world_state.get("recent_tool_results"), list) else []
    recent_users = world_state.get("recent_user_inputs") if isinstance(world_state.get("recent_user_inputs"), list) else []
    evidence_register_summary = _summarize_evidence_register(state.get("evidence_register") or [])
    return {
        "最新用户请求": latest_user_query,
        "记忆摘要": memory_summary[:300] if memory_summary else "",
        "世界先验": _build_world_priors(),
        "当前显著状态": {
            "studio_document_id": studio.get("studio_document_id"),
            "studio_view": studio.get("studio_view"),
            "kb_source_count": int(kb.get("source_count") or 0),
            "latest_tool": {
                "tool_name": latest_tool.get("tool_name"),
                "status": latest_tool.get("status"),
                "summary": latest_tool.get("summary"),
            },
            "world_model": {
                "version": int(world_state.get("version") or 0),
                "last_step": int(world_state.get("last_step") or 0),
                "topology": world_topology,
                "facts": world_facts,
                "recent_tool_results": recent_tools[-3:],
                "recent_user_inputs": recent_users[-3:],
            },
            "evidence_register": evidence_register_summary[-3:],
        },
        "按需查询": {
            "instruction": "默认仅使用当前显著状态。需要细节时，再调用 query_environment_model。",
            "paths": [
                "world_model.environment",
                "world_model.entities",
                "world_model.relations",
                "world_model.recent_tool_results",
                "observation_packet.studio",
                "observation_packet.knowledge_base",
                "recent_changes",
                "action_journal",
            ],
        },
    }


def _build_interrupt_payload(
    reason_code: str,
    prompt_override: str | None = None,
    *,
    form_fields: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if reason_code not in INTERRUPT_REASON_CODES:
        reason_code = "required_missing"
    interrupt_id = f"intr-{uuid.uuid4().hex}"
    prompt = str(prompt_override or "").strip() or f"需要用户补充信息（{reason_code}）。"
    raw_fields = form_fields if isinstance(form_fields, list) and form_fields else [
        {"id": "clarification", "name": "clarification", "label": "请补充说明", "type": "longText", "required": True}
    ]
    normalized_fields: list[dict[str, Any]] = []
    for item in raw_fields:
        if not isinstance(item, dict):
            continue
        field_id = str(item.get("id") or item.get("name") or "").strip()
        if not field_id:
            continue
        field: dict[str, Any] = {
            "id": field_id,
            "name": field_id,
            "label": str(item.get("label") or field_id),
            "type": str(item.get("type") or "text"),
            "required": bool(item.get("required", False)),
        }
        if "options" in item and isinstance(item.get("options"), list):
            field["options"] = item.get("options")
        if "placeholder" in item and isinstance(item.get("placeholder"), str):
            field["placeholder"] = str(item.get("placeholder"))
        if "default" in item:
            field["default"] = item.get("default")
        if "min" in item and isinstance(item.get("min"), (int, float)):
            field["min"] = item.get("min")
        if "max" in item and isinstance(item.get("max"), (int, float)):
            field["max"] = item.get("max")
        normalized_fields.append(field)
    openui_payload = {
        "version": _OPENUI_SCHEMA_VERSION,
        "type": "form",
        "title": prompt,
        "reason_code": reason_code,
        "fields": normalized_fields,
        "actions": [
            {"id": "submit", "label": "确认", "variant": "primary"},
            {"id": "cancel", "label": "取消", "variant": "secondary"},
        ],
    }
    field_lines: list[str] = []
    field_refs: list[str] = []
    for idx, field in enumerate(normalized_fields, start=1):
        ref = f"f{idx}"
        field_refs.append(ref)
        raw_type = str(field.get("type") or "text").strip().lower()
        kind = (
            "textarea"
            if raw_type in {"longtext", "textarea"}
            else "radio"
            if raw_type in {"radio", "choice"}
            else "select"
            if raw_type in {"select", "dropdown"}
            else "number"
            if raw_type in {"number", "integer", "float"}
            else "text"
        )
        option_values: list[str] = []
        option_labels: list[str] = []
        for option in field.get("options") if isinstance(field.get("options"), list) else []:
            if isinstance(option, dict):
                value = str(option.get("value") or option.get("id") or option.get("label") or "").strip()
                if not value:
                    continue
                label = str(option.get("label") or value)
            else:
                value = str(option).strip()
                if not value:
                    continue
                label = value
            option_values.append(value)
            option_labels.append(label)
        default_value = field.get("default")
        if default_value is None:
            default_value = "" if kind in {"text", "textarea", "select", "radio"} else None
        min_value = field.get("min") if isinstance(field.get("min"), (int, float)) else None
        max_value = field.get("max") if isinstance(field.get("max"), (int, float)) else None
        field_lines.append(
            (
                f"{ref} = HitlField("
                f"{json.dumps(interrupt_id, ensure_ascii=False)}, "
                f"{json.dumps(str(field.get('name') or field.get('id') or ''), ensure_ascii=False)}, "
                f"{json.dumps(str(field.get('label') or field.get('id') or ''), ensure_ascii=False)}, "
                f"{json.dumps(kind, ensure_ascii=False)}, "
                f"{json.dumps(str(field.get('placeholder') or ''), ensure_ascii=False)}, "
                f"{'true' if bool(field.get('required')) else 'false'}, "
                f"{json.dumps(option_values, ensure_ascii=False)}, "
                f"{json.dumps(option_labels, ensure_ascii=False)}, "
                f"{json.dumps(default_value, ensure_ascii=False)}, "
                f"{json.dumps(min_value, ensure_ascii=False)}, "
                f"{json.dumps(max_value, ensure_ascii=False)}"
                ")"
            )
        )
    action_lines = [
        f'a_submit = HitlAction("submit", "确认", "primary", {json.dumps(interrupt_id, ensure_ascii=False)})',
        f'a_cancel = HitlAction("cancel", "取消", "secondary", {json.dumps(interrupt_id, ensure_ascii=False)})',
    ]
    openui_lang_lines = [
        f'root = HitlForm({json.dumps(prompt, ensure_ascii=False)}, {json.dumps(interrupt_id, ensure_ascii=False)}, [{", ".join(field_refs)}], [a_submit, a_cancel])'
    ]
    openui_lang_lines.extend(field_lines)
    openui_lang_lines.extend(action_lines)
    openui_lang = "\n".join(openui_lang_lines)
    return {
        "interrupt_id": interrupt_id,
        "reason_code": reason_code,
        "prompt": prompt,
        "openui": openui_payload,
        "openui_lang": openui_lang,
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
                        "tail": {"type": "integer", "minimum": 1, "maximum": 20, "default": 8},
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
                        "reason_code": {
                            "type": "string",
                            "enum": sorted(list(INTERRUPT_REASON_CODES)),
                        },
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
        tail = int(tool_arguments.get("tail") or 8)
        if tail < 1:
            tail = 1
        if tail > 20:
            tail = 20
        root_view = {
            "world_model": _query_world_model(
                state_snapshot.get("world_state") if isinstance(state_snapshot.get("world_state"), dict) else {},
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
        return {
            "feedback": {"status": "ok", "message": f"已查询环境模型路径：{path or '<根路径>'}"},
            "model_message_content": {"path": path or "<根路径>", "payload": payload},
        }
    if tool_name == _META_TOOL_REQUEST_CLARIFICATION:
        prompt = str(tool_arguments.get("prompt") or "").strip()
        reason_code = str(tool_arguments.get("reason_code") or "required_missing").strip()
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
        intr_payload = _build_interrupt_payload(reason_code, prompt_override=prompt, form_fields=fields or None)
        return {
            "feedback": {"status": "ok", "message": "已发起澄清请求"},
            "interrupt_request": intr_payload,
            "model_message_content": {"interrupt_requested": True, "reason_code": intr_payload.get("reason_code")},
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
    task_state = _derive_default_task_model(goal_anchor=goal_anchor, world_state={}, previous=None)
    exec_state = _derive_default_exec_state(None)
    return {
        "messages": msgs,
        "model_messages": [],
        "transient_tool_messages": [],
        "step_count": 0,
        "task_phase": "created",
        "task_state": task_state,
        "exec_state": exec_state,
        "observation_packet": None,
        "world_state": _init_world_model({}),
        "policy_raw": None,
        "goal_anchor": goal_anchor,
        "action_journal": [],
        "halt_reason": None,
        "interrupt_payload": None,
        "last_error": None,
        "short_term_rounds": _SHORT_TERM_ROUNDS,
        "short_term_summary": None,
        "model_native_traces": [],
        "evidence_register": [],
        "thinking_chain_id": f"think-{uuid.uuid4().hex}",
        "thinking_accumulator": "",
        "planning_packet": None,
        "reflection_packet": None,
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
    next_step_count = step_count + 1
    observation_packet = _build_observation_packet(state, context=context)
    world_model_prev = state.get("world_state") if isinstance(state.get("world_state"), dict) else {}
    world_model_next, world_diff = _observe_environment(
        world_model_prev,
        observation_packet=observation_packet,
        step_count=next_step_count,
    )
    observation_packet["world_state"] = world_model_next
    next_exec_state = _derive_default_exec_state(state.get("exec_state") if isinstance(state.get("exec_state"), dict) else None)
    model_snapshot = _build_model_snapshot(
        state=state,
        observation_packet=observation_packet,
        memory_summary=memory_summary,
    )
    model_messages = [{"role": "user", "content": json.dumps(model_snapshot, ensure_ascii=False)}]

    phase = "observing"
    return {
        "model_messages": model_messages,
        "exec_state": next_exec_state,
        "step_count": next_step_count,
        "observation_packet": observation_packet,
        "short_term_summary": memory_summary or None,
        "world_state": world_model_next,
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
            step_count=next_step_count,
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



