from __future__ import annotations

from langgraph.graph import END, StateGraph

from ..state import AgentState
from .exercise_agent import exercise_agent_node
from .tool_node import tool_node
from ..runtime import logger


def _route_after_exercise_agent(state: AgentState) -> str:
    logger.info("assistant.exercise_flow.route decision=tool_node")
    return "tool_node"


def build_exercise_flow_subgraph() -> StateGraph:
    graph = StateGraph(AgentState)

    graph.add_node("exercise_agent", exercise_agent_node)
    graph.add_node("tool_node", tool_node)

    graph.set_entry_point("exercise_agent")

    graph.add_conditional_edges(
        "exercise_agent",
        _route_after_exercise_agent,
        {
            "tool_node": "tool_node",
        },
    )
    graph.add_edge("tool_node", END)

    return graph


__all__ = ["build_exercise_flow_subgraph"]
