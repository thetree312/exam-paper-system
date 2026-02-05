from __future__ import annotations

from langgraph.graph import StateGraph

from .builder import build_graph
from .runtime import SKILL_MANAGER, logger
from .stream_registry import (
    register_base_messages,
    register_stream_handler,
    unregister_base_messages,
    unregister_stream_handler,
)
from .types import AgentMessageEntry, AgentState


def build_agent_app() -> StateGraph:
    """Construct the StateGraph for Exam agent."""
    return build_graph()


__all__ = [
    "AgentMessageEntry",
    "AgentState",
    "build_agent_app",
    "register_stream_handler",
    "unregister_stream_handler",
    "register_base_messages",
    "unregister_base_messages",
    "logger",
    "SKILL_MANAGER",
]
