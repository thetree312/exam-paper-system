from __future__ import annotations

import json
import logging
import sqlite3
import time

from .prompt_slots import _latest_user_from_dialogue
from .types import AgentState, _limit_text


logger = logging.getLogger("agent.metrics")

_METRICS_DB_PATH = "agent_metrics.db"
try:
    _metrics_conn = sqlite3.connect(_METRICS_DB_PATH, check_same_thread=False)
    _metrics_conn.execute(
        """
        CREATE TABLE IF NOT EXISTS token_usage_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL,
            tenant_id INTEGER,
            user_id INTEGER,
            session_id INTEGER,
            node TEXT,
            model TEXT,
            total_tokens INTEGER,
            meta_json TEXT
        )
        """
    )
    _metrics_conn.commit()
except Exception:  # noqa: BLE001
    _metrics_conn = None
    logger.exception("agent.metrics.init_failed")


def _trim_text(text: str, limit: int = 300) -> str:
    trimmed = (text or "").strip()
    if len(trimmed) <= limit:
        return trimmed
    return trimmed[:limit].rstrip() + "…"


def _latest_user_snapshot_from_state(state: AgentState) -> str:
    dialogue_window = state.get("dialogue_window") or []
    snapshot = _latest_user_from_dialogue(dialogue_window)
    if snapshot:
        return _limit_text(snapshot, 160)
    history_summary = state.get("history_summary")
    if isinstance(history_summary, str) and history_summary.strip():
        return _limit_text(history_summary.strip(), 160)
    return ""


def _safe_json_loads(raw: str | None) -> dict:
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:  # noqa: BLE001
        return {}


def _append_token_usage_event(
    state: AgentState,
    *,
    node: str,
    model: str | None,
    usage: int | None,
    meta: dict | None = None,
) -> AgentState:
    if not isinstance(usage, int) or usage <= 0:
        return state
    event: dict = {"node": node, "model": model, "total_tokens": usage}
    if isinstance(meta, dict):
        for key, value in meta.items():
            event[key] = value
    existing = state.get("token_usage_events") or []
    if not isinstance(existing, list):
        existing = []
    events = list(existing)
    events.append(event)
    max_events = 200
    if len(events) > max_events:
        events = events[-max_events:]
    # Write detailed metrics to a separate sink so they don't bloat AgentState.
    try:
        _write_token_usage_metric(state, event)
    except Exception:  # noqa: BLE001
        logger.exception("agent.metrics.write_failed")
    new_state: AgentState = dict(state)
    new_state["token_usage_events"] = events
    prev_total = new_state.get("request_total_tokens")
    try:
        base_total = int(prev_total) if prev_total is not None else 0
    except Exception:  # noqa: BLE001
        base_total = 0
    new_state["request_total_tokens"] = base_total + usage
    return new_state


def _write_token_usage_metric(state: AgentState, event: dict) -> None:
    if _metrics_conn is None:
        return
    try:
        tenant_id = state.get("tenant_id")
        user_id = state.get("user_id")
        session_id = state.get("session_id")
    except Exception:  # noqa: BLE001
        tenant_id = None
        user_id = None
        session_id = None

    try:
        cur = _metrics_conn.cursor()
        cur.execute(
            "INSERT INTO token_usage_events (ts, tenant_id, user_id, session_id, node, model, total_tokens, meta_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                time.time(),
                tenant_id,
                user_id,
                session_id,
                event.get("node"),
                event.get("model"),
                event.get("total_tokens"),
                json.dumps({k: v for k, v in event.items() if k not in {"node", "model", "total_tokens"}}, ensure_ascii=False),
            ),
        )
        _metrics_conn.commit()
    except Exception:  # noqa: BLE001
        logger.exception("agent.metrics.insert_failed")


__all__ = [
    "_trim_text",
    "_latest_user_snapshot_from_state",
    "_safe_json_loads",
    "_append_token_usage_event",
]
