from __future__ import annotations

import atexit
import uuid
from contextlib import ExitStack
from typing import Any

from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.graph import START, StateGraph
from langgraph.types import Command

from ...config import get_settings
from .router_runtime import (
    build_runtime_snapshot as _build_runtime_snapshot,
    evolve_runtime_snapshot as _evolve_runtime_snapshot,
    normalize_stream_event as _normalize_stream_event,
)
from .state import _derive_default_exec_state, _derive_default_task_model
from .world_model import init_world_model as _init_world_model
from .runtime_common import GraphState, INTERRUPT_REASON_CODES, _build_interrupt_payload, _latest_user_query, _normalize_messages
from .runtime_common import _node_memory_sync, _node_prepare
from .runtime_nodes import _node_decide, _node_execute_tools, _node_interrupt_user

def _normalize_checkpoint_conn_string(conn: str) -> str:
    value = str(conn or "").strip()
    if value.startswith("postgresql+psycopg2://"):
        return "postgresql://" + value[len("postgresql+psycopg2://") :]
    if value.startswith("postgresql+psycopg://"):
        return "postgresql://" + value[len("postgresql+psycopg://") :]
    if value.startswith("postgres+psycopg2://"):
        return "postgresql://" + value[len("postgres+psycopg2://") :]
    if value.startswith("postgres+psycopg://"):
        return "postgresql://" + value[len("postgres+psycopg://") :]
    if value.startswith("postgres://"):
        return "postgresql://" + value[len("postgres://") :]
    return value


