from __future__ import annotations

from langgraph.graph import END, StateGraph

from .memory_bus import memory_bus_node
from .nodes import (
    batch_config_node,
    direct_reply_node,
    persist_node,
    supervisor_node,
    vision_node,
)
from .router import (
    route_after_batch_config,
    route_after_supervisor,
)
from .subgraphs import build_solver_flow_subgraph
from .types import AgentState


def build_graph() -> StateGraph:
    graph = StateGraph(AgentState)
    graph.add_node("memory_bus", memory_bus_node)
    graph.add_node("supervisor", supervisor_node)
    graph.add_node("batch_config", batch_config_node)
    graph.add_node("vision", vision_node)
    solver_flow = build_solver_flow_subgraph().compile()
    graph.add_node("solver_flow", solver_flow)
    graph.add_node("persist", persist_node)
    graph.add_node("direct_reply", direct_reply_node)
    graph.set_entry_point("memory_bus")

    graph.add_edge("memory_bus", "supervisor")
    graph.add_conditional_edges(
        "supervisor",
        route_after_supervisor,
        {
            "batch_config": "batch_config",
            "vision": "vision",
            "solver_flow": "solver_flow",
            "direct_reply": "direct_reply",
        },
    )

    graph.add_conditional_edges(
        "batch_config",
        route_after_batch_config,
        {
            "vision": "vision",
            "solver_flow": "solver_flow",
        },
    )

    graph.add_edge("vision", "solver_flow")
    graph.add_edge("direct_reply", "persist")
    graph.add_edge("solver_flow", "persist")
    graph.add_edge("persist", END)
    return graph


__all__ = ["build_graph"]
