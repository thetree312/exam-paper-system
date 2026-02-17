from __future__ import annotations

from typing import Any, List

from ..runtime import logger
from ..state import AgentMessageEntry, AgentState
from ...services.conversation_memory_service import ConversationMemoryService


def _latest_user_text(messages: List[AgentMessageEntry]) -> str:
    if not messages:
        return ""
    for msg in reversed(messages):
        if not isinstance(msg, dict):
            continue
        if msg.get("role") != "user":
            continue
        content = msg.get("content") or ""
        if content:
            return str(content)
    return ""


def _should_hydrate(state: AgentState, messages: List[AgentMessageEntry]) -> bool:
    """Decide whether long-term semantic hydration is needed for this turn.

    原则：短会话优先依赖当前对话与工具检索，不强制每轮都走 embedding 检索。
    """

    history_summary = state.get("history_summary")
    if isinstance(history_summary, str) and history_summary.strip():
        return True

    summary_upto = state.get("summary_upto")
    try:
        if summary_upto is not None and int(summary_upto) > 0:
            return True
    except (TypeError, ValueError):
        pass

    # 没有长期记忆沉淀时，只有当本轮输入历史足够长再启用语义回填。
    return len(messages or []) >= 6


def retrieve_context_node(state: AgentState) -> AgentState:
    if state.get("skip_model"):
        return state

    tenant_id = state.get("tenant_id")
    user_id = state.get("user_id")
    session_id = state.get("session_id")
    if not tenant_id or not user_id:
        return state

    dialogue_window = state.get("dialogue_window") or []
    messages = state.get("messages") or []

    if not _should_hydrate(state, messages):
        logger.info(
            "assistant.retrieve_context.skip tenant=%s user=%s reason=short_session_no_summary msg_count=%s",
            tenant_id,
            user_id,
            len(messages),
        )
        return state

    # 入口节点应优先使用“本次请求携带的 messages”作为检索查询，
    # 避免 checkpoint 中上轮 dialogue_window 覆盖本轮最新用户意图。
    query_text = _latest_user_text(messages) or _latest_user_text(dialogue_window)
    if not query_text:
        return state

    svc = ConversationMemoryService()
    try:
        snapshots = svc.search_similar_snapshots(
            tenant_id=int(tenant_id),
            user_id=int(user_id),
            session_id=int(session_id) if session_id is not None else None,
            query_text=query_text,
            limit=5,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "assistant.retrieve_context.search_failed tenant=%s user=%s error=%s",
            tenant_id,
            user_id,
            exc,
        )
        return state

    if not snapshots:
        return state

    summaries: List[str] = []
    facts_acc: List[str] = []
    for item in snapshots:
        s = item.get("summary")
        if isinstance(s, str) and s.strip():
            summaries.append(s.strip())
        facts_val = item.get("facts")
        if isinstance(facts_val, list):
            for f in facts_val:
                if isinstance(f, str):
                    t = f.strip()
                    if t and t not in facts_acc:
                        facts_acc.append(t)

    if not summaries and not facts_acc:
        return state

    hydrated_summary = "\n".join(summaries) if summaries else None

    # 这里刻意不再把 hydrated_summary 合并进 history_summary，
    # 避免每一轮都重复 prepend 相同的摘要，导致长期摘要指数级膨胀。
    # hydrated_summary 只作为本轮的“语义回填视图”供下游节点参考。
    new_state: AgentState = dict(state)
    if hydrated_summary:
        new_state["hydrated_summary"] = hydrated_summary
    if facts_acc:
        new_state["hydrated_facts"] = facts_acc

    logger.info(
        "assistant.retrieve_context.done tenant=%s user=%s snapshots=%s facts=%s",
        tenant_id,
        user_id,
        len(snapshots),
        len(facts_acc),
    )

    return new_state


__all__ = ["retrieve_context_node"]