class _CompiledAgentApp:
    def __init__(self) -> None:
        self._settings = get_settings()
        self._exit_stack = ExitStack()
        self._checkpointer = self._init_checkpointer()
        self._graph = self._build_graph()

    def _init_checkpointer(self):
        conn = _normalize_checkpoint_conn_string(
            getattr(self._settings, "agent_checkpoint_postgres_url", "")
        )
        if not conn.startswith("postgresql://"):
            raise RuntimeError(
                "agent_runtime_error: AGENT_CHECKPOINT_POSTGRES_URL (or DATABASE_URL) must be a PostgreSQL connection string"
            )
        saver = self._exit_stack.enter_context(PostgresSaver.from_conn_string(conn))
        if bool(getattr(self._settings, "agent_checkpoint_setup_on_boot", True)):
            saver.setup()
        return saver

    def _build_graph(self):
        builder = StateGraph(GraphState)
        builder.add_node("prepare", _node_prepare)
        builder.add_node("memory_sync", _node_memory_sync)
        builder.add_node("decide", _node_decide)
        builder.add_node("execute_tools", _node_execute_tools)
        builder.add_node("interrupt_user", _node_interrupt_user)

        builder.add_edge(START, "prepare")
        builder.add_edge("prepare", "memory_sync")
        builder.add_edge("memory_sync", "decide")
        return builder.compile(checkpointer=self._checkpointer)

    @staticmethod
    def _interrupt_to_result(interrupt_chunk: Any, fallback_messages: list[dict[str, Any]]) -> dict[str, Any]:
        messages = list(fallback_messages)
        intr_payload: dict[str, Any] | None = None
        payload_items: list[dict[str, Any]] = []
        if isinstance(interrupt_chunk, (list, tuple)) and interrupt_chunk:
            for idx, item in enumerate(interrupt_chunk):
                value = getattr(item, "value", None)
                if not isinstance(value, dict):
                    continue
                maybe_messages = value.get("messages")
                if idx == 0 and isinstance(maybe_messages, list):
                    messages = _normalize_messages(maybe_messages)
                payload = value.get("interrupt_payload")
                if not isinstance(payload, dict):
                    continue
                interrupt_id = str(getattr(item, "id", None) or payload.get("interrupt_id") or "").strip()
                payload_items.append({"interrupt_id": interrupt_id or f"interrupt-{idx + 1}", "payload": payload})
            if payload_items:
                intr_payload = dict(payload_items[0]["payload"])
                if len(payload_items) > 1:
                    intr_payload["interrupt_mode"] = "multiple"
                    intr_payload["primary_interrupt_id"] = payload_items[0]["interrupt_id"]
                    intr_payload["interrupts"] = payload_items
        if intr_payload is None:
            intr_payload = _build_interrupt_payload("required_missing")

        return {
            "messages": messages,
            "model_messages": messages,
            "tool_results": [],
            "recent_changes": [],
            "task_state": _derive_default_task_model(goal_anchor=_latest_user_query(messages), world_state={}, previous=None),
            "exec_state": _derive_default_exec_state(None),
            "observation_packet": None,
            "world_state": _init_world_model({}),
            "policy_raw": None,
            "action_journal": [],
            "runtime_snapshot": _build_runtime_snapshot({}),
            "task_phase": "awaiting_user",
            "halt_reason": "interrupt",
            "interrupt_payload": intr_payload,
            "ag_ui_events": [
                {
                    "action": "openui.render",
                    "payload": {
                        "response": intr_payload.get("openui_lang") or "",
                        "openui": intr_payload.get("openui") or {},
                        "reason_code": intr_payload.get("reason_code"),
                        "interrupt_id": intr_payload.get("interrupt_id"),
                    },
                }
            ],
        }

    def invoke(self, payload: dict[str, Any], config: dict[str, Any] | None = None) -> dict[str, Any]:
        cfg = dict(config or {})
        configurable = dict(cfg.get("configurable") or {})
        if not str(configurable.get("thread_id") or "").strip():
            configurable["thread_id"] = str(payload.get("thread_id") or f"thread-{uuid.uuid4().hex}")
        cfg["configurable"] = configurable
        context = dict(payload)
        incoming_messages = _normalize_messages(payload.get("messages") or [])
        resume_payload = payload.get("resume_payload")

        if resume_payload is None:
            result = self._graph.invoke({"context": context, "messages": incoming_messages}, config=cfg)
        else:
            result = self._graph.invoke(Command(resume=resume_payload), config=cfg)

        if isinstance(result, dict) and "__interrupt__" in result:
            mapped = self._interrupt_to_result(result.get("__interrupt__"), incoming_messages)
            mapped["runtime_snapshot"] = _evolve_runtime_snapshot(
                previous=mapped.get("runtime_snapshot"),
                context=context,
                task_phase="awaiting_user",
                step_count=int((result or {}).get("step_count") or 0),
            )
            return mapped

        if not isinstance(result, dict):
            raise RuntimeError("agent_runtime_error: invalid graph result")

        return {
            "messages": _normalize_messages(result.get("messages") or incoming_messages),
            "tool_results": list(result.get("tool_results") or []),
            "recent_changes": list(result.get("recent_changes") or []),
            "runtime_snapshot": result.get("runtime_snapshot") or _build_runtime_snapshot(context),
            "task_phase": result.get("task_phase") or "completed",
            "halt_reason": result.get("halt_reason") or ("failed" if result.get("last_error") else "answered"),
            "interrupt_payload": result.get("interrupt_payload"),
            "ag_ui_events": list(result.get("ag_ui_events") or []),
            "last_error": result.get("last_error"),
        }

    def stream(self, payload: dict[str, Any], config: dict[str, Any] | None = None, stream_mode: list[str] | None = None):
        cfg = dict(config or {})
        configurable = dict(cfg.get("configurable") or {})
        if not str(configurable.get("thread_id") or "").strip():
            configurable["thread_id"] = str(payload.get("thread_id") or f"thread-{uuid.uuid4().hex}")
        cfg["configurable"] = configurable
        context = dict(payload)
        incoming_messages = _normalize_messages(payload.get("messages") or [])
        resume_payload = payload.get("resume_payload")
        effective_modes = list(stream_mode or ["updates"])
        if not effective_modes:
            effective_modes = ["updates"]

        if resume_payload is None:
            src = self._graph.stream({"context": context, "messages": incoming_messages}, config=cfg, stream_mode=effective_modes)
        else:
            src = self._graph.stream(Command(resume=resume_payload), config=cfg, stream_mode=effective_modes)

        for raw in src:
            mode, payload_obj = _normalize_stream_event(raw)
            if isinstance(payload_obj, dict) and "__interrupt__" in payload_obj:
                mapped = self._interrupt_to_result(payload_obj.get("__interrupt__"), incoming_messages)
                mapped["runtime_snapshot"] = _evolve_runtime_snapshot(
                    previous=mapped.get("runtime_snapshot"),
                    context=context,
                    task_phase="awaiting_user",
                    step_count=0,
                )
                yield ("updates", {"interrupt_user": mapped})
                return
            yield (mode, payload_obj)

    def close(self) -> None:
        self._exit_stack.close()


_APP: _CompiledAgentApp | None = None


def get_compiled_agent_app() -> _CompiledAgentApp:
    global _APP
    if _APP is None:
        _APP = _CompiledAgentApp()
    return _APP


def _close_compiled_agent_app() -> None:
    global _APP
    if _APP is not None:
        try:
            _APP.close()
        finally:
            _APP = None


atexit.register(_close_compiled_agent_app)


__all__ = ["get_compiled_agent_app", "INTERRUPT_REASON_CODES"]
