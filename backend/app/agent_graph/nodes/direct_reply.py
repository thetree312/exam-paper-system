from __future__ import annotations

from ..helpers import _append_token_usage_event, _latest_user_snapshot_from_state, _trim_text
from ..prompt_slots import _build_slot_prompt
from ..runtime import logger
from ...services.qwen_client import QwenClient
from ..stream_registry import _get_stream_handler
from ..types import AgentState


def direct_reply_node(state: AgentState) -> AgentState:
    if state.get("skip_model"):
        return state

    payload = state.get("supervisor_payload") or {}
    reply = payload.get("direct_reply_message") if isinstance(payload, dict) else None
    if not isinstance(reply, str) or not reply.strip():
        client = QwenClient()
        fast_answer_instruction = (
            "你是 Exam 助手的快速问答分支。当前任务被判定为简单问答或小范围解释，"
            "请直接、简洁地用中文回答学生最近的问题，不要描述内部流程或工具。"
        )
        messages = _build_slot_prompt(
            state=state,
            node_name="direct_reply",
            instruction=fast_answer_instruction,
            slot_payload=None,
            token_limit=2000,
        )
        if not messages:
            messages = [{"role": "system", "content": fast_answer_instruction}]
        logger.info(
            "agent.graph.direct_reply.messages tenant=%s user=%s messages=%s",
            state.get("tenant_id"),
            state.get("user_id"),
            messages,
        )
        usage = None
        try:
            reply, usage = client.chat(messages)
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                "direct_reply_node.failed tenant=%s user=%s",
                state.get("tenant_id"),
                state.get("user_id"),
            )
            reply = f"Agent 内部错误：{exc}"

    reply_text = (reply or "").strip()
    handler = _get_stream_handler(state)
    if handler and reply_text:
        handler({"type": "delta", "role": "assistant", "delta": reply_text})

    new_state = dict(state)
    if reply_text:
        new_state["messages"] = [{"role": "assistant", "content": reply_text}]
        new_state["assistant_reply"] = reply_text
    if isinstance(usage, int):
        new_state = _append_token_usage_event(
            new_state,
            node="direct_reply",
            model=getattr(client, "model", None),
            usage=usage,
            meta=None,
        )
    new_state["pending_tool_calls"] = []

    logger.info(
        "agent.graph.direct_reply.reply_full tenant=%s user=%s reply=%s latest_user=%s",
        state.get("tenant_id"),
        state.get("user_id"),
        reply_text,
        _latest_user_snapshot_from_state(state) or "",
    )
    return new_state


__all__ = ["direct_reply_node"]
