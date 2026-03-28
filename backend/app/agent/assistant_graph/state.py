from __future__ import annotations

import re
from typing import Any, TypedDict


class AgentState(TypedDict, total=False):
    tenant_id: int
    user_id: int
    workroom_id: int
    ui_context: str
    session_id: int | None
    messages: list[dict[str, str]]
    base_messages: list[dict[str, str]]
    session_state: dict[str, Any]
    history_summary: str | None
    session_memory: dict[str, Any]
    studio_document_id: int | None
    studio_snapshot: str | None
    source_file_ids: list[int]
    session_context: dict[str, Any]
    tool_results: list[dict[str, Any]]
    observation_log: list[dict[str, Any]]
    evidence_state: dict[str, Any]
    studio_state: dict[str, Any]
    loaded_tools: list[str]
    tool_search_history: list[dict[str, Any]]
    ag_ui_events: list[dict[str, Any]]
    ag_ui_prompt_events: list[dict[str, Any]]
    tool_summaries: list[dict[str, Any]]
    run_id: str | None
    thread_id: str
    loop_budget: dict[str, Any]


class AgentRuntimeState(TypedDict):
    environment_window: dict[str, Any]
    attention_state: dict[str, Any]
    active_window: dict[str, Any]


def build_default_evidence_state() -> dict[str, Any]:
    return {"items": [], "summary": None}


def build_default_session_context() -> dict[str, Any]:
    return {"session_id": None, "thread_id": None}


def build_default_studio_state() -> dict[str, Any]:
    return {
        "environment_window": {"surface_states": {}},
        "transition_state": {"latest_tool_name": None, "latest_tool_status": None, "added_source_refs": [], "errored_tools": []},
        "attention_state": {"focused_objects": [], "stalled_paths": []},
        "active_window": {"objects": []},
    }


def _derive_default_task_model(
    *,
    goal_anchor: str,
    world_state: dict[str, Any] | None,
    previous: dict[str, Any] | None = None,
) -> dict[str, Any]:
    prev = previous if isinstance(previous, dict) else {}
    binding_status = str(prev.get("binding_status") or "unbound")
    if binding_status not in {"unbound", "candidate_set", "bound"}:
        binding_status = "unbound"

    evidence_status = str(prev.get("evidence_status") or "none")
    if evidence_status not in {"none", "candidate_only", "readable", "sufficient"}:
        evidence_status = "none"

    target_resolution = str(prev.get("target_resolution") or "").strip().lower()
    if target_resolution not in {"unknown", "ambiguous", "resolved"}:
        target_resolution = {
            "unbound": "unknown",
            "candidate_set": "ambiguous",
            "bound": "resolved",
        }.get(binding_status, "unknown")

    conflict_status = str(prev.get("conflict_status") or "none").strip().lower()
    if conflict_status not in {"none", "unresolved", "resolved"}:
        conflict_status = "none"

    return {
        "goal": goal_anchor,
        "binding_status": binding_status,
        "target_resolution": target_resolution,
        "bound_target": prev.get("bound_target") if isinstance(prev.get("bound_target"), dict) else {
            "source_file_id": None,
            "page_no": None,
            "object_ref": None,
        },
        "current_subgoal": str(prev.get("current_subgoal") or "").strip() or "根据环境证据缩小目标并获取可读证据",
        "blocking_reason": str(prev.get("blocking_reason") or "").strip() or None,
        "evidence_status": evidence_status,
        "conflict_status": conflict_status,
        "hypotheses": prev.get("hypotheses") if isinstance(prev.get("hypotheses"), list) else [
            {
                "id": "core_claim",
                "claim": "当前答案是否被直接证据支持",
                "status": "proposed",
                "supporting_evidence_refs": [],
                "contradicting_evidence_refs": [],
                "test_spec": {"required": ["readable_evidence"]},
            }
        ],
        "plan_steps": prev.get("plan_steps") if isinstance(prev.get("plan_steps"), list) else [],
        "evidence_gaps": prev.get("evidence_gaps") if isinstance(prev.get("evidence_gaps"), list) else [
            {
                "id": "gap_target_resolution",
                "gap_type": "target_not_resolved",
                "scope": "task",
                "description": "目标对象尚未唯一解析",
                "status": "open",
                "severity": "high",
                "satisfiable_by": "validator",
                "resolver_kind": "",
                "resolver_args": {},
                "produced_refs": [],
                "last_result": {},
                "error": None,
            },
            {
                "id": "gap_readable_evidence",
                "gap_type": "missing_readable_text",
                "scope": "evidence",
                "description": "缺少可读证据",
                "status": "open",
                "severity": "high",
                "satisfiable_by": "validator",
                "resolver_kind": "",
                "resolver_args": {},
                "produced_refs": [],
                "last_result": {},
                "error": None,
            },
            {
                "id": "gap_conflict_resolution",
                "gap_type": "conflicting_candidates",
                "scope": "task",
                "description": "候选对象或证据之间存在未解冲突",
                "status": "closed" if conflict_status == "none" else "open",
                "severity": "medium",
                "satisfiable_by": "validator",
                "resolver_kind": "",
                "resolver_args": {},
                "produced_refs": [],
                "last_result": {},
                "error": None,
            },
        ],
        "attempted_strategies": prev.get("attempted_strategies") if isinstance(prev.get("attempted_strategies"), list) else [],
        "evidence_assessment": prev.get("evidence_assessment") if isinstance(prev.get("evidence_assessment"), dict) else {},
    }


