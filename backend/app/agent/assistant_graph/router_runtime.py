from __future__ import annotations

import copy
from dataclasses import dataclass
import json
import re
from typing import Any, Iterable

from sqlalchemy import text

from ..services.agent_service import AgentService


def compact_short_term_messages(
    messages: list[dict[str, Any]] | None,
    *,
    max_rounds: int = 12,
) -> tuple[list[dict[str, Any]], str | None]:
    records = list(messages or [])
    if max_rounds <= 0:
        return records, None

    user_assistant_idx: list[int] = []
    for idx, item in enumerate(records):
        role = str(item.get("role") or "").lower()
        if role in ("user", "assistant"):
            user_assistant_idx.append(idx)

    keep_count = max_rounds * 2
    if len(user_assistant_idx) <= keep_count:
        return records, None

    first_keep = user_assistant_idx[-keep_count]
    dropped = records[:first_keep]
    kept = records[first_keep:]

    dropped_turns = max(1, len([m for m in dropped if str(m.get("role") or "").lower() == "user"]))
    first_hint = str((dropped[0] or {}).get("content") or "").strip() if dropped else ""
    last_hint = str((dropped[-1] or {}).get("content") or "").strip() if dropped else ""
    summary = (
        f"Earlier conversation compressed: {dropped_turns} rounds summarized before latest {max_rounds} rounds. "
        f"Range: {first_hint} ... {last_hint}"
    ).strip()
    return kept, summary


def _dedupe_preserve_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in values:
        key = str(item or "").strip()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(key)
    return out


def build_runtime_snapshot(context: dict[str, Any]) -> dict[str, Any]:
    environment = context.get("environment") or {}
    surfaces = environment.get("surfaces") if isinstance(environment.get("surfaces"), dict) else {}
    studio_surface = surfaces.get("studio") if isinstance(surfaces.get("studio"), dict) else {}
    kb_surface = surfaces.get("knowledge_base") if isinstance(surfaces.get("knowledge_base"), dict) else {}
    favorites_surface = surfaces.get("favorites") if isinstance(surfaces.get("favorites"), dict) else {}
    active_surface = environment.get("active_surface") or context.get("ui_context") or "studio"
    studio_document_id = studio_surface.get("studio_document_id", context.get("studio_document_id"))
    source_file_ids = list(kb_surface.get("source_file_ids") or context.get("source_file_ids") or [])
    resource_summary = studio_surface.get("resource_summary") if isinstance(studio_surface.get("resource_summary"), dict) else {}
    active_selection = studio_surface.get("active_selection") if isinstance(studio_surface.get("active_selection"), dict) else {}
    studio_view = studio_surface.get("studio_view") or context.get("ui_context")
    return {
        "environment_window": {
            "active_surface": active_surface,
            "surface_states": {
                str(active_surface): {
                    "studio_document_id": studio_document_id,
                    "source_file_ids": source_file_ids,
                    "studio_view": studio_view,
                    "resource_summary": resource_summary,
                    "active_selection": active_selection,
                    "favorite_question_count": int(favorites_surface.get("favorite_question_count") or 0),
                }
            },
        },
        "attention_state": {"focused_objects": [], "stalled_paths": []},
        "active_window": {"objects": [], "studio_document_id": studio_document_id},
        "task": {"phase": "created", "step_count": 0},
    }


