from __future__ import annotations

from ..runtime import logger
from ..state import AgentState


def route_next_agent(state: AgentState) -> str:
    """根据 orchestrator 写入的 next_agent 决定下一个节点。

    返回值对应于图中的节点名称。
    """

    target = (state.get("next_agent") or "tutor").strip()

    if target not in {"tutor", "exercise", "search", "none"}:
        logger.warning("assistant.router.unknown_next_agent target=%s", target)
        target = "tutor"

    if target == "none":
        logger.info("assistant.router.next_agent=none -> reply")
        return "reply"

    logger.info("assistant.router.next_agent=%s", target)
    return f"agent_{target}"


__all__ = ["route_next_agent"]
