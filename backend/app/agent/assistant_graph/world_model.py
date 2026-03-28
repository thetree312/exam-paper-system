from __future__ import annotations

import copy
import json
from typing import Any

_LOOP_ALERT_THRESHOLD = 3


def init_world_model(previous: dict[str, Any] | None = None) -> dict[str, Any]:
    base = copy.deepcopy(previous) if isinstance(previous, dict) else {}

    if not isinstance(base.get("runtime_state"), dict):
        base["runtime_state"] = {}
    if not isinstance(base.get("facts"), dict):
        base["facts"] = {}
    if not isinstance(base.get("recent_observations"), list):
        base["recent_observations"] = []
    if not isinstance(base.get("recent_tool_results"), list):
        base["recent_tool_results"] = []
    if not isinstance(base.get("recent_user_inputs"), list):
        base["recent_user_inputs"] = []

    if not isinstance(base.get("topology"), dict):
        base["topology"] = {"runtime": {}}
    if not isinstance(base.get("entities"), dict):
        base["entities"] = {
            "runtime": {},
            "favorites": {},
            "latest_tool": {},
        }
    if not isinstance(base.get("relations"), list):
        base["relations"] = []
    base["version"] = int(base.get("version") or 0)
    base["last_step"] = int(base.get("last_step") or 0)
    if "focus" in base:
        base.pop("focus", None)
    return base


def _trim_tail(items: list[dict[str, Any]], max_items: int = 20) -> list[dict[str, Any]]:
    if len(items) <= max_items:
        return items
    return items[-max_items:]


def _trim_relations(items: list[dict[str, Any]], max_items: int = 50) -> list[dict[str, Any]]:
    uniq: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        src = str(item.get("src") or "")
        rel = str(item.get("rel") or "")
        dst = str(item.get("dst") or "")
        key = (src, rel, dst)
        if key in seen:
            continue
        seen.add(key)
        uniq.append(item)
    if len(uniq) <= max_items:
        return uniq
    return uniq[-max_items:]


