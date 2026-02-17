from __future__ import annotations

from ..runtime import logger
from ..state import AgentState


def question_focus_node(state: AgentState) -> AgentState:
    """当前版本不再在图层级做题目 focus 决策，直接透传状态。

    focus 能力（自然语言→题目工作集的决策）将由各子 Agent 内部共享实现，
    这里仅保留占位以兼容可能存在的引用，不做任何规则映射或状态修改。
    """

    logger.info(
        "assistant.question_focus.noop tenant=%s user=%s",
        state.get("tenant_id"),
        state.get("user_id"),
    )
    return state


__all__ = ["question_focus_node"]
