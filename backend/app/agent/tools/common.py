from __future__ import annotations

from typing import Any


def build_feedback(
    *,
    status: str,
    outcome: str,
    reason: str,
    message: str,
    missing_information: list[str] | None = None,
    **extra: Any,
) -> dict[str, Any]:
    payload = {
        "status": str(status or "").strip(),
        "outcome": str(outcome or "").strip(),
        "reason": str(reason or "").strip(),
        "message": str(message or "").strip(),
        "missing_information": [
            str(item).strip()
            for item in (missing_information or [])
            if str(item).strip()
        ],
    }
    for key, value in extra.items():
        if value is None:
            continue
        payload[key] = value
    return payload


def normalize_int(value: Any, default: int, *, min_v: int, max_v: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(min_v, min(max_v, parsed))


def ctx_source_file_ids(ctx: dict[str, Any]) -> list[int]:
    return [int(x) for x in (ctx.get("source_file_ids") or []) if str(x).strip().isdigit()]


def ctx_environment_state(ctx: dict[str, Any]) -> dict[str, Any]:
    value = ctx.get("environment_state")
    return value if isinstance(value, dict) else {}


def ctx_runtime_state(ctx: dict[str, Any]) -> dict[str, Any]:
    value = ctx_environment_state(ctx).get("selection")
    return value if isinstance(value, dict) else {}


def ctx_environment_views(ctx: dict[str, Any]) -> dict[str, Any]:
    value = ctx_environment_state(ctx).get("layout")
    return value if isinstance(value, dict) else {}


def ctx_environment_artifacts(ctx: dict[str, Any]) -> dict[str, Any]:
    value = ctx_environment_state(ctx).get("artifacts")
    return value if isinstance(value, dict) else {}


def ctx_artifact_items(ctx: dict[str, Any]) -> list[dict[str, Any]]:
    items = ctx_environment_artifacts(ctx).get("items")
    return [item for item in list(items or []) if isinstance(item, dict)]
