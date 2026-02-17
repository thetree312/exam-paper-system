from __future__ import annotations

from typing import List, Tuple

from ...db import SessionLocal
from ...services.agent_service import AgentService
from ..runtime import logger
from ..state import AgentMessageEntry, AgentState
from ..stream_registry import _get_base_messages


def _normalize_role(raw_role: str | None) -> str | None:
    if not raw_role:
        return None
    role = raw_role.lower()
    if role == "human":
        return "user"
    if role in ("ai", "assistant"):
        return "assistant"
    return role


def _extract_role_content(msg: AgentMessageEntry | object) -> Tuple[str | None, str]:
    if isinstance(msg, dict):
        role = _normalize_role(msg.get("role"))
        content = msg.get("content") or ""
        return role, str(content)
    role_attr = getattr(msg, "type", None) or getattr(msg, "role", None)
    role = _normalize_role(role_attr) if isinstance(role_attr, str) else None
    content = getattr(msg, "content", "") or ""
    return role, str(content)


def persist_node(state: AgentState) -> AgentState:
    """将本轮对话完整写回数据库，并同步会话画像/摘要。

    - 使用 register_base_messages 绑定的 base_messages 作为持久化来源；
    - 路由层负责构造当前轮 assistant 占位，persist 仅做确定性“末尾 assistant 替换”；
      若输入末尾不是 assistant，则追加 assistant_reply；
    - 仅保留 user/assistant 文本对作为 agent_messages；
    - 使用 user_profile / history_summary 更新 AgentSession.profile_json。
    """

    tenant_id = state.get("tenant_id")
    session_id = state.get("session_id")
    if not tenant_id or not session_id:
        return state

    base_messages = _get_base_messages(state) or state.get("base_messages") or state.get("messages") or []
    if not base_messages:
        return state

    patched: List[AgentMessageEntry] = []
    for msg in base_messages:
        if isinstance(msg, dict):
            patched.append({"role": msg.get("role"), "content": msg.get("content")})

    reply = state.get("assistant_reply") or ""
    reply_text = reply.strip()
    if reply_text:
        replaced = False
        if patched:
            last = patched[-1]
            role_raw = last.get("role") if isinstance(last, dict) else None
            role_norm = _normalize_role(role_raw) or role_raw
            # 持久化协议：路由保证末尾 assistant 为当前轮占位，persist 只做确定性替换。
            if role_norm == "assistant":
                last["role"] = "assistant"
                last["content"] = reply_text
                replaced = True
        if not replaced:
            patched.append({"role": "assistant", "content": reply_text})

    message_pairs: List[Tuple[str, str]] = []
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
        svc.replace_messages(
            tenant_id=tenant_id,
            session_id=session_id,
            messages=message_pairs,
        )

        # 画像 / 会话摘要：优先从 user_profile 读取，兼容旧 session_profile 字段。
        raw_profile = state.get("user_profile") or state.get("session_profile") or {}
        if not isinstance(raw_profile, dict):
            raw_profile = {}

        # 在画像中同步写入题目工作集信息，便于跨轮恢复。
        profile = dict(raw_profile)
        active_ids = state.get("active_question_ids") or []
        recent_ids = state.get("recent_question_ids") or []
        if isinstance(active_ids, list):
            profile["active_question_ids"] = active_ids
        if isinstance(recent_ids, list):
            profile["recent_question_ids"] = recent_ids
        vision_observations = state.get("vision_observations")
        if isinstance(vision_observations, list):
            profile["vision_observations"] = vision_observations[-8:]
        vision_evidence = state.get("vision_evidence")
        if isinstance(vision_evidence, list):
            profile["vision_evidence"] = vision_evidence[-12:]

        history_summary = state.get("history_summary")
        svc.update_session_profile(
            tenant_id=tenant_id,
            session_id=session_id,
            profile=profile,
            history_summary=history_summary if isinstance(history_summary, str) else None,
        )

        logger.info(
            "assistant.persist.ok tenant=%s session=%s message_pairs=%s profile_keys=%s summary_len=%s",
            tenant_id,
            session_id,
            len(message_pairs),
            list(raw_profile.keys()),
            len(history_summary) if isinstance(history_summary, str) else 0,
        )

    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "assistant.persist.failed tenant=%s session=%s error=%s",
            tenant_id,
            session_id,
            exc,
        )
    finally:
        db.close()

    # 返回精简后的状态，避免在 checkpoint 中长期持有大对话历史
    slim_state: AgentState = {
        "tenant_id": state.get("tenant_id"),
        "user_id": state.get("user_id"),
        "ui_context": state.get("ui_context"),
        "session_id": state.get("session_id"),
        "document_id": state.get("document_id"),
        "document_title": state.get("document_title"),
        "thread_id": state.get("thread_id"),
        "history_summary": state.get("history_summary"),
        "user_profile": profile,
    }
    return slim_state


__all__ = ["persist_node"]
