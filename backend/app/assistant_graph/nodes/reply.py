from __future__ import annotations

from ..runtime import logger
from ..state import AgentState
from ..stream_registry import _get_stream_handler


def reply_node(state: AgentState) -> AgentState:
    """统一输出节点：确保 assistant_reply 写入 messages，并向前端推送最终回复。

    - 将 assistant_reply 追加到 messages 队列；
    - 若存在流式 handler，则发送一条 "delta" 事件，格式与旧 direct_reply 节点保持一致。
    """

    reply = state.get("assistant_reply") or ""
    reply_text = reply.strip()

    messages = state.get("messages") or []
    if reply_text:
        messages = list(messages) + [{"role": "assistant", "content": reply_text}]

    new_state = dict(state)
    new_state["messages"] = messages

    handler = _get_stream_handler(state)
    if handler and reply_text:
        handler({"type": "delta", "role": "assistant", "delta": reply_text})

    logger.info(
        "assistant.reply.done tenant=%s user=%s reply_len=%s",
        state.get("tenant_id"),
        state.get("user_id"),
        len(reply_text),
    )
    return new_state


__all__ = ["reply_node"]
