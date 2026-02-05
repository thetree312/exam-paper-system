from __future__ import annotations

from .runtime import logger
from .types import AgentState


def route_after_supervisor(state: AgentState) -> str:
    payload = state.get("supervisor_payload") or {}
    if payload.get("direct_reply"):
        logger.info(
            "agent.graph.router.after_supervisor decision=direct_reply reason=payload_direct flag_direct=%s",
            payload.get("direct_reply"),
        )
        return "direct_reply"

    expected = state.get("supervisor_expected_new_questions")
    batch_required = bool(state.get("batch_config_required"))
    batch_ready = bool(state.get("batch_config"))
    if batch_required and not batch_ready:
        missing = state.get("batch_config_missing_fields")
        logger.info(
            "agent.graph.router.after_supervisor decision=batch_config expected=%s missing=%s",
            expected,
            missing,
        )
        return "batch_config"

    require_vision = bool(payload.get("require_vision", False))
    if require_vision:
        logger.info("agent.graph.router.after_supervisor decision=vision reason=payload_require_vision")
        return "vision"
    logger.info(
        "agent.graph.router.after_supervisor decision=solver_flow batch_required=%s batch_ready=%s expected=%s",
        batch_required,
        batch_ready,
        expected,
    )
    return "solver_flow"


def route_after_tool_exec(state: AgentState) -> str:
    error = state.get("tool_error")
    retries = state.get("tool_retry_count") or 0
    if error and retries < 2:
        logger.info(
            "agent.graph.router.after_tool_exec decision=solver reason=retry error=%s retries=%s",
            error,
            retries,
        )
        return "solver"
    logger.info(
        "agent.graph.router.after_tool_exec decision=solver_reply error=%s retries=%s",
        error,
        retries,
    )
    return "solver_reply"


def route_after_batch_config(state: AgentState) -> str:
    payload = state.get("supervisor_payload") or {}
    require_vision = bool(payload.get("require_vision", False))
    if require_vision:
        logger.info("agent.graph.router.after_batch_config decision=vision reason=payload_require_vision")
        return "vision"
    logger.info("agent.graph.router.after_batch_config decision=solver_flow")
    return "solver_flow"


__all__ = ["route_after_supervisor", "route_after_tool_exec", "route_after_batch_config"]
