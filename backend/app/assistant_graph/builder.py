from __future__ import annotations

from langgraph.graph import END, StateGraph

from .nodes.retrieve_context import retrieve_context_node
from .nodes.summarizer import summarizer_node
from .nodes.context_init import context_init_node
from .nodes.orchestrator import orchestrator_node
from .nodes.reply import reply_node
from .nodes.router import route_next_agent
from .nodes.tutor_agent import tutor_agent_node
from .nodes.search_agent import search_agent_node
from .nodes.exercise_flow import build_exercise_flow_subgraph
from .nodes.persist import persist_node
from .state import AgentState


def build_graph() -> StateGraph:
    graph = StateGraph(AgentState)

    graph.add_node("retrieve_context", retrieve_context_node)
    graph.add_node("summarizer", summarizer_node)
    graph.add_node("context_init", context_init_node)
    graph.add_node("orchestrator", orchestrator_node)
    graph.add_node("agent_tutor", tutor_agent_node)

    exercise_flow = build_exercise_flow_subgraph().compile()
    graph.add_node("agent_exercise", exercise_flow)
    graph.add_node("agent_search", search_agent_node)
    graph.add_node("reply", reply_node)
    graph.add_node("persist", persist_node)

    graph.set_entry_point("retrieve_context")

    graph.add_edge("retrieve_context", "summarizer")
    graph.add_edge("summarizer", "context_init")
    graph.add_edge("context_init", "orchestrator")
    graph.add_conditional_edges(
        "orchestrator",
        route_next_agent,
        {
            "agent_tutor": "agent_tutor",
            "agent_exercise": "agent_exercise",
            "agent_search": "agent_search",
            "reply": "reply",
        },
    )

    # 子 Agent 默认在本轮结束后直接进入统一回复节点
    graph.add_edge("agent_tutor", "reply")
    graph.add_edge("agent_exercise", "reply")
    graph.add_edge("agent_search", "reply")

    graph.add_edge("reply", "persist")
    graph.add_edge("persist", END)

    return graph


__all__ = ["build_graph"]
