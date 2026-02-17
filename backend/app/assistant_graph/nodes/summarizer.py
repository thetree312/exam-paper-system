from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from ..runtime import logger
from ..state import AgentMessageEntry, AgentState
from ...config import get_settings
from ...services.qwen_client import QwenClient
from ...services.conversation_memory_service import ConversationMemoryService


def _build_segment_lines(messages: List[AgentMessageEntry]) -> List[str]:
    lines: List[str] = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        if role not in ("user", "assistant"):
            continue
        content = (msg.get("content") or "").strip()
        if not content:
            continue
        prefix = "学生" if role == "user" else "助手"
        lines.append(f"{prefix}：{content}")
    return lines


def summarizer_node(state: AgentState) -> AgentState:
    if state.get("skip_model"):
        return state

    messages = state.get("messages") or []
    if not messages:
        return state

    limit_rounds = 12
    max_msgs = limit_rounds * 2
    total = len(messages)
    cutoff = max(0, total - max_msgs)
    if cutoff <= 0:
        return state

    prev_upto_raw = state.get("summary_upto")
    try:
        prev_upto = int(prev_upto_raw) if prev_upto_raw is not None else 0
    except Exception:
        prev_upto = 0
    if prev_upto < 0:
        prev_upto = 0
    if prev_upto > cutoff:
        prev_upto = cutoff

    if cutoff <= prev_upto:
        return state

    # 为避免首次触发时一次性总结过多轮对话，这里限制每次仅处理固定数量的消息，
    # 让摘要在多轮请求中逐步收敛，而不是一口气塞给模型几十万 token。
    max_segment_msgs = 20
    segment_end = min(cutoff, prev_upto + max_segment_msgs)
    if segment_end <= prev_upto:
        return state

    segment = messages[prev_upto:segment_end]
    lines = _build_segment_lines(segment)
    if not lines:
        return state

    prev_summary = state.get("history_summary") or ""
    # 防止历史摘要过长导致本轮摘要 prompt 过大，这里做一次长度截断（保留末尾部分）。
    if prev_summary and len(prev_summary) > 2000:
        prev_summary = prev_summary[-2000:]
    entities: Dict[str, Any] = state.get("entities") or {}
    if not isinstance(entities, dict):
        entities = {}
    existing_facts = entities.get("facts")
    if not isinstance(existing_facts, list):
        existing_facts = []

    settings = get_settings()
    client = QwenClient(model=settings.alibaba_model_qwen_turbo)

    segment_text = "\n".join(lines)
    user_parts: List[str] = []
    if prev_summary:
        user_parts.append("这是之前的对话摘要：")
        user_parts.append(prev_summary)
        user_parts.append("")
    user_parts.append("下面是新增的一段对话记录：")
    user_parts.append(segment_text)
    user_parts.append("")
    user_parts.append("请基于之前的摘要和这段新增对话，输出一个 JSON 对象，格式严格为：")
    user_parts.append('{"summary": "...", "facts": ["...", "..."]}')
    user_parts.append("summary 用 3~6 句中文高度概括到目前为止整段对话的要点；facts 是若干条原子事实或长期有用的信息。只返回 JSON，不要多余文字。")
    user_content = "\n".join(user_parts)

    messages_payload = [
        {
            "role": "system",
            "content": "你是对话摘要与事实提取助手。你只能输出 JSON，不要任何解释。",
        },
        {
            "role": "user",
            "content": user_content,
        },
    ]

    try:
        resp_text, _ = client.chat(messages_payload)
        text_out = (resp_text or "").strip()
        new_summary: Optional[str] = None
        new_facts: List[str] = []
        if text_out:
            try:
                data = json.loads(text_out)
                if isinstance(data, dict):
                    s = data.get("summary")
                    if isinstance(s, str):
                        new_summary = s.strip()
                    facts_val = data.get("facts")
                    if isinstance(facts_val, list):
                        for item in facts_val:
                            if isinstance(item, str):
                                t = item.strip()
                                if t:
                                    new_facts.append(t)
            except Exception:
                new_summary = text_out

        if not new_summary:
            return state

        merged_facts: List[str] = list(existing_facts)
        for f in new_facts:
            if f not in merged_facts:
                merged_facts.append(f)

        new_entities = dict(entities)
        new_entities["facts"] = merged_facts

        tenant_id = state.get("tenant_id")
        user_id = state.get("user_id")
        session_id = state.get("session_id")
        if tenant_id and user_id and session_id:
            svc = ConversationMemoryService()
            thread_id = state.get("thread_id")
            svc.add_snapshot(
                tenant_id=int(tenant_id),
                user_id=int(user_id),
                session_id=int(session_id),
                thread_id=thread_id,
                turn_index=segment_end,
                summary=new_summary,
                facts=new_facts or None,
            )

        new_state: AgentState = dict(state)
        new_state["history_summary"] = new_summary
        new_state["summary_upto"] = segment_end
        new_state["entities"] = new_entities

        logger.info(
            "assistant.summarizer.done tenant=%s session=%s prev_upto=%s new_upto=%s segment=%s summary_len=%s facts_count=%s",
            state.get("tenant_id"),
            state.get("session_id"),
            prev_upto,
            segment_end,
            len(segment),
            len(new_summary),
            len(new_facts),
        )
        return new_state
    except Exception as exc:
        logger.warning(
            "assistant.summarizer.failed tenant=%s session=%s error=%s",
            state.get("tenant_id"),
            state.get("session_id"),
            exc,
        )
        return state


__all__ = ["summarizer_node"]