def _derive_phase_contract(task_model: dict[str, Any]) -> dict[str, Any]:
    target_resolution = str(task_model.get("target_resolution") or "").strip().lower()
    if target_resolution not in {"unknown", "ambiguous", "resolved"}:
        target_resolution = {
            "unbound": "unknown",
            "candidate_set": "ambiguous",
            "bound": "resolved",
        }.get(str(task_model.get("binding_status") or "unbound"), "unknown")
    evidence_status = str(task_model.get("evidence_status") or "none")
    conflict_status = str(task_model.get("conflict_status") or "none").strip().lower()

    unresolved: list[str] = []
    if target_resolution == "unknown":
        unresolved.append("target_unknown")
    elif target_resolution == "ambiguous":
        unresolved.append("target_ambiguous")
    if evidence_status in {"none", "candidate_only"}:
        unresolved.append("readable_evidence_missing")
    if conflict_status == "unresolved":
        unresolved.append("conflict_unresolved")

    if target_resolution in {"unknown", "ambiguous"}:
        stance = "resolve_target"
    elif evidence_status in {"none", "candidate_only"}:
        stance = "read_evidence"
    elif conflict_status == "unresolved":
        stance = "resolve_conflict"
    elif evidence_status == "readable":
        stance = "validate_answer"
    else:
        stance = "answer_ready"

    return {"current_focus": stance, "unresolved_facts": unresolved}


def _derive_default_exec_state(previous: dict[str, Any] | None = None) -> dict[str, Any]:
    prev = previous if isinstance(previous, dict) else {}
    pending_tool_calls_raw = prev.get("pending_tool_calls") if isinstance(prev.get("pending_tool_calls"), list) else []
    pending_tool_calls: list[dict[str, Any]] = []
    for item in pending_tool_calls_raw:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        pending_tool_calls.append(
            {
                "name": name,
                "arguments": item.get("arguments") if isinstance(item.get("arguments"), dict) else {},
                "reason": str(item.get("reason") or ""),
                "call_id": str(item.get("call_id") or ""),
            }
        )
    single = prev.get("pending_tool_call") if isinstance(prev.get("pending_tool_call"), dict) else None
    if single:
        name = str(single.get("name") or "").strip()
        if name:
            pending_tool_calls.append(
                {
                    "name": name,
                    "arguments": single.get("arguments") if isinstance(single.get("arguments"), dict) else {},
                    "reason": str(single.get("reason") or ""),
                    "call_id": str(single.get("call_id") or ""),
                }
            )
    return {
        "wait_status": str(prev.get("wait_status") or "idle"),
        "failure_attribution": str(prev.get("failure_attribution") or ""),
        "retry_budget": int(prev.get("retry_budget") or 2),
        "last_result_ref": prev.get("last_result_ref") if isinstance(prev.get("last_result_ref"), dict) else None,
        "pending_tool_call": prev.get("pending_tool_call") if isinstance(prev.get("pending_tool_call"), dict) else None,
        "pending_tool_calls": pending_tool_calls,
        "pending_user_prompt": str(prev.get("pending_user_prompt") or ""),
        "pending_response": str(prev.get("pending_response") or ""),
        "pending_assistant_tool_message": prev.get("pending_assistant_tool_message") if isinstance(prev.get("pending_assistant_tool_message"), dict) else None,
    }


