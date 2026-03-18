from __future__ import annotations

import copy
import json
from typing import Any, TypedDict


class LoopBudget(TypedDict):
    turn_id: str
    steps_taken: int
    tool_calls: int
    repeated_calls: int


def new_turn_loop_budget(*, turn_id: str) -> LoopBudget:
    return {
        "turn_id": turn_id,
        "steps_taken": 0,
        "tool_calls": 0,
        "repeated_calls": 0,
    }


def _stable_tool_signature(name: str, args: dict[str, Any]) -> str:
    tool_name = str(name or "").strip()
    try:
        encoded = json.dumps(args or {}, ensure_ascii=False, sort_keys=True)
    except Exception:
        encoded = "{}"
    return f"{tool_name}:{encoded}"


def _diff_world_state(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    diff: dict[str, Any] = {}
    keys = set(before.keys()) | set(after.keys())
    for key in sorted(keys):
        old = before.get(key)
        new = after.get(key)
        if old != new:
            diff[key] = {"from": old, "to": new}
    return diff


def transition_world_state(
    previous: dict[str, Any] | None,
    *,
    action_payload: dict[str, Any] | None = None,
    tool_trace: dict[str, Any] | None = None,
    clarification: str | None = None,
    step_count: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    before = copy.deepcopy(previous) if isinstance(previous, dict) else {}
    after = copy.deepcopy(before)
    after["last_step"] = int(step_count)
    if isinstance(action_payload, dict):
        after["last_action"] = str(action_payload.get("action") or "")
        after["last_action_reason"] = str(action_payload.get("reason") or "")
        action_name = str(action_payload.get("action") or "").strip().lower()
        if action_name == "no_executable_gap":
            after["no_executable_streak"] = int(before.get("no_executable_streak") or 0) + 1
        else:
            after["no_executable_streak"] = 0
    if clarification:
        after["last_user_clarification"] = str(clarification or "").strip()
    if isinstance(tool_trace, dict):
        output_obj = tool_trace.get("output") if isinstance(tool_trace.get("output"), dict) else {}
        arguments_obj = tool_trace.get("arguments") if isinstance(tool_trace.get("arguments"), dict) else {}
        after["last_tool_name"] = str(tool_trace.get("tool_name") or "")
        after["last_tool_status"] = str(tool_trace.get("status") or "")
        after["tool_attempts_total"] = int(before.get("tool_attempts_total") or 0) + 1
        signature = _stable_tool_signature(after["last_tool_name"], arguments_obj)
        previous_signature = str(before.get("last_tool_signature") or "")
        after["last_tool_signature"] = signature
        after["repeated_tool_streak"] = (
            int(before.get("repeated_tool_streak") or 0) + 1 if signature and signature == previous_signature else 0
        )
        progress_detected = False
        if isinstance(output_obj, dict):
            if isinstance(output_obj.get("evidence_summary"), dict):
                summary = output_obj.get("evidence_summary") or {}
                after["evidence_count"] = int(summary.get("evidence_count") or 0)
                after["snippet_count"] = int(summary.get("snippet_count") or 0)
                after["asset_ref_count"] = int(summary.get("asset_ref_count") or 0)
            elif output_obj.get("candidate_asset_count") is not None:
                after["asset_ref_count"] = int(output_obj.get("candidate_asset_count") or 0)
        after["observed_has_snippet"] = bool(int(after.get("snippet_count") or 0) > 0)
        after["observed_has_evidence"] = bool(
            int(after.get("evidence_count") or 0) > 0 or int(after.get("asset_ref_count") or 0) > 0
        )
        for key in ("snippet_count", "evidence_count", "asset_ref_count"):
            if before.get(key) != after.get(key):
                progress_detected = True
                break
        after["last_tool_progress"] = progress_detected
        after["no_progress_streak"] = 0 if progress_detected else int(before.get("no_progress_streak") or 0) + 1
    diff = _diff_world_state(before, after)
    return after, diff


__all__ = ["LoopBudget", "new_turn_loop_budget", "transition_world_state"]