def evolve_runtime_snapshot(
    *,
    previous: dict[str, Any] | None,
    context: dict[str, Any],
    task_phase: str,
    step_count: int,
    tool_results: list[dict[str, Any]] | None = None,
    recent_changes: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    snapshot = copy.deepcopy(previous) if isinstance(previous, dict) and previous else build_runtime_snapshot(context)

    env = snapshot.setdefault("environment_window", {})
    active_surface = (
        ((context.get("environment") or {}).get("active_surface"))
        or context.get("ui_context")
        or env.get("active_surface")
        or "studio"
    )
    env["active_surface"] = active_surface
    surface_states = env.setdefault("surface_states", {})
    if not isinstance(surface_states, dict):
        surface_states = {}
        env["surface_states"] = surface_states
    active_state = surface_states.setdefault(
        str(active_surface),
        {
            "studio_document_id": context.get("studio_document_id"),
            "source_file_ids": list(context.get("source_file_ids") or []),
        },
    )
    if isinstance(active_state, dict):
        active_state["studio_document_id"] = context.get("studio_document_id")
        active_state["source_file_ids"] = list(context.get("source_file_ids") or [])

    attention = snapshot.setdefault("attention_state", {})
    focused_objects = list(attention.get("focused_objects") or [])
    stalled_paths = list(attention.get("stalled_paths") or [])
    active_window = snapshot.setdefault("active_window", {})
    active_objects = list(active_window.get("objects") or [])

    for result in tool_results or []:
        if not isinstance(result, dict):
            continue
        tool_name = str(result.get("tool_name") or "")
        status = str(result.get("status") or "")
        refs = [str(x) for x in (result.get("source_refs") or []) if str(x).strip()]
        focused_objects.extend(refs)
        active_objects.extend(refs)
        if status == "error" and tool_name:
            stalled_paths.append(tool_name)

    for change in recent_changes or []:
        if not isinstance(change, dict):
            continue
        refs = [str(x) for x in (change.get("source_refs") or []) if str(x).strip()]
        focused_objects.extend(refs)
        active_objects.extend(refs)
        tool_name = str(change.get("tool_name") or "")
        if str(change.get("change_type") or "") == "tool_error" and tool_name:
            stalled_paths.append(tool_name)

    attention["focused_objects"] = _dedupe_preserve_order(focused_objects)
    attention["stalled_paths"] = _dedupe_preserve_order(stalled_paths)
    active_window["objects"] = _dedupe_preserve_order(active_objects)
    snapshot["task"] = {"phase": task_phase, "step_count": int(step_count)}
    return snapshot


def build_agent_router_context(
    *,
    tenant_id: int,
    user_id: int,
    workroom_id: int,
    studio_document_id: int | None,
    source_file_ids: list[int],
    ui_context: str,
    session_id: int | None,
    thread_id: str,
    environment_model: dict[str, Any] | None = None,
) -> dict[str, Any]:
    env = environment_model if isinstance(environment_model, dict) else {}
    return {
        "tenant_id": tenant_id,
        "user_id": user_id,
        "workroom_id": workroom_id,
        "studio_document_id": studio_document_id,
        "source_file_ids": source_file_ids,
        "ui_context": ui_context,
        "session_id": session_id,
        "thread_id": thread_id,
        "environment": env or {
            "active_surface": ui_context,
            "studio_document_id": studio_document_id,
            "source_file_ids": source_file_ids,
        },
    }


def build_agent_environment_model(
    *,
    db: Any,
    tenant_id: int,
    user_id: int,
    workroom_id: int,
    studio_document_id: int | None,
    source_file_ids: list[int],
    ui_context: str,
) -> dict[str, Any]:
    src_ids = [int(x) for x in (source_file_ids or []) if str(x).strip().isdigit()]
    resolved_document_id = int(studio_document_id) if studio_document_id is not None else None
    runtime_row = db.execute(
        text(
            """
            SELECT active_studio_document_id, center_panel_state_json
            FROM workroom_runtime_states
            WHERE tenant_id = :tenant_id
              AND user_id = :user_id
              AND workroom_id = :workroom_id
            LIMIT 1
            """
        ),
        {"tenant_id": int(tenant_id), "user_id": int(user_id), "workroom_id": int(workroom_id)},
    ).fetchone()
    center_panel_state: dict[str, Any] = {}
    if runtime_row:
        active_doc = runtime_row[0]
        raw_center = runtime_row[1]
        if resolved_document_id is None and active_doc is not None:
            resolved_document_id = int(active_doc)
        if isinstance(raw_center, dict):
            center_panel_state = raw_center

    studio_view = str(center_panel_state.get("studio_view") or "").strip() or None
    studio_artifact_counts = {"ocr_item": 0, "mindmap_state": 0, "flashcard_state": 0}
    if resolved_document_id is not None:
        artifact_rows = db.execute(
            text(
                """
                SELECT artifact_type, COUNT(1) AS cnt
                FROM workroom_panel_artifacts
                WHERE tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND workroom_id = :workroom_id
                  AND (studio_document_id = :document_id OR studio_document_id IS NULL)
                GROUP BY artifact_type
                """
            ),
            {
                "tenant_id": int(tenant_id),
                "user_id": int(user_id),
                "workroom_id": int(workroom_id),
                "document_id": int(resolved_document_id),
            },
        ).fetchall()
        for row in artifact_rows:
            key = str(row[0] or "").strip()
            if key in studio_artifact_counts:
                studio_artifact_counts[key] = int(row[1] or 0)

    question_card_count = 0
    flashcard_count = 0
    mindmap_node_count = 0
    mindmap_edge_count = 0
    studio_title = ""
    if resolved_document_id is not None:
        doc_row = db.execute(
            text(
                """
                SELECT title, mindmap_cache
                FROM documents
                WHERE id = :document_id
                  AND tenant_id = :tenant_id
                  AND owner_user_id = :user_id
                LIMIT 1
                """
            ),
            {"document_id": int(resolved_document_id), "tenant_id": int(tenant_id), "user_id": int(user_id)},
        ).fetchone()
        if doc_row:
            studio_title = str(doc_row[0] or "")
            raw_mindmap = str(doc_row[1] or "").strip()
            if raw_mindmap:
                try:
                    parsed = json.loads(raw_mindmap)
                    if isinstance(parsed, dict):
                        nodes = parsed.get("nodes") if isinstance(parsed.get("nodes"), list) else []
                        edges = parsed.get("edges") if isinstance(parsed.get("edges"), list) else []
                        mindmap_node_count = len(nodes)
                        mindmap_edge_count = len(edges)
                except Exception:
                    mindmap_node_count = 0
                    mindmap_edge_count = 0

        question_card_count = int(
            db.execute(
                text(
                    """
                    SELECT COUNT(1)
                    FROM questions
                    WHERE tenant_id = :tenant_id
                      AND document_id = :document_id
                    """
                ),
                {"tenant_id": int(tenant_id), "document_id": int(resolved_document_id)},
            ).scalar()
            or 0
        )
        flashcard_count = int(
            db.execute(
                text(
                    """
                    SELECT COUNT(1)
                    FROM flashcard_concepts
                    WHERE tenant_id = :tenant_id
                      AND document_id = :document_id
                    """
                ),
                {"tenant_id": int(tenant_id), "document_id": int(resolved_document_id)},
            ).scalar()
            or 0
        )

    favorite_question_count = int(
        db.execute(
            text(
                """
                SELECT COUNT(1)
                FROM question_favorites
                WHERE tenant_id = :tenant_id
                  AND user_id = :user_id
                """
            ),
            {"tenant_id": int(tenant_id), "user_id": int(user_id)},
        ).scalar()
        or 0
    )

    return {
        "active_surface": str(ui_context or "studio"),
        "surfaces": {
            "knowledge_base": {
                "source_file_ids": src_ids,
                "source_count": len(src_ids),
            },
            "studio": {
                "studio_document_id": resolved_document_id,
                "title": studio_title,
                "studio_view": studio_view,
                "resource_summary": {
                    "question_card_count": int(question_card_count),
                    "mindmap_node_count": int(mindmap_node_count),
                    "mindmap_edge_count": int(mindmap_edge_count),
                    "flashcard_count": int(flashcard_count),
                    "ocr_item_count": int(studio_artifact_counts.get("ocr_item", 0)),
                },
            },
            "favorites": {
                "favorite_question_count": int(favorite_question_count),
            },
        },
    }


def normalize_stream_event(raw_event: Any) -> tuple[str, Any]:
    if isinstance(raw_event, tuple) and len(raw_event) == 2:
        return str(raw_event[0]), raw_event[1]
    return "updates", raw_event


def _extract_assistant_text_from_message(message: Any) -> str | None:
    if message is None:
        return None
    m_type = str(getattr(message, "type", "")).lower()
    if "ai" not in m_type and "assistant" not in m_type:
        return None
    content = getattr(message, "content", None)
    if content is None:
        return None
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, dict):
                part_text = part.get("text")
                if part_text is not None:
                    parts.append(str(part_text))
            elif part is not None:
                parts.append(str(part))
        text = "".join(parts)
    else:
        text = str(content)
    return text if text else None