def _diff_dict(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    diff: dict[str, Any] = {}
    keys = set(before.keys()) | set(after.keys())
    for key in sorted(keys):
        if before.get(key) != after.get(key):
            diff[key] = {"from": before.get(key), "to": after.get(key)}
    return diff


def _stable_tool_signature(tool_name: str, args: dict[str, Any]) -> str:
    name = str(tool_name or "").strip()
    try:
        encoded = json.dumps(args or {}, ensure_ascii=False, sort_keys=True)
    except Exception:
        encoded = "{}"
    return f"{name}:{encoded}"


def _derive_evidence_status(*, source_refs: list[str], output_obj: dict[str, Any]) -> str:
    answerability = str(output_obj.get("answerability") or "").strip().lower()
    if answerability in {"answerable", "supported", "grounded"}:
        return "sufficient"
    if answerability in {"partial_evidence", "visual_evidence_only", "visual_evidence_available", "evidence_available"}:
        return "readable"
    if source_refs:
        return "readable"
    if output_obj.get("insufficiency") is not None:
        return "insufficient"
    return "none"


def _collect_relation_refs(trace: dict[str, Any]) -> list[str]:
    refs: list[str] = []
    source_refs = trace.get("source_refs") if isinstance(trace.get("source_refs"), list) else []
    for item in source_refs:
        ref = str(item or "").strip()
        if ref:
            refs.append(ref)

    output = trace.get("output") if isinstance(trace.get("output"), dict) else {}
    for key in ("source_refs", "candidate_refs"):
        vals = output.get(key) if isinstance(output.get(key), list) else []
        for item in vals:
            ref = str(item or "").strip()
            if ref:
                refs.append(ref)

    doc_coverage = output.get("doc_coverage") if isinstance(output.get("doc_coverage"), list) else []
    for item in doc_coverage:
        if not isinstance(item, dict):
            continue
        file_id = item.get("file_id")
        try:
            fid = int(file_id)
        except Exception:
            continue
        if fid > 0:
            refs.append(f"file:{fid}")

    evidence_objects = output.get("evidence_objects") if isinstance(output.get("evidence_objects"), list) else []
    for obj in evidence_objects:
        if not isinstance(obj, dict):
            continue
        sr = str(obj.get("source_ref") or "").strip()
        if sr:
            refs.append(sr)
        payload = obj.get("payload") if isinstance(obj.get("payload"), dict) else {}
        file_id = payload.get("file_id")
        try:
            fid = int(file_id)
        except Exception:
            fid = 0
        if fid > 0:
            refs.append(f"file:{fid}")

    uniq: list[str] = []
    seen: set[str] = set()
    for ref in refs:
        if ref in seen:
            continue
        seen.add(ref)
        uniq.append(ref)
    return uniq


def observe_environment(
    previous: dict[str, Any] | None,
    *,
    observation_packet: dict[str, Any],
    step_count: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    before = init_world_model(previous)
    after = copy.deepcopy(before)

    task = observation_packet.get("task") if isinstance(observation_packet.get("task"), dict) else {}
    transition_state = (
        observation_packet.get("runtime_snapshot", {}).get("transition_state")
        if isinstance(observation_packet.get("runtime_snapshot"), dict)
        else {}
    )
    latest_tool = (
        observation_packet.get("latest_tool_observation")
        if isinstance(observation_packet.get("latest_tool_observation"), dict)
        else {}
    )

    after["version"] = int(before.get("version") or 0) + 1
    after["last_step"] = int(step_count)

    runtime_snapshot = observation_packet.get("runtime_snapshot") if isinstance(observation_packet.get("runtime_snapshot"), dict) else {}
    after["runtime_state"] = {
        "runtime_snapshot": runtime_snapshot,
        "task": task,
        "transition_state": transition_state if isinstance(transition_state, dict) else {},
        "latest_tool_observation": latest_tool,
    }

    topology = after.get("topology") if isinstance(after.get("topology"), dict) else {"runtime": {}}
    env_window = runtime_snapshot.get("environment_window") if isinstance(runtime_snapshot.get("environment_window"), dict) else {}
    panels = env_window.get("panels") if isinstance(env_window.get("panels"), dict) else {}
    left_panel = panels.get("left") if isinstance(panels.get("left"), dict) else {}
    center_panel = panels.get("center") if isinstance(panels.get("center"), dict) else {}
    right_panel = panels.get("right") if isinstance(panels.get("right"), dict) else {}
    selection = env_window.get("selection") if isinstance(env_window.get("selection"), dict) else {}
    bindings = env_window.get("bindings") if isinstance(env_window.get("bindings"), dict) else {}
    bound_source_file_ids = list(bindings.get("source_file_ids") or [])
    topology["runtime"] = {
        "workroom_id": env_window.get("workroom_id"),
        "center_panel_mode": center_panel.get("studio_view"),
        "regions": {
            "left": "knowledge_base",
            "center": "studio",
            "right": "agent_drawer",
        },
    }
    after["topology"] = topology

    entities = after.get("entities") if isinstance(after.get("entities"), dict) else {}
    entities["runtime"] = {
        "workroom_id": topology["runtime"].get("workroom_id"),
        "center_panel_mode": topology["runtime"].get("center_panel_mode"),
        "active_center_document_id": selection.get("active_center_document_id"),
        "source_file_ids": bound_source_file_ids,
        "left_knowledge_base": {
            "has_bound_sources": bool(bound_source_file_ids),
            "bound_source_count": len(bound_source_file_ids),
            "pane": left_panel.get("pane"),
        },
        "right_agent_drawer": {
            "open": bool(right_panel.get("is_agent_drawer_open")),
            "view_id": right_panel.get("agent_view_id"),
        },
    }
    entities["latest_tool"] = {
        "tool_name": latest_tool.get("tool_name"),
        "status": latest_tool.get("status"),
        "source_refs": latest_tool.get("source_refs") if isinstance(latest_tool.get("source_refs"), list) else [],
    }
    after["entities"] = entities

    after["relations"] = _trim_relations(list(after.get("relations") or []))

    recent = list(after.get("recent_observations") or [])
    recent.append(
        {
            "step": int(step_count),
            "workroom_id": topology["runtime"].get("workroom_id"),
            "center_panel_mode": topology["runtime"].get("center_panel_mode"),
            "active_center_document_id": entities["runtime"].get("active_center_document_id"),
            "bound_source_count": len(entities["runtime"].get("source_file_ids") or []),
        }
    )
    after["recent_observations"] = _trim_tail(recent, max_items=20)

    after["facts"]["workroom_id"] = topology["runtime"].get("workroom_id")
    after["facts"]["active_center_document_id"] = entities["runtime"].get("active_center_document_id")
    after["facts"]["bound_source_count"] = len(entities["runtime"].get("source_file_ids") or [])
    after["facts"]["center_panel_mode"] = topology["runtime"].get("center_panel_mode")
    after["facts"]["right_agent_drawer_open"] = entities["runtime"]["right_agent_drawer"].get("open")
    after["facts"]["environment_transition"] = transition_state if isinstance(transition_state, dict) else {}
    after["facts"]["target_object"] = str(after["facts"].get("last_user_input") or "").strip()
    if "target_resolution" not in after["facts"]:
        after["facts"]["target_resolution"] = "unknown"
    if "evidence_status" not in after["facts"]:
        after["facts"]["evidence_status"] = "none"
    if "target_candidates_count" not in after["facts"]:
        after["facts"]["target_candidates_count"] = 0

    return after, _diff_dict(before, after)


def record_tool_result(
    previous: dict[str, Any] | None,
    *,
    trace: dict[str, Any],
    step_count: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    before = init_world_model(previous)
    after = copy.deepcopy(before)

    after["version"] = int(before.get("version") or 0) + 1
    after["last_step"] = int(step_count)

    tool_name = str(trace.get("tool_name") or "")
    status = str(trace.get("status") or "")
    observation = trace.get("observation") if isinstance(trace.get("observation"), dict) else {}
    source_refs = _collect_relation_refs(trace)

    recent = list(after.get("recent_tool_results") or [])
    recent.append(
        {
            "step": int(step_count),
            "tool_name": tool_name,
            "status": status,
            "summary": observation.get("summary"),
            "query": observation.get("query"),
            "source_refs": source_refs,
            "target_resolution": (
                (trace.get("output") or {}).get("target_resolution")
                if isinstance(trace.get("output"), dict)
                else None
            ),
        }
    )
    after["recent_tool_results"] = _trim_tail(recent, max_items=20)

    after["facts"]["last_tool_name"] = tool_name
    after["facts"]["last_tool_status"] = status
    output_obj = trace.get("output") if isinstance(trace.get("output"), dict) else {}
    if output_obj.get("answerability") is not None:
        after["facts"]["answerability"] = output_obj.get("answerability")
    if output_obj.get("target_resolution") is not None:
        after["facts"]["target_resolution"] = output_obj.get("target_resolution")
    candidate_refs = output_obj.get("candidate_refs") if isinstance(output_obj.get("candidate_refs"), list) else []
    if candidate_refs:
        after["facts"]["target_candidates_count"] = len(candidate_refs)
    elif source_refs:
        after["facts"]["target_candidates_count"] = len(source_refs)
    after["facts"]["evidence_status"] = _derive_evidence_status(source_refs=source_refs, output_obj=output_obj)
    query_text = str(observation.get("query") or "").strip()
    if query_text:
        after["facts"]["target_object"] = query_text

    args_obj = trace.get("arguments") if isinstance(trace.get("arguments"), dict) else {}
    signature = _stable_tool_signature(tool_name, args_obj)
    prev_signature = str(before.get("facts", {}).get("last_tool_signature") or "")
    same_tool_streak = int(before.get("facts", {}).get("same_tool_streak") or 0) + 1 if signature and signature == prev_signature else 1

    prev_refs = set(str(x) for x in (before.get("facts", {}).get("last_source_refs") or []) if str(x).strip())
    current_refs = set(source_refs)
    has_new_refs = bool(current_refs - prev_refs)

    summary_obj = output_obj.get("evidence_summary") if isinstance(output_obj.get("evidence_summary"), dict) else {}
    current_evidence_count = int(summary_obj.get("evidence_count") or len(source_refs or []))
    prev_evidence_count = int(before.get("facts", {}).get("last_evidence_count") or 0)
    answerability = str(output_obj.get("answerability") or "").strip().lower()
    progress_detected = has_new_refs or (current_evidence_count > prev_evidence_count) or (
        answerability in {"answerable", "partial_evidence", "visual_evidence_only", "visual_evidence_available"}
    )
    no_progress_streak = 0 if progress_detected else int(before.get("facts", {}).get("no_progress_streak") or 0) + 1

    after["facts"]["last_tool_signature"] = signature
    after["facts"]["same_tool_streak"] = int(same_tool_streak)
    after["facts"]["no_progress_streak"] = int(no_progress_streak)
    after["facts"]["last_tool_progress"] = bool(progress_detected)
    after["facts"]["last_source_refs"] = list(source_refs)
    after["facts"]["last_evidence_count"] = int(current_evidence_count)

    if same_tool_streak >= _LOOP_ALERT_THRESHOLD or no_progress_streak >= _LOOP_ALERT_THRESHOLD:
        after["facts"]["strategy_feedback"] = {
            "status": "warning",
            "reason": "loop_detected",
            "message": (
                "你已连续多次调用工具但进展有限。请切换策略：收窄目标范围、改用不同工具，"
                "或向用户请求更具体约束。"
            ),
            "signals": {
                "same_tool_streak": int(same_tool_streak),
                "no_progress_streak": int(no_progress_streak),
                "threshold": int(_LOOP_ALERT_THRESHOLD),
                "last_tool_name": tool_name,
            },
        }
    else:
        after["facts"]["strategy_feedback"] = {}

    relations = list(after.get("relations") or [])
    entities = after.get("entities") if isinstance(after.get("entities"), dict) else {}
    for ref in source_refs:
        src = str(ref or "").strip()
        if src:
            relations.append({"src": tool_name, "rel": "observed", "dst": src})
    entities["latest_tool"] = {
        "tool_name": tool_name,
        "status": status,
        "source_refs": source_refs,
    }
    after["entities"] = entities
    after["relations"] = _trim_relations(relations)

    return after, _diff_dict(before, after)


def record_user_input(
    previous: dict[str, Any] | None,
    *,
    text: str,
    step_count: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    before = init_world_model(previous)
    after = copy.deepcopy(before)

    after["version"] = int(before.get("version") or 0) + 1
    after["last_step"] = int(step_count)

    normalized = str(text or "").strip()
    recent = list(after.get("recent_user_inputs") or [])
    recent.append({"step": int(step_count), "text": normalized})
    after["recent_user_inputs"] = _trim_tail(recent, max_items=20)
    after["facts"]["last_user_input"] = normalized
    after["facts"]["target_object"] = normalized
    after["facts"]["target_resolution"] = "unknown"
    after["facts"]["target_candidates_count"] = 0
    after["facts"]["evidence_status"] = "none"

    return after, _diff_dict(before, after)


def query_world_model(
    model: dict[str, Any] | None,
    *,
    path: str,
    tail: int = 8,
) -> Any:
    wm = init_world_model(model)
    if tail < 1:
        tail = 1
    if tail > 20:
        tail = 20

    view = {
        "world_model": wm,
        "topology": wm.get("topology") if isinstance(wm.get("topology"), dict) else {},
        "entities": wm.get("entities") if isinstance(wm.get("entities"), dict) else {},
        "relations": list(wm.get("relations") or [])[-tail:],
        "recent_observations": list(wm.get("recent_observations") or [])[-tail:],
        "recent_tool_results": list(wm.get("recent_tool_results") or [])[-tail:],
        "recent_user_inputs": list(wm.get("recent_user_inputs") or [])[-tail:],
        "runtime_state": wm.get("runtime_state") if isinstance(wm.get("runtime_state"), dict) else {},
        "facts": wm.get("facts") if isinstance(wm.get("facts"), dict) else {},
    }

    if not str(path or "").strip():
        return view

    cursor: Any = view
    for seg in [x for x in str(path or "").split(".") if x]:
        if not isinstance(cursor, dict):
            return None
        cursor = cursor.get(seg)
    return cursor

