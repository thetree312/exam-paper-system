from __future__ import annotations

import json
from typing import Any

_MAX_REGISTER_FRAMES = 4
_MAX_CARRYFORWARD_FRAMES = 2


def _as_source_refs(values: Any) -> list[str]:
    out: list[str] = []
    for item in values if isinstance(values, list) else []:
        ref = str(item or "").strip()
        if ref:
            out.append(ref)
    return out


def _content_has_image_parts(content: Any) -> bool:
    if not isinstance(content, list):
        return False
    for item in content:
        if not isinstance(item, dict):
            continue
        if str(item.get("type") or "").strip().lower() == "image_url":
            return True
    return False


def _frame_identity(frame: dict[str, Any]) -> tuple[str, str, tuple[str, ...]]:
    return (
        str(frame.get("tool_name") or "").strip(),
        str(frame.get("query") or "").strip(),
        tuple(_as_source_refs(frame.get("source_refs"))),
    )


def build_tool_receipt_message(
    *,
    tool_name: str,
    tool_call_id: str,
    trace: dict[str, Any],
    output: dict[str, Any],
) -> dict[str, Any]:
    observation = trace.get("observation") if isinstance(trace.get("observation"), dict) else {}
    receipt = {
        "tool_name": str(tool_name or "").strip(),
        "tool_call_id": str(tool_call_id or "").strip(),
        "status": str(trace.get("status") or "").strip(),
        "query": str(observation.get("query") or "").strip(),
        "summary": str(observation.get("summary") or "").strip(),
        "answerability": str(output.get("answerability") or "").strip(),
        "target_resolution": str(output.get("target_resolution") or "").strip(),
        "source_refs": _as_source_refs(output.get("source_refs") or trace.get("source_refs")),
    }
    return {
        "role": "tool",
        "name": str(tool_name or "").strip(),
        "tool_call_id": str(tool_call_id or "").strip(),
        "content": [{"type": "text", "text": json.dumps(receipt, ensure_ascii=False)}],
    }


def build_evidence_frame(
    *,
    tool_name: str,
    tool_call_id: str,
    trace: dict[str, Any],
    output: dict[str, Any],
    step_count: int,
) -> dict[str, Any] | None:
    content = output.get("model_message_content")
    if not isinstance(content, list) or not content:
        return None
    source_refs = _as_source_refs(output.get("source_refs") or trace.get("source_refs"))
    if not source_refs:
        return None
    observation = trace.get("observation") if isinstance(trace.get("observation"), dict) else {}
    return {
        "frame_id": f"frame:{tool_call_id or tool_name}",
        "tool_name": str(tool_name or "").strip(),
        "tool_call_id": str(tool_call_id or "").strip(),
        "query": str(observation.get("query") or "").strip(),
        "source_refs": source_refs,
        "answerability": str(output.get("answerability") or "").strip(),
        "target_resolution": str(output.get("target_resolution") or "").strip(),
        "summary": str(observation.get("summary") or "").strip(),
        "content": content,
        "has_image": _content_has_image_parts(content),
        "created_step": int(step_count or 0),
        "last_selected_step": None,
    }


def merge_evidence_register(
    existing: list[dict[str, Any]] | None,
    incoming: list[dict[str, Any]] | None,
    *,
    max_frames: int = _MAX_REGISTER_FRAMES,
) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    for item in existing or []:
        if isinstance(item, dict):
            merged.append(dict(item))

    for item in incoming or []:
        if not isinstance(item, dict):
            continue
        identity = _frame_identity(item)
        replaced = False
        for idx, current in enumerate(merged):
            if _frame_identity(current) == identity:
                merged[idx] = {**current, **item}
                replaced = True
                break
        if not replaced:
            merged.append(dict(item))

    merged.sort(
        key=lambda frame: (
            int(frame.get("created_step") or 0),
            int(frame.get("last_selected_step") or -1),
        )
    )
    return merged[-max_frames:]


def select_carryforward_evidence_messages(
    register: list[dict[str, Any]] | None,
    *,
    transient_tool_messages: list[dict[str, Any]] | None = None,
    step_count: int = 0,
    max_frames: int = _MAX_CARRYFORWARD_FRAMES,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    transient_ids = {
        str(item.get("tool_call_id") or "").strip()
        for item in transient_tool_messages or []
        if isinstance(item, dict)
    }
    selected_messages: list[dict[str, Any]] = []
    updated_register: list[dict[str, Any]] = []
    candidates = [dict(item) for item in register or [] if isinstance(item, dict)]
    candidates.sort(
        key=lambda frame: (
            0
            if str(frame.get("answerability") or "").strip().lower()
            in {"answerable", "evidence_available", "partial_evidence", "visual_evidence_only", "visual_evidence_available"}
            else 1,
            0 if bool(frame.get("has_image")) else 1,
            -int(frame.get("created_step") or 0),
        )
    )

    selected_ids: set[str] = set()
    for frame in candidates:
        tool_call_id = str(frame.get("tool_call_id") or "").strip()
        if tool_call_id and tool_call_id in transient_ids:
            updated_register.append(frame)
            continue
        if len(selected_ids) >= max_frames:
            updated_register.append(frame)
            continue
        content = frame.get("content")
        if not isinstance(content, list) or not content:
            updated_register.append(frame)
            continue
        assistant_call_id = f"carry-{frame.get('frame_id') or tool_call_id or len(selected_ids)+1}"
        selected_messages.append(
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": assistant_call_id,
                        "type": "function",
                        "function": {
                            "name": str(frame.get("tool_name") or "carryforward_evidence"),
                            "arguments": json.dumps(
                                {
                                    "query": str(frame.get("query") or ""),
                                    "source_refs": _as_source_refs(frame.get("source_refs")),
                                    "carryforward": True,
                                },
                                ensure_ascii=False,
                            ),
                        },
                    }
                ],
            }
        )
        selected_messages.append(
            {
                "role": "tool",
                "name": str(frame.get("tool_name") or "carryforward_evidence"),
                "tool_call_id": assistant_call_id,
                "content": content,
            }
        )
        frame["last_selected_step"] = int(step_count or 0)
        selected_ids.add(str(frame.get("frame_id") or assistant_call_id))
        updated_register.append(frame)

    if len(updated_register) < len(candidates):
        known = {str(item.get("frame_id") or "") for item in updated_register}
        for frame in candidates:
            if str(frame.get("frame_id") or "") in known:
                continue
            updated_register.append(frame)

    return selected_messages, updated_register[-_MAX_REGISTER_FRAMES:]


def summarize_evidence_register(register: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in register or []:
        if not isinstance(item, dict):
            continue
        out.append(
            {
                "tool_name": str(item.get("tool_name") or "").strip(),
                "query": str(item.get("query") or "").strip(),
                "source_refs": _as_source_refs(item.get("source_refs")),
                "answerability": str(item.get("answerability") or "").strip(),
                "target_resolution": str(item.get("target_resolution") or "").strip(),
                "summary": str(item.get("summary") or "").strip(),
                "has_image": bool(item.get("has_image")),
                "created_step": int(item.get("created_step") or 0),
                "last_selected_step": item.get("last_selected_step"),
            }
        )
    return out[-_MAX_REGISTER_FRAMES:]
