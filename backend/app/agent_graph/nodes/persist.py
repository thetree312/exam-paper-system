from __future__ import annotations

import time

from ...db import SessionLocal
from ..runtime import logger
from ...services.agent_service import AgentService
from ..stream_registry import _get_base_messages
from ..types import AgentMessageEntry, AgentState, _extract_role_content, _normalize_role


def persist_node(state: AgentState) -> AgentState:
    tenant_id = state.get("tenant_id")
    session_id = state.get("session_id")
    if not tenant_id or not session_id:
        return state

    base_messages = _get_base_messages(state) or state.get("messages") or []
    if not base_messages:
        return state

    patched: list[AgentMessageEntry] = []
    for msg in base_messages:
        if isinstance(msg, dict):
            patched.append({"role": msg.get("role"), "content": msg.get("content")})

    reply = state.get("assistant_reply") or ""
    reply_text = reply.strip()
    if reply_text:
        for idx in range(len(patched) - 1, -1, -1):
            role_raw = patched[idx].get("role")
            role_norm = _normalize_role(role_raw) or role_raw
            if role_norm == "assistant":
                patched[idx]["role"] = "assistant"
                patched[idx]["content"] = reply_text
                break

    message_pairs: list[tuple[str, str]] = []
    for msg in patched:
        role, content = _extract_role_content(msg)
        if role not in ("user", "assistant"):
            continue
        text = (content or "").strip()
        if not text:
            continue
        message_pairs.append((role, text))

    if not message_pairs:
        return state

    db = SessionLocal()
    try:
        svc = AgentService(db)
        replace_start = time.time()
        svc.replace_messages(
            tenant_id=tenant_id,
            session_id=session_id,
            messages=message_pairs,
        )
        replace_duration = (time.time() - replace_start) * 1000
        logger.info(
            "persist_node.messages_replace_ok tenant=%s session=%s message_pairs=%s reply_len=%s duration_ms=%.2f",
            tenant_id,
            session_id,
            len(message_pairs),
            len(reply_text),
            replace_duration,
        )

        current_profile = state.get("session_profile") or {}
        if not isinstance(current_profile, dict):
            current_profile = {}

        runtime_state = state.get("session_state")
        if isinstance(runtime_state, dict):
            merged_profile = dict(current_profile)
            merged_profile.update(runtime_state)
        else:
            merged_profile = dict(current_profile)

        anchors_db = current_profile.get("session_anchors") if isinstance(current_profile, dict) else None
        if not isinstance(anchors_db, list):
            anchors_db = []
        anchors_runtime = None
        if isinstance(runtime_state, dict):
            anchors_runtime = runtime_state.get("session_anchors")
        if not isinstance(anchors_runtime, list):
            anchors_runtime = None

        if anchors_runtime is not None:
            merged_anchors: list[dict] = []
            seen_ids: set[str] = set()
            for item in anchors_db:
                if not isinstance(item, dict):
                    continue
                anchor_id = item.get("id")
                if isinstance(anchor_id, str):
                    seen_ids.add(anchor_id)
                merged_anchors.append(item)
            for item in anchors_runtime:
                if not isinstance(item, dict):
                    continue
                anchor_id = item.get("id")
                if isinstance(anchor_id, str) and anchor_id in seen_ids:
                    merged_anchors = [
                        (item if (isinstance(x, dict) and x.get("id") == anchor_id) else x)
                        for x in merged_anchors
                    ]
                else:
                    if isinstance(anchor_id, str):
                        seen_ids.add(anchor_id)
                    merged_anchors.append(item)
            merged_profile["session_anchors"] = merged_anchors
        else:
            if anchors_db:
                merged_profile["session_anchors"] = anchors_db

        anchors_final = merged_profile.get("session_anchors") if isinstance(merged_profile, dict) else None
        logger.info(
            "persist_node.session_state_debug tenant=%s session=%s state_keys=%s anchor_count=%s anchor_ids=%s",
            tenant_id,
            session_id,
            list(merged_profile.keys()) if isinstance(merged_profile, dict) else [],
            len(anchors_final) if isinstance(anchors_final, list) else 0,
            [a.get("id") for a in anchors_final[:5]] if isinstance(anchors_final, list) else [],
        )

        history_summary = state.get("history_summary")
        try:
            profile_start = time.time()
            svc.update_session_profile(
                tenant_id=tenant_id,
                session_id=session_id,
                profile=merged_profile if isinstance(merged_profile, dict) else {},
                history_summary=history_summary if isinstance(history_summary, str) else None,
            )
            if isinstance(merged_profile, dict):
                state["session_profile"] = merged_profile
            profile_duration = (time.time() - profile_start) * 1000
            logger.info(
                "persist_node.profile_ok tenant=%s session=%s state_keys=%s summary_len=%s duration_ms=%.2f",
                tenant_id,
                session_id,
                list(merged_profile.keys()) if isinstance(merged_profile, dict) else [],
                len(history_summary) if isinstance(history_summary, str) else 0,
                profile_duration,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                "persist_node.profile_failed tenant=%s session=%s error=%s",
                tenant_id,
                session_id,
                exc,
            )
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "persist_node.failed tenant=%s session=%s error=%s",
            tenant_id,
            session_id,
            exc,
        )
    finally:
        db.close()

    slim_state: AgentState = {
        "tenant_id": state.get("tenant_id"),
        "user_id": state.get("user_id"),
        "ui_context": state.get("ui_context"),
        "session_id": state.get("session_id"),
        "document_id": state.get("document_id"),
        "document_title": state.get("document_title"),
        "thread_id": state.get("thread_id"),
        "session_profile": state.get("session_profile"),
        "history_summary": state.get("history_summary"),
    }
    return slim_state


__all__ = ["persist_node"]
