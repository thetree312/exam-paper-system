from __future__ import annotations

from typing import Callable, List

from .types import AgentMessageEntry, AgentState

_STREAM_HANDLERS: dict[str, Callable[[dict], None]] = {}
_BASE_MESSAGES: dict[str, List[AgentMessageEntry]] = {}


def register_stream_handler(thread_id: str, handler: Callable[[dict], None]) -> None:
    if not thread_id or not handler:
        return
    _STREAM_HANDLERS[thread_id] = handler


def unregister_stream_handler(thread_id: str) -> None:
    if not thread_id:
        return
    _STREAM_HANDLERS.pop(thread_id, None)


def _get_stream_handler(state: AgentState) -> Callable[[dict], None] | None:
    thread_id = state.get("thread_id")
    if not isinstance(thread_id, str):
        return None
    return _STREAM_HANDLERS.get(thread_id)


def register_base_messages(thread_id: str, messages: List[AgentMessageEntry]) -> None:
    if not thread_id:
        return
    _BASE_MESSAGES[thread_id] = list(messages or [])


def unregister_base_messages(thread_id: str) -> None:
    if not thread_id:
        return
    _BASE_MESSAGES.pop(thread_id, None)


def _get_base_messages(state: AgentState) -> List[AgentMessageEntry]:
    thread_id = state.get("thread_id")
    if not isinstance(thread_id, str):
        return []
    return _BASE_MESSAGES.get(thread_id, [])


__all__ = [
    "register_stream_handler",
    "unregister_stream_handler",
    "_get_stream_handler",
    "register_base_messages",
    "unregister_base_messages",
    "_get_base_messages",
]