_DATA_URL_RE = re.compile(r"^(data:[^;]+;base64,)([A-Za-z0-9+/=\s]+)$", re.IGNORECASE)


def _preview_base64_string(value: str) -> str:
    raw = str(value or "")
    matched = _DATA_URL_RE.match(raw.strip())
    if not matched:
        return raw
    prefix, payload = matched.group(1), matched.group(2)
    compact = re.sub(r"\s+", "", payload)
    head = compact[:24]
    return f"{prefix}{head}...[base64_len={len(compact)}]"


def _json_safe(value: Any, *, max_len: int = 4000) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        preview = _preview_base64_string(value)
        if len(preview) <= max_len:
            return preview
        return preview[:max_len] + f"...[truncated {len(preview) - max_len} chars]"
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            out[str(k)] = _json_safe(v, max_len=max_len)
        return out
    if isinstance(value, (list, tuple)):
        return [_json_safe(v, max_len=max_len) for v in value]
    return _json_safe(str(value), max_len=max_len)


def _extract_message_tool_calls(message: Any) -> list[dict[str, Any]]:
    raw = getattr(message, "tool_calls", None)
    calls: list[dict[str, Any]] = []
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            calls.append(
                {
                    "id": item.get("id"),
                    "name": item.get("name"),
                    "args": _json_safe(item.get("args")),
                }
            )
    return calls


