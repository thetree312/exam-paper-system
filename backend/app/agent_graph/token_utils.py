from __future__ import annotations

from typing import List

from .types import AgentMessageEntry

try:  # pragma: no cover
    import tiktoken  # type: ignore[import]

    _ENCODER = tiktoken.get_encoding("cl100k_base")
except Exception:  # noqa: BLE001
    _ENCODER = None

SOFT_TOKEN_LIMIT = 40000
HARD_TOKEN_LIMIT = 128000


def _estimate_tokens_for_messages(msgs: List[AgentMessageEntry]) -> int:
    if not msgs:
        return 0
    parts: list[str] = []
    for m in msgs:
        if not isinstance(m, dict):
            continue
        role = m.get("role") or ""
        content = str(m.get("content") or "")
        parts.append(f"{role}: {content}")
    blob = "\n".join(parts)
    if not blob:
        return 0
    if _ENCODER is None:
        return max(1, len(blob) // 3)
    try:
        return len(_ENCODER.encode(blob))
    except Exception:  # noqa: BLE001
        return max(1, len(blob) // 3)


__all__ = [
    "SOFT_TOKEN_LIMIT",
    "HARD_TOKEN_LIMIT",
    "_estimate_tokens_for_messages",
]
