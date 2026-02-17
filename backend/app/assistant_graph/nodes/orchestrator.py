from __future__ import annotations

import json
from typing import Any

from ..runtime import logger
from ..state import AgentState
from ...config import get_settings
from ...services.qwen_client import QwenClient


SYSTEM_PROMPT = """你是一个多 Agent 学习助手系统的总控 Orchestrator。

- 根据最近对话、文档上下文和用户画像，判断接下来应该由哪个子代理处理：
  - tutor: 讲解/解题/学习辅导
  - exercise: 出题/生成练习
  - search: 知识检索/资料查询
- 当用户只是闲聊或问题很简单时，可以直接返回回复，不必交给子代理。

【输出要求】
- 严格输出一个 JSON 对象，字段：
  - next_agent: "tutor" | "exercise" | "search" | "none"
  - direct_reply: bool
  - reply: string | null  （当 direct_reply=true 时必须给出）
  - reason: string  （简要说明路由原因）
"""


def orchestrator_node(state: AgentState) -> AgentState:
    if state.get("skip_model"):
        return state

    settings = get_settings()
    client = QwenClient(model=settings.alibaba_model_qwen_turbo)

    dialogue_window = state.get("dialogue_window") or []
    doc_context = state.get("doc_context") or ""
    history_summary = state.get("history_summary") or ""

    latest_user: str = ""
    for msg in reversed(dialogue_window):
        if msg.get("role") == "user":
            latest_user = str(msg.get("content") or "")
            break

    context_obj: dict[str, Any] = {
        "latest_user": latest_user,
        "ui_context": state.get("ui_context") or "blank",
        "doc_context_preview": (doc_context or "")[:200],
        "history_summary": history_summary,
    }

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": "下面是当前对话和上下文，请根据说明给出路由 JSON：\n" + json.dumps(context_obj, ensure_ascii=False),
        },
    ]

    reply, usage = client.chat(messages)

    try:
        plan = json.loads(reply)
    except Exception:  # noqa: BLE001
        logger.warning(
            "assistant.orchestrator.invalid_json tenant=%s user=%s reply_preview=%s",
            state.get("tenant_id"),
            state.get("user_id"),
            reply[:200],
        )
        plan = {"next_agent": "tutor", "direct_reply": False, "reply": None, "reason": "fallback:tutor"}

    logger.info(
        "assistant.orchestrator.plan tenant=%s user=%s plan=%s usage=%s",
        state.get("tenant_id"),
        state.get("user_id"),
        plan,
        usage,
    )

    next_agent = plan.get("next_agent") or "tutor"
    direct_reply = bool(plan.get("direct_reply"))
    direct_text = plan.get("reply") if isinstance(plan.get("reply"), str) else None

    new_state = dict(state)
    new_state["next_agent"] = next_agent

    if direct_reply and direct_text:
        new_state["assistant_reply"] = direct_text
    else:
        new_state["assistant_reply"] = None

    return new_state


__all__ = ["orchestrator_node"]