def _extract_model_trace_event(message: Any, metadata: Any) -> dict[str, Any] | None:
    m_type = str(getattr(message, "type", "")).strip().lower()
    if m_type not in ("ai", "assistant"):
        return None
    message_id = getattr(message, "id", None)
    if message_id is not None:
        message_id = str(message_id)
    payload: dict[str, Any] = {
        "trace_type": "model_event",
        "message_type": m_type,
        "message_id": message_id,
        "content": _json_safe(getattr(message, "content", None)),
        "tool_calls": _extract_message_tool_calls(message),
    }
    if isinstance(metadata, dict):
        payload["node"] = metadata.get("langgraph_node") or metadata.get("node")
    return payload


def iter_stream_trace_events(mode: str, event_payload: Any) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    if mode == "messages" and isinstance(event_payload, tuple) and len(event_payload) >= 1:
        message = event_payload[0]
        metadata = event_payload[1] if len(event_payload) > 1 else None
        text = _extract_assistant_text_from_message(message)
        if text:
            message_id = getattr(message, "id", None)
            if message_id is not None:
                message_id = str(message_id)
            events.append({"kind": "assistant_text", "id": message_id, "text": text})
        model_trace_payload = _extract_model_trace_event(message, metadata)
        if isinstance(model_trace_payload, dict):
            events.append(
                {
                    "kind": "agent_trace",
                    "node": model_trace_payload.get("node"),
                    "payload": model_trace_payload,
                }
            )
        return events

    if mode != "updates" or not isinstance(event_payload, dict):
        return events

    for node_name, node_update in event_payload.items():
        if not isinstance(node_update, dict):
            continue

        for result in node_update.get("tool_results") or []:
            if not isinstance(result, dict):
                continue
            obs = result.get("observation") or {}
            events.append(
                {
                    "kind": "agent_trace",
                    "node": node_name,
                    "payload": {
                        "trace_type": "tool_call",
                        "node": node_name,
                        "tool_name": result.get("tool_name"),
                        "status": result.get("status"),
                        "tool_call_id": result.get("tool_call_id"),
                        "observation": _json_safe(result.get("observation")),
                        "output": _json_safe(result.get("output")),
                        "query": obs.get("query"),
                    },
                }
            )

        for native_trace in node_update.get("model_native_traces") or []:
            if not isinstance(native_trace, dict):
                continue
            payload = dict(native_trace)
            payload.setdefault("trace_type", "model_native_thinking")
            payload.setdefault("node", node_name)
            events.append({"kind": "agent_trace", "node": node_name, "payload": payload})

        observation_packet = node_update.get("observation_packet")
        if isinstance(observation_packet, dict):
            events.append(
                {
                    "kind": "agent_trace",
                    "node": node_name,
                    "payload": {
                        "trace_type": "observation_built",
                        "node": node_name,
                        "observation": _json_safe(observation_packet),
                    },
                }
            )

        policy_raw = node_update.get("policy_raw")
        if isinstance(policy_raw, str) and policy_raw.strip():
            summary = policy_raw.strip()
            if len(summary) > 220:
                summary = summary[:220] + f"...[truncated {len(policy_raw.strip()) - 220} chars]"
            events.append(
                {
                    "kind": "agent_trace",
                    "node": node_name,
                    "payload": {
                        "trace_type": "policy_decision",
                        "node": node_name,
                        "content": summary,
                    },
                }
            )

        pending_action = node_update.get("pending_action")
        if isinstance(pending_action, dict):
            events.append(
                {
                    "kind": "agent_trace",
                    "node": node_name,
                    "payload": {
                        "trace_type": "action_selected",
                        "node": node_name,
                        "action": _json_safe(pending_action),
                    },
                }
            )

        runtime_snapshot = node_update.get("runtime_snapshot")
        if isinstance(runtime_snapshot, dict):
            events.append(
                {
                    "kind": "agent_trace",
                    "node": node_name,
                    "payload": {
                        "trace_type": "world_state",
                        "node": node_name,
                        "runtime_snapshot": _json_safe(runtime_snapshot),
                    },
                }
            )

        for change in node_update.get("recent_changes") or []:
            if not isinstance(change, dict):
                continue
            ctype = str(change.get("change_type") or "").strip()
            if ctype not in {"observation_built", "policy_decision", "action_executed", "action_invalid", "world_state_changed"}:
                continue
            events.append(
                {
                    "kind": "agent_trace",
                    "node": node_name,
                    "payload": {
                        "trace_type": ctype,
                        "node": node_name,
                        "change": _json_safe(change),
                    },
                }
            )

        halt_reason = node_update.get("halt_reason")
        if isinstance(halt_reason, str) and halt_reason.strip():
            events.append(
                {
                    "kind": "agent_trace",
                    "node": node_name,
                    "payload": {
                        "trace_type": "halt",
                        "node": node_name,
                        "halt_reason": halt_reason,
                    },
                }
            )


        for ag_event in node_update.get("ag_ui_events") or []:
            if isinstance(ag_event, dict):
                events.append({"kind": "ag_ui", "event": ag_event})

    return events


