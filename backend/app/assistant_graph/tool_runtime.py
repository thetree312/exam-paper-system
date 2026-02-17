from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, List

from .runtime import logger
from .state import AgentState
from .nodes.question_tools import apply_question_retrieval_tool


@dataclass
class ToolRuntimeResult:
    tool_messages: List[dict]
    active_ids: list[int]
    recent_ids: list[int]


def _build_tool_error_message(tool_call: dict, *, error: str, detail: str) -> dict:
    fn = tool_call.get("function") or {}
    name = fn.get("name") or "unknown_tool"
    return {
        "role": "tool",
        "tool_call_id": tool_call.get("id"),
        "name": name,
        "content": json.dumps({"error": error, "detail": detail}, ensure_ascii=False),
    }


def _ensure_tool_responses(tool_calls: List[dict], tool_messages: List[dict]) -> List[dict]:
    responded_ids = {
        msg.get("tool_call_id")
        for msg in tool_messages
        if isinstance(msg, dict) and msg.get("role") == "tool"
    }
    missing = []
    for tc in tool_calls:
        if not isinstance(tc, dict):
            continue
        tc_id = tc.get("id")
        if tc_id and tc_id not in responded_ids:
            missing.append(tc)
    for tc in missing:
        tool_messages.append(
            _build_tool_error_message(
                tc,
                error="missing_tool_response",
                detail="tool_call 未生成对应的 tool 回执",
            )
        )
    if missing:
        logger.warning(
            "assistant.tool_runtime.missing_tool_responses count=%s tool_names=%s",
            len(missing),
            [
                (tc.get("function") or {}).get("name")
                for tc in missing
                if isinstance(tc, dict)
            ],
        )
    return tool_messages


def _apply_similar_question_planner_tool(tool_calls: List[dict]) -> List[dict]:
    tool_messages: List[dict] = []
    for tc in tool_calls:
        if not isinstance(tc, dict):
            continue
        fn = tc.get("function") or {}
        name = fn.get("name")
        if name != "similar_question_planner":
            continue
        args_raw = fn.get("arguments") or "{}"
        try:
            args = json.loads(args_raw)
        except Exception:  # noqa: BLE001
            tool_messages.append(
                _build_tool_error_message(
                    tc,
                    error="invalid_tool_args",
                    detail="similar_question_planner 参数解析失败",
                )
            )
            continue
        payload = {
            "status": "ok",
            "plans": args.get("plans") or [],
            "batch_config_required": bool(args.get("batch_config_required")),
            "batch_config": args.get("batch_config") or {},
            "batch_config_ui": args.get("batch_config_ui") or None,
        }
        tool_messages.append(
            {
                "role": "tool",
                "tool_call_id": tc.get("id"),
                "name": name,
                "content": json.dumps(payload, ensure_ascii=False),
            }
        )
    return tool_messages


def run_tool_runtime(
    *,
    state: AgentState,
    tool_calls: List[dict],
    active_ids: list[int],
    recent_ids: list[int],
    max_active: int,
    max_recent: int,
    focus_handler: Callable[..., tuple[list[int], list[int], List[dict]]],
    include_planner: bool = False,
) -> ToolRuntimeResult:
    tool_messages: List[dict] = []

    next_active, next_recent, focus_msgs = focus_handler(
        tool_calls=tool_calls,
        snapshot_items=state.get("snapshot_items") or [],
        active_ids=active_ids,
        recent_ids=recent_ids,
        max_active=max_active,
        max_recent=max_recent,
    )
    tool_messages.extend(focus_msgs)
    tool_messages.extend(apply_question_retrieval_tool(state, tool_calls))
    if include_planner:
        tool_messages.extend(_apply_similar_question_planner_tool(tool_calls))

    _ensure_tool_responses(tool_calls, tool_messages)

    return ToolRuntimeResult(
        tool_messages=tool_messages,
        active_ids=next_active,
        recent_ids=next_recent,
    )


__all__ = ["ToolRuntimeResult", "run_tool_runtime"]
