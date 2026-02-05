from __future__ import annotations

from langgraph.graph import END, StateGraph

from ..nodes import solver_context_node, solver_node, solver_reply_node, tool_exec_node
from ..router import route_after_tool_exec
from ..types import AgentState


def build_solver_flow_subgraph() -> StateGraph:
    graph = StateGraph(AgentState)
    graph.add_node("solver_context", solver_context_node)
    graph.add_node("solver", solver_node)
    graph.add_node("tool_exec", tool_exec_node)
    graph.add_node("solver_reply", solver_reply_node)
    graph.set_entry_point("solver_context")

    graph.add_edge("solver_context", "solver")
    graph.add_edge("solver", "tool_exec")
    graph.add_conditional_edges(
        "tool_exec",
        route_after_tool_exec,
        {
            "solver": "solver_context",
            "solver_reply": "solver_reply",
        },
    )
    graph.add_edge("solver_reply", END)
    return graph


__all__ = ["build_solver_flow_subgraph"]
