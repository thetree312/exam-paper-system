from __future__ import annotations

import json
import uuid
from typing import Any

from .llm_tools import build_tool_schemas, execute_tool_call


def _build_unknown_tool_output(tool_name: str) -> dict[str, Any]:
    available_tools = [
        str(x.get("function", {}).get("name") or "")
        for x in build_tool_schemas()
        if str(x.get("function", {}).get("name") or "").strip()
    ]
    attempted = str(tool_name or "").strip() or "<empty>"
    message = f"工具不存在: {attempted}"
    feedback = {
        "error_type": "unknown_tool",
        "message": message,
        "status": "error",
        "attempted_tool": str(tool_name or ""),
        "available_tools": available_tools,
        "hint": "请改用 available_tools 中的工具，或先向用户澄清目标对象。",
        "missing_information": ["tool_name"],
    }
    return {
        "error": message,
        "error_type": "unknown_tool",
        "attempted_tool": str(tool_name or ""),
        "available_tools": available_tools,
        "hint": feedback["hint"],
        "feedback": feedback,
        "model_message_content": feedback,
    }


def realize_gap_object(
    *,
    object_id: str,
    tool_name: str,
    tool_arguments: dict[str, Any] | None,
    context: dict[str, Any],
    sanitize_tool_content_for_history: Any,
    tool_result_to_trace: Any,
) -> dict[str, Any]:
    tool_name = str(tool_name or "").strip()
    tool_args = tool_arguments if isinstance(tool_arguments, dict) else {}
    if not tool_name:
        return {}

    call_id = f"call-{uuid.uuid4().hex}"
    allowed_tool_names = {
        str(x.get("function", {}).get("name") or "")
        for x in build_tool_schemas()
        if str(x.get("function", {}).get("name") or "").strip()
    }

    if tool_name not in allowed_tool_names:
        output: dict[str, Any] = _build_unknown_tool_output(tool_name)
    else:
        try:
            output = execute_tool_call(tool_name, tool_args, context)
        except Exception as exc:
            output = {
                "error": f"tool_execution_exception: {exc}",
                "error_type": "tool_execution_exception",
                "attempted_tool": tool_name,
            }

    ok = not bool(output.get("error"))
    trace = tool_result_to_trace(tool_name, tool_args, output, ok=ok, tool_call_id=call_id)
    model_observation = output.get("model_message_content")
    if not model_observation:
        model_observation = output.get("model_input") if isinstance(output.get("model_input"), dict) else output

    tool_payload = (
        json.dumps(model_observation, ensure_ascii=False)
        if isinstance(model_observation, dict)
        else model_observation
    )
    history_msg = {
        "role": "tool",
        "name": tool_name,
        "tool_call_id": call_id,
        "content": sanitize_tool_content_for_history(tool_payload),
    }
    transient_msg = {"role": "tool", "name": tool_name, "tool_call_id": call_id, "content": tool_payload}
    return {
        "object_id": str(object_id or ""),
        "tool_name": tool_name,
        "trace": trace,
        "history_msg": history_msg,
        "transient_msg": transient_msg,
        "feedback": output.get("feedback") if isinstance(output.get("feedback"), dict) else {},
    }

