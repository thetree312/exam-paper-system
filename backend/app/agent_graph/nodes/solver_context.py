from __future__ import annotations

import hashlib
import json
from typing import Any

from ..helpers import _trim_text
from ..prompt_slots import _dialogue_window_snippet, _session_state_view
from ..runtime import logger
from ..types import AgentState, _student_answer_snapshot


def _build_dialogue_snippet(state: AgentState, history_summary: str) -> str:
    snippet = _dialogue_window_snippet(state.get("dialogue_window"))
    if snippet:
        return snippet
    summary = (history_summary or "").strip()
    if summary:
        return f"【历史对话摘要】\n{_trim_text(summary, 360)}"
    return ""


def _json_dump(data: Any) -> str:
    if not data:
        return "{}"
    try:
        return json.dumps(data, ensure_ascii=False)
    except Exception:  # noqa: BLE001
        return "{}"


def prepare_solver_context_bundle(state: AgentState) -> dict:
    doc_ctx_raw = state.get("doc_context") or ""
    doc_ctx_text = doc_ctx_raw if doc_ctx_raw.strip() else "（当前未注入题干）"
    vision_summary_raw = state.get("vision_summary") or ""
    vision_summary_text = vision_summary_raw.strip() or "（无视觉摘要）"
    history_summary = state.get("history_summary") or ""

    intent_session_view = _session_state_view(state, "solver_intent")
    reply_session_view = _session_state_view(state, "solver_reply")
    intent_session_view_json = _json_dump(intent_session_view)
    reply_session_view_json = _json_dump(reply_session_view)

    dialogue_snippet = _build_dialogue_snippet(state, history_summary)
    student_snapshot = _student_answer_snapshot(state.get("question_contexts") or [])

    supervisor_instruction = state.get("supervisor_directive") or ""
    intent_context = {
        "supervisor_instruction": supervisor_instruction,
        "doc_context": doc_ctx_text,
        "vision_summary": vision_summary_text,
        "history_summary": history_summary,
        "session_profile": intent_session_view,
        "session_state_view": intent_session_view,
    }

    batch_cfg_for_instruction = state.get("batch_config") if state.get("batch_config_required") else None
    instruction_base = {
        "doc_context": doc_ctx_text,
        "vision_summary": vision_summary_text,
        "student_answer_snapshot": student_snapshot,
        "batch_config": (
            json.dumps(batch_cfg_for_instruction, ensure_ascii=False)
            if isinstance(batch_cfg_for_instruction, dict) and batch_cfg_for_instruction
            else "未指定"
        ),
        "history_summary": history_summary,
        "session_profile": intent_session_view_json,
        "session_state_view": intent_session_view_json,
    }

    reply_batch_cfg = state.get("batch_config")
    reply_instruction_base = {
        "doc_context": doc_ctx_text,
        "vision_summary": vision_summary_text,
        "student_answer_snapshot": student_snapshot,
        "batch_config": (
            json.dumps(reply_batch_cfg, ensure_ascii=False)
            if isinstance(reply_batch_cfg, dict) and reply_batch_cfg
            else "未指定"
        ),
        "history_summary": history_summary,
        "session_profile": reply_session_view_json,
        "session_state_view": reply_session_view_json,
    }

    bundle = {
        "doc_context_raw": doc_ctx_raw,
        "doc_context_text": doc_ctx_text,
        "vision_summary_raw": vision_summary_raw,
        "vision_summary_text": vision_summary_text,
        "history_summary_text": history_summary,
        "intent_session_view": intent_session_view,
        "intent_session_view_json": intent_session_view_json,
        "reply_session_view": reply_session_view,
        "reply_session_view_json": reply_session_view_json,
        "dialogue_snippet": dialogue_snippet,
        "student_snapshot": student_snapshot,
        "intent_context": intent_context,
        "instruction_base": instruction_base,
        "reply_instruction_base": reply_instruction_base,
        "supervisor_instruction": supervisor_instruction,
    }
    logger.info(
        "agent.graph.solver_context.bundle tenant=%s user=%s doc_context=%s vision_summary=%s history_summary=%s dialogue_snippet=%s student_snapshot=%s intent_context=%s instruction_base=%s reply_instruction_base=%s",
        state.get("tenant_id"),
        state.get("user_id"),
        doc_ctx_text,
        vision_summary_text,
        history_summary,
        dialogue_snippet,
        student_snapshot,
        intent_context,
        instruction_base,
        reply_instruction_base,
    )
    return bundle


def _build_sections(bundle: dict) -> dict:
    return {
        "doc_context_raw": bundle.get("doc_context_raw") or "",
        "doc_context_text": bundle.get("doc_context_text") or bundle.get("doc_context_raw") or "",
        "vision_summary_text": bundle.get("vision_summary_text") or "（无视觉摘要）",
        "history_summary_text": bundle.get("history_summary_text") or "",
        "dialogue_snippet": bundle.get("dialogue_snippet") or "",
        "intent_session_view_json": bundle.get("intent_session_view_json") or "{}",
        "reply_session_view_json": bundle.get("reply_session_view_json") or "{}",
    }


FINGERPRINT_FIELDS = [
    "doc_context",
    "vision_summary",
    "history_summary",
    "dialogue_window",
    "session_state",
    "session_profile",
    "batch_config",
    "batch_config_required",
    "batch_config_epoch",
    "supervisor_directive",
    "question_contexts",
    "note_focus",
    "note_context_text",
]


def _hash_payload(payload: Any) -> str:
    try:
        serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    except Exception:  # noqa: BLE001
        serialized = repr(payload)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _solver_context_fingerprint(state: AgentState) -> str:
    signature = {field: state.get(field) for field in FINGERPRINT_FIELDS}
    return _hash_payload(signature)


def solver_context_node(state: AgentState) -> AgentState:
    if state.get("skip_model"):
        return state

    fingerprint = _solver_context_fingerprint(state)
    prev_fingerprint = state.get("solver_context_fingerprint")

    bundle = state.get("solver_context_bundle") if fingerprint == prev_fingerprint else None
    sections = state.get("solver_context_sections") if fingerprint == prev_fingerprint else None

    if not isinstance(bundle, dict):
        bundle = prepare_solver_context_bundle(state)
    if not isinstance(sections, dict):
        sections = _build_sections(bundle)

    new_state = dict(state)
    new_state["solver_context_bundle"] = bundle
    new_state["solver_context_sections"] = sections
    new_state["solver_context_fingerprint"] = fingerprint
    return new_state


__all__ = ["prepare_solver_context_bundle", "solver_context_node"]