@dataclass
class StreamTraceReducer:
    def reduce(self, events: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
        return list(events)


def persist_agent_messages(
    *,
    db: Any,
    tenant_id: int,
    user_id: int,
    session_id: int | None,
    result_messages: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    if session_id is None:
        return {"session_id": None, "input_message_id": None, "output_message_id": None}

    visible_messages: list[tuple[str, str]] = []
    for item in result_messages or []:
        role = str(item.get("role") or "").lower().strip()
        if role not in ("user", "assistant"):
            continue
        visible_messages.append((role, str(item.get("content") or "")))

    svc = AgentService(db)
    existing_rows = svc.list_messages(tenant_id=tenant_id, session_id=session_id, limit=5000)
    existing_rows = sorted(existing_rows, key=lambda m: m.id)
    existing_visible: list[tuple[str, str]] = [
        (str(row.role or "").lower().strip(), str(row.content or ""))
        for row in existing_rows
        if str(row.role or "").lower().strip() in ("user", "assistant")
    ]

    append_batch: list[tuple[str, str]] = []
    if not existing_visible:
        append_batch = visible_messages
    elif len(visible_messages) >= len(existing_visible) and visible_messages[: len(existing_visible)] == existing_visible:
        append_batch = visible_messages[len(existing_visible) :]
    elif len(existing_visible) > len(visible_messages) and existing_visible[: len(visible_messages)] == visible_messages:
        append_batch = []
    else:
        # Divergent payload: preserve existing history, append only unseen tail by suffix alignment.
        max_overlap = min(len(existing_visible), len(visible_messages))
        overlap = 0
        for k in range(max_overlap, -1, -1):
            if existing_visible[-k:] == visible_messages[:k]:
                overlap = k
                break
        append_batch = visible_messages[overlap:]

    if append_batch:
        svc.append_messages(
            tenant_id=tenant_id,
            session_id=session_id,
            messages=append_batch,
        )

    rows = svc.list_messages(tenant_id=tenant_id, session_id=session_id, limit=200)
    rows = sorted(rows, key=lambda m: m.id)
    input_message_id = None
    output_message_id = None
    for row in rows:
        if row.role == "user":
            input_message_id = row.id
        if row.role == "assistant":
            output_message_id = row.id

    return {
        "session_id": session_id,
        "input_message_id": input_message_id,
        "output_message_id": output_message_id,
    }


__all__ = [
    "StreamTraceReducer",
    "build_agent_environment_model",
    "build_agent_router_context",
    "build_runtime_snapshot",
    "compact_short_term_messages",
    "evolve_runtime_snapshot",
    "iter_stream_trace_events",
    "normalize_stream_event",
    "persist_agent_messages",
]

