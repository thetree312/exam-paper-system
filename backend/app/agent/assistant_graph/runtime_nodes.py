from __future__ import annotations

import json
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Literal

from langgraph.config import get_stream_writer
from langgraph.graph import END
from langgraph.types import Command, interrupt

from .llm_tools import execute_tool_call, tool_result_to_trace as _tool_result_to_trace
from .router_runtime import evolve_runtime_snapshot as _evolve_runtime_snapshot
from .state import _derive_default_exec_state, _derive_default_task_model
from .world_model import record_tool_result as _record_tool_result, record_user_input as _record_user_input
from .runtime_common import (
    GraphState,
    _META_TOOL_QUERY_ENV,
    _META_TOOL_REQUEST_CLARIFICATION,
    _all_decision_tool_schemas,
    _append_messages,
    _build_interrupt_payload,
    _execute_meta_tool,
    _invoke_model_action,
    _new_client,
    _normalize_messages,
    _sanitize_tool_content_for_history,
)

def _node_decide(state: GraphState) -> Command[Literal["execute_tools", "__end__"]]:
    context = state.get("context") or {}
    step_count = int(state.get("step_count") or 0)
    persisted_messages = _normalize_messages(state.get("messages") or [])
    model_messages = _normalize_messages(state.get("model_messages") or [])
    llm_messages = [*persisted_messages, *model_messages]
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

    next_exec_state = _derive_default_exec_state(state.get("exec_state") if isinstance(state.get("exec_state"), dict) else None)
    next_exec_state["wait_status"] = "ready"
    next_exec_state["pending_tool_call"] = None
    next_exec_state["pending_tool_calls"] = []
    next_exec_state["pending_response"] = ""
    next_exec_state["pending_assistant_tool_message"] = None

    decision_intent = "empty"
    tool_count = 0
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

    if pending_calls:
        decision_intent = "tool_call"
        tool_count = len(pending_calls)
        next_exec_state["pending_tool_calls"] = pending_calls
        next_exec_state["pending_assistant_tool_message"] = {
            "role": "assistant",
            "content": str(response_text or "").strip(),
            "tool_calls": assistant_tool_calls,
        }
    elif str(response_text or "").strip():
        decision_intent = "respond"
        next_exec_state["pending_response"] = str(response_text or "").strip()
    else:
        change = {"change_type": "agent_decision_empty", "reason": "no_tool_calls_and_no_response"}
        return Command(
            update={
                "exec_state": next_exec_state,
                "task_phase": "failed",
                "halt_reason": "failed",
                "last_error": "agent_decision_empty: no tool calls and no response",
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

    change = {
        "change_type": "agent_decision_made",
        "intent": decision_intent,
        "tool_count": tool_count,
    }
    return Command(
        update={
            "exec_state": next_exec_state,
            "task_phase": "acting" if decision_intent in {"tool_call", "respond"} else "observing",
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
                task_phase="acting" if decision_intent in {"tool_call", "respond"} else "observing",
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
    exec_state = _derive_default_exec_state(state.get("exec_state") if isinstance(state.get("exec_state"), dict) else None)
    reason = "模型决策执行"
    changes: list[dict[str, Any]] = []
    traces: list[dict[str, Any]] = []
    tool_messages_history: list[dict[str, Any]] = []
    tool_messages_transient: list[dict[str, Any]] = []
    action_journal_updates: list[dict[str, Any]] = []
    requested_interrupt_payload: dict[str, Any] | None = None

    pending_tool_call = exec_state.get("pending_tool_call") if isinstance(exec_state.get("pending_tool_call"), dict) else None
    pending_tool_calls = exec_state.get("pending_tool_calls") if isinstance(exec_state.get("pending_tool_calls"), list) else []
    pending_assistant_tool_message = (
        exec_state.get("pending_assistant_tool_message")
        if isinstance(exec_state.get("pending_assistant_tool_message"), dict)
        else None
    )
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
    if pending_tool_call:
        nm = str(pending_tool_call.get("name") or "").strip()
        if nm:
            normalized_pending_calls.append(
                {
                    "name": nm,
                    "arguments": pending_tool_call.get("arguments") if isinstance(pending_tool_call.get("arguments"), dict) else {},
                    "reason": str(pending_tool_call.get("reason") or ""),
                    "call_id": str(pending_tool_call.get("call_id") or ""),
                }
            )
    pending_response = str(exec_state.get("pending_response") or "").strip()

    if pending_response:
        assistant_turn = {"role": "assistant", "content": pending_response}
        change = {"change_type": "assistant_response_emitted", "reason": reason}
        return Command(
            update={
                "messages": _append_messages(persisted_messages, [assistant_turn]),
                "exec_state": {
                    **exec_state,
                    "wait_status": "idle",
                    "pending_tool_call": None,
                    "pending_tool_calls": [],
                    "pending_response": "",
                    "pending_assistant_tool_message": None,
                },
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

    if normalized_pending_calls:
        max_parallel = int(context.get("agent_max_parallel_tools") or 3)
        if max_parallel < 1:
            max_parallel = 1
        batch = normalized_pending_calls[:max_parallel]
        remaining = normalized_pending_calls[max_parallel:]

        world_state = state.get("world_state") if isinstance(state.get("world_state"), dict) else {}
        state_snapshot = {
            "observation_packet": state.get("observation_packet") if isinstance(state.get("observation_packet"), dict) else {},
            "world_state": world_state,
            "recent_changes": list(state.get("recent_changes") or []),
            "action_journal": list(state.get("action_journal") or []),
        }
        history_prefix: list[dict[str, Any]] = []
        if isinstance(pending_assistant_tool_message, dict):
            history_prefix.append(pending_assistant_tool_message)

        # 执行有界并行批次，随后用已返回的部分结果立即继续推进。
        with ThreadPoolExecutor(max_workers=max_parallel) as pool:
            future_map = {
                pool.submit(
                    _execute_tool_action,
                    tool_name=str(call.get("name") or ""),
                    tool_arguments=call.get("arguments") if isinstance(call.get("arguments"), dict) else {},
                    context=context,
                    state_snapshot=state_snapshot,
                    call_id=str(call.get("call_id") or ""),
                ): call
                for call in batch
            }
            for fut in as_completed(future_map):
                realized = fut.result()
                if not realized:
                    continue
                trace = realized["trace"]
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
                world_state, world_diff = _record_tool_result(world_state, trace=trace, step_count=step_count)
                changes.append({"change_type": "world_state_changed", "diff": world_diff})
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
                    "exec_state": {
                        **exec_state,
                        "wait_status": "idle",
                        "pending_tool_call": None,
                        "pending_tool_calls": remaining,
                        "pending_response": "",
                        "pending_assistant_tool_message": None,
                    },
                    "world_state": world_state,
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
                "exec_state": {
                    **exec_state,
                    "wait_status": "idle",
                    "pending_tool_call": None,
                    "pending_tool_calls": remaining,
                    "pending_response": "",
                    "pending_assistant_tool_message": pending_assistant_tool_message if remaining else None,
                },
                "world_state": world_state,
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

    change = {"change_type": "execute_empty", "reason": "no_pending_response_or_tool_calls"}
    return Command(
        update={
            "recent_changes": [change],
            "task_phase": "failed",
            "halt_reason": "failed",
            "last_error": "execute_empty: no pending response or tool calls",
            "exec_state": {**exec_state, "wait_status": "idle"},
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


def _node_interrupt_user(state: GraphState) -> Command[Literal["memory_sync"]]:
    context = state.get("context") or {}
    intr = state.get("interrupt_payload")
    persisted_messages = _normalize_messages(state.get("messages") or [])
    if not isinstance(intr, dict):
        intr = _build_interrupt_payload("required_missing")

    resume_value = interrupt({"interrupt_payload": intr, "messages": _normalize_messages(state.get("messages") or [])})
    clarification = _extract_clarification(resume_value)
    step_count = int(state.get("step_count") or 0)

    updates: dict[str, Any] = {
        "interrupt_payload": None,
        "halt_reason": None,
        "task_phase": "observing",
        "runtime_snapshot": _evolve_runtime_snapshot(
            previous=state.get("runtime_snapshot"),
            context=context,
            task_phase="observing",
            step_count=step_count,
        ),
    }
    if clarification:
        world_state, world_diff = _record_user_input(
            state.get("world_state") if isinstance(state.get("world_state"), dict) else {},
            text=clarification,
            step_count=step_count,
        )
        task_state = _derive_default_task_model(
            goal_anchor=clarification,
            world_state=world_state,
            previous=state.get("task_state") if isinstance(state.get("task_state"), dict) else None,
        )
        updates["messages"] = _append_messages(
            persisted_messages,
            [{"role": "user", "content": clarification}],
        )
        updates["goal_anchor"] = clarification
        updates["task_state"] = task_state
        updates["exec_state"] = _derive_default_exec_state(state.get("exec_state") if isinstance(state.get("exec_state"), dict) else None)
        updates["world_state"] = world_state
        updates["recent_changes"] = [{"change_type": "world_state_changed", "diff": world_diff}]
    return Command(update=updates, goto="memory_sync")
