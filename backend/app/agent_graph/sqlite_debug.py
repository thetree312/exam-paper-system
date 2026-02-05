from __future__ import annotations

import json
import logging
import sqlite3
from typing import Any, Dict

from langgraph.checkpoint.sqlite import SqliteSaver

logger = logging.getLogger("agent.checkpoint")


def _approx_len(value: Any) -> int:
    """Best-effort length of a JSON-serializable value; -1 if unsupported."""

    if value is None:
        return 0
    try:
        return len(json.dumps(value, ensure_ascii=False))
    except Exception:  # noqa: BLE001
        return -1


class DebugSqliteSaver(SqliteSaver):
    """SqliteSaver wrapper that logs state sizes before persisting checkpoints."""

    def put(
        self,
        config: Dict[str, Any],
        checkpoint: Dict[str, Any],
        metadata: Dict[str, Any],
        new_versions: Any,
    ) -> Dict[str, Any]:
        state = checkpoint.get("state")
        if not isinstance(state, dict):
            state = {}

        configurable = {}
        try:
            configurable = config.get("configurable") or {}
        except Exception:  # noqa: BLE001
            configurable = {}
        thread_id = configurable.get("thread_id")

        channel_values = checkpoint.get("channel_values")
        channel_lengths: Dict[str, int] | None = None
        if isinstance(channel_values, dict):
            # Drop extremely large, non-essential channels from checkpoint to
            # avoid oversized SQLite blobs. token_usage_events is moved to
            # logging/metrics instead of being persisted as part of state.
            token_events = channel_values.pop("token_usage_events", None)
            dropped_events_count = -1
            if isinstance(token_events, (list, tuple)):
                dropped_events_count = len(token_events)
            if token_events is not None:
                logger.info(
                    "checkpoint.debug.token_usage_events_dropped thread=%s count=%s",
                    thread_id,
                    dropped_events_count,
                )
            solver_bundle = channel_values.pop("solver_context_bundle", None)
            solver_sections = channel_values.pop("solver_context_sections", None)
            if solver_bundle is not None or solver_sections is not None:
                bundle_len = _approx_len(solver_bundle)
                sections_len = _approx_len(solver_sections)
                logger.info(
                    "checkpoint.debug.solver_context_dropped thread=%s bundle_len=%s sections_len=%s",
                    thread_id,
                    bundle_len,
                    sections_len,
                )
            # Limit messages history in checkpoint to avoid unbounded growth.
            msgs = channel_values.get("messages")
            if isinstance(msgs, list):
                max_turns = 20
                original_count = len(msgs)
                if original_count > max_turns:
                    channel_values["messages"] = msgs[-max_turns:]
                    logger.info(
                        "checkpoint.debug.messages_truncated thread=%s original=%s kept=%s",
                        thread_id,
                        original_count,
                        max_turns,
                    )

            channel_lengths = {}
            for key, value in channel_values.items():
                key_str = str(key)
                channel_lengths[key_str] = _approx_len(value)
        else:
            channel_values = None

        writes = checkpoint.get("writes")
        if not isinstance(writes, dict):
            writes = None

        try:
            _, serialized_checkpoint = self.serde.dumps_typed(checkpoint)
            serialized_checkpoint_len = len(serialized_checkpoint)
        except Exception:  # noqa: BLE001
            serialized_checkpoint_len = -1

        size_summary = {
            "state_total": _approx_len(state),
            "messages": _approx_len(state.get("messages")),
            "dialogue_window": _approx_len(state.get("dialogue_window")),
            "session_state": _approx_len(state.get("session_state")),
            "session_profile": _approx_len(state.get("session_profile")),
            "history_summary": _approx_len(state.get("history_summary")),
            "ag_ui_events": _approx_len(state.get("ag_ui_events")),
            "tool_summaries": _approx_len(state.get("tool_summaries")),
            "token_usage_events": _approx_len(state.get("token_usage_events")),
            "channel_values": _approx_len(channel_values),
            "writes": _approx_len(writes),
            "checkpoint_total": _approx_len(checkpoint),
            "metadata": _approx_len(metadata),
            "serialized_checkpoint_bytes": serialized_checkpoint_len,
        }

        if isinstance(new_versions, dict):
            new_versions_size = sum(
                _approx_len(v) for v in new_versions.values()
            )
            new_versions_len = len(new_versions)
        else:
            new_versions_size = _approx_len(new_versions)
            new_versions_len = (
                len(new_versions) if hasattr(new_versions, "__len__") else "n/a"
            )

        logger.info(
            "checkpoint.debug.before_put thread=%s sizes=%s new_versions_len=%s new_versions_size=%s channel_lengths=%s",
            thread_id,
            size_summary,
            new_versions_len,
            new_versions_size,
            channel_lengths,
        )

        try:
            return super().put(config, checkpoint, metadata, new_versions)
        except sqlite3.DataError:
            logger.exception(
                "checkpoint.debug.data_error thread=%s sizes=%s new_versions_size=%s channel_lengths=%s",
                thread_id,
                size_summary,
                new_versions_size,
                channel_lengths,
            )
            raise


__all__ = ["DebugSqliteSaver"]