def _normalize_evidence_gaps(raw_gaps: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for idx, item in enumerate(raw_gaps if isinstance(raw_gaps, list) else []):
        if not isinstance(item, dict):
            continue
        gid = str(item.get("id") or "").strip() or f"gap-{idx+1}"
        status = str(item.get("status") or "open").strip().lower()
        if status == "resolved":
            status = "closed"
        if status not in {"open", "resolving", "closed"}:
            status = "open"
        severity = str(item.get("severity") or "medium").strip().lower()
        if severity not in {"low", "medium", "high"}:
            severity = "medium"
        out.append(
            {
                "id": gid,
                "gap_type": str(item.get("gap_type") or "").strip(),
                "scope": str(item.get("scope") or "").strip(),
                "description": str(item.get("description") or "").strip(),
                "status": status,
                "severity": severity,
                "satisfiable_by": str(item.get("satisfiable_by") or "").strip() or "validator",
                "resolver_kind": str(item.get("resolver_kind") or "").strip(),
                "resolver_args": item.get("resolver_args") if isinstance(item.get("resolver_args"), dict) else {},
                "produced_refs": item.get("produced_refs") if isinstance(item.get("produced_refs"), list) else [],
                "last_result": item.get("last_result") if isinstance(item.get("last_result"), dict) else {},
                "error": str(item.get("error") or "").strip() or None,
            }
        )
    return out


def _normalize_plan_steps(raw_plan: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in (raw_plan if isinstance(raw_plan, list) else []):
        if not isinstance(item, dict):
            continue
        step_id = str(item.get("id") or "").strip() or f"step-{len(out)+1}"
        status = str(item.get("status") or "proposed").strip().lower()
        if status not in {"proposed", "running", "done", "blocked", "abandoned"}:
            status = "proposed"
        objective = str(item.get("objective") or "").strip()
        out.append(
            {
                "id": step_id,
                "status": status,
                "objective": objective,
                "preconditions": item.get("preconditions") if isinstance(item.get("preconditions"), list) else [],
                "exit_condition": str(item.get("exit_condition") or "").strip(),
                "depends_on": item.get("depends_on") if isinstance(item.get("depends_on"), list) else [],
                "generated_from": str(item.get("generated_from") or "").strip(),
            }
        )
    return out


def _sanitize_state_revision(
    revision: dict[str, Any],
    previous_task_state: dict[str, Any],
) -> dict[str, Any]:
    out = dict(revision)

    sanitized_h: list[dict[str, Any]] = []
    for item in (revision.get("hypotheses") if isinstance(revision.get("hypotheses"), list) else []):
        if not isinstance(item, dict):
            continue
        one = {
            k: v
            for k, v in item.items()
            if k not in {"status", "supporting_evidence_refs", "contradicting_evidence_refs"}
        }
        sanitized_h.append(one)
    if sanitized_h:
        out["hypotheses"] = sanitized_h

    sanitized_plan: list[dict[str, Any]] = []
    for item in (revision.get("plan_steps") if isinstance(revision.get("plan_steps"), list) else []):
        if not isinstance(item, dict):
            continue
        one = {
            k: v
            for k, v in item.items()
            if k not in {"status", "depends_on", "generated_from"}
        }
        sanitized_plan.append(one)
    if sanitized_plan:
        out["plan_steps"] = sanitized_plan

    sanitized_g: list[dict[str, Any]] = []
    prev_gaps_by_id: dict[str, dict[str, Any]] = {}
    for prev_gap in (previous_task_state.get("evidence_gaps") if isinstance(previous_task_state.get("evidence_gaps"), list) else []):
        if not isinstance(prev_gap, dict):
            continue
        gid = str(prev_gap.get("id") or "").strip()
        if gid:
            prev_gaps_by_id[gid] = prev_gap
    for item in (revision.get("evidence_gaps") if isinstance(revision.get("evidence_gaps"), list) else []):
        if not isinstance(item, dict):
            continue
        one = {
            k: v
            for k, v in item.items()
            if k not in {"status", "resolver_kind", "resolver_args", "produced_refs", "last_result", "error"}
        }
        gid = str(one.get("id") or "").strip()
        prev_gap = prev_gaps_by_id.get(gid) if gid else None
        if isinstance(prev_gap, dict):
            for key in ("gap_type", "scope", "description", "severity", "satisfiable_by"):
                if not str(one.get(key) or "").strip() and str(prev_gap.get(key) or "").strip():
                    one[key] = prev_gap.get(key)
        sanitized_g.append(one)
    if sanitized_g:
        out["evidence_gaps"] = sanitized_g

    return out


def _merge_task_state(
    *,
    previous_task_state: dict[str, Any],
    revision: dict[str, Any],
    goal_anchor: str,
    world_state: dict[str, Any],
) -> dict[str, Any]:
    base = _derive_default_task_model(goal_anchor=goal_anchor, world_state=world_state, previous=previous_task_state)
    clean = _sanitize_state_revision(revision, previous_task_state=base)
    merged = dict(base)
    merged.update({k: v for k, v in clean.items() if k not in {"hypotheses", "plan_steps", "evidence_gaps"}})
    merged["hypotheses"] = clean.get("hypotheses") if isinstance(clean.get("hypotheses"), list) else base.get("hypotheses")
    merged["plan_steps"] = _normalize_plan_steps(clean.get("plan_steps")) if isinstance(clean.get("plan_steps"), list) else base.get("plan_steps")
    merged["evidence_gaps"] = _normalize_evidence_gaps(clean.get("evidence_gaps")) if isinstance(clean.get("evidence_gaps"), list) else base.get("evidence_gaps")
    return merged


def _extract_json_object(text: str) -> str | None:
    raw = str(text or "")
    if not raw:
        return None
    fenced = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", raw, re.IGNORECASE)
    if fenced:
        return fenced.group(1)
    first = raw.find("{")
    last = raw.rfind("}")
    if first >= 0 and last > first:
        return raw[first : last + 1]
    return None


def _normalize_transition_payload(
    payload: dict[str, Any],
    *,
    latest_user_query: str,
    previous_task_state: dict[str, Any],
    world_state: dict[str, Any],
) -> dict[str, Any]:
    transition = payload.get("task_transition") if isinstance(payload.get("task_transition"), dict) else payload
    state_revision = transition.get("state_revision") if isinstance(transition.get("state_revision"), dict) else {}
    evidence_assessment = transition.get("evidence_assessment") if isinstance(transition.get("evidence_assessment"), dict) else {}
    reason = str(transition.get("reason") or payload.get("reason") or "").strip()

    forbidden_fields = [
        "proposed_next_requirement",
        "requirement",
        "next_step",
        "action",
        "tool",
        "suggested_tool",
        "recommended_action",
        "operation",
        "mode",
        "tool_name",
        "tool_arguments",
        "current_step_id",
        "next_object_id",
    ]
    bad_fields = [k for k in forbidden_fields if k in transition or k in payload]
    protocol_error = "forbidden_next_directive" if bad_fields else ""

    merged_task_state = _merge_task_state(
        previous_task_state=previous_task_state,
        revision={**state_revision, "evidence_assessment": evidence_assessment},
        goal_anchor=str(state_revision.get("goal") or previous_task_state.get("goal") or latest_user_query),
        world_state=world_state,
    )
    phase_contract = _derive_phase_contract(merged_task_state)

    return {
        "reason": reason,
        "state_revision": state_revision,
        "evidence_assessment": evidence_assessment,
        "forbidden_fields": bad_fields,
        "protocol_error": protocol_error,
        "task_state": merged_task_state,
        "phase_contract": phase_contract,
        "latest_user_query": latest_user_query,
    }


def _normalize_agent_decision_payload(
    payload: dict[str, Any],
    *,
    allowed_tool_names: set[str],
) -> dict[str, Any]:
    raw = payload.get("agent_decision") if isinstance(payload.get("agent_decision"), dict) else payload
    intent = str(raw.get("intent") or raw.get("action") or "").strip().lower()
    alias = {
        "tool": "tool_call",
        "call_tool": "tool_call",
        "use_tool": "tool_call",
        "ask": "ask_user",
        "clarify": "ask_user",
        "question": "ask_user",
        "answer": "respond",
        "reply": "respond",
        "done": "finish",
        "stop": "finish",
    }
    intent = alias.get(intent, intent)
    if intent not in {"tool_call", "ask_user", "respond", "finish", "state_only"}:
        intent = "state_only"

    tool_name = str(raw.get("tool_name") or "").strip()
    tool_arguments = raw.get("tool_arguments") if isinstance(raw.get("tool_arguments"), dict) else {}
    raw_tool_calls = raw.get("tool_calls") if isinstance(raw.get("tool_calls"), list) else []
    tool_calls: list[dict[str, Any]] = []
    for item in raw_tool_calls:
        if not isinstance(item, dict):
            continue
        call_name = str(item.get("tool_name") or item.get("name") or "").strip()
        if not call_name:
            continue
        call_args = (
            item.get("tool_arguments")
            if isinstance(item.get("tool_arguments"), dict)
            else (item.get("arguments") if isinstance(item.get("arguments"), dict) else {})
        )
        tool_calls.append({"name": call_name, "arguments": call_args})
    response = str(raw.get("response") or "").strip()
    ask_user_prompt = str(raw.get("ask_user_prompt") or "").strip()
    reason = str(raw.get("reason") or "").strip()
    decision_error = ""

    if intent == "tool_call":
        if tool_calls:
            unknown = next((x.get("name") for x in tool_calls if str(x.get("name") or "") not in allowed_tool_names), None)
            if unknown:
                intent = "state_only"
                decision_error = "unknown_tool_name"
        elif not tool_name:
            intent = "state_only"
            decision_error = "missing_tool_name"
        elif tool_name not in allowed_tool_names:
            intent = "state_only"
            decision_error = "unknown_tool_name"
    if intent == "ask_user" and not ask_user_prompt:
        ask_user_prompt = "缺少继续执行所需信息，请补充你希望我处理的对象或范围。"
    if intent in {"respond", "finish"} and not response:
        intent = "state_only"
        decision_error = decision_error or "missing_response_text"

    return {
        "intent": intent,
        "reason": reason,
        "tool_name": tool_name,
        "tool_arguments": tool_arguments,
        "tool_calls": tool_calls,
        "response": response,
        "ask_user_prompt": ask_user_prompt,
        "decision_error": decision_error,
    }


__all__ = [
    "AgentState",
    "AgentRuntimeState",
    "build_default_evidence_state",
    "build_default_session_context",
    "build_default_studio_state",
    "_derive_default_task_model",
    "_derive_phase_contract",
    "_derive_default_exec_state",
    "_normalize_evidence_gaps",
    "_normalize_plan_steps",
    "_sanitize_state_revision",
    "_merge_task_state",
    "_extract_json_object",
    "_normalize_transition_payload",
    "_normalize_agent_decision_payload",
]

