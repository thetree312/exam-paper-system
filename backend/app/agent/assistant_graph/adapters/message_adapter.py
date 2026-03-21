from __future__ import annotations

from typing import Any

ALLOWED_ROLES = {"system", "user", "assistant", "tool"}


def _read_field(item: Any, key: str) -> Any:
    if isinstance(item, dict):
        return item.get(key)
    if hasattr(item, key):
        return getattr(item, key)
    model_dump = getattr(item, "model_dump", None)
    if callable(model_dump):
        dumped = model_dump()
        if isinstance(dumped, dict):
            return dumped.get(key)
    return None


def sanitize_conversation_messages(messages: list[Any] | None) -> list[dict[str, str]]:
    sanitized: list[dict[str, str]] = []
    for item in messages or []:
        role = str(_read_field(item, "role") or "user").strip().lower()
        if role not in ALLOWED_ROLES:
            role = "user"
        content = str(_read_field(item, "content") or "")
        if role == "assistant" and not content.strip():
            continue
        sanitized.append({"role": role, "content": content})
    return sanitized


def normalize_messages(raw: list[Any] | None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in raw or []:
        role = str(_read_field(item, "role") or "user").strip().lower()
        if role not in ALLOWED_ROLES:
            role = "user"
        raw_content = _read_field(item, "content")
        if isinstance(raw_content, (list, dict)):
            content: Any = raw_content
        else:
            content = str(raw_content or "")
        record: dict[str, Any] = {"role": role, "content": content}
        name = _read_field(item, "name")
        if isinstance(name, str) and name:
            record["name"] = name
        tool_call_id = _read_field(item, "tool_call_id")
        if isinstance(tool_call_id, str) and tool_call_id:
            record["tool_call_id"] = tool_call_id
        tool_calls = _read_field(item, "tool_calls")
        if isinstance(tool_calls, list) and tool_calls:
            normalized_tool_calls: list[dict[str, Any]] = []
            for call in tool_calls:
                if not isinstance(call, dict):
                    continue
                normalized_call = dict(call)
                fn = normalized_call.get("function")
                if isinstance(fn, dict):
                    normalized_call["function"] = dict(fn)
                normalized_tool_calls.append(normalized_call)
            if normalized_tool_calls:
                record["tool_calls"] = normalized_tool_calls
        out.append(record)
    return out


def sanitize_tool_content_for_history(content: Any) -> Any:
    if isinstance(content, str):
        text = content
        if len(text) > 1600:
            text = text[:1600] + f"...[truncated {len(text) - 1600} chars]"
        return text
    if isinstance(content, list):
        sanitized: list[dict[str, Any]] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            part_type = str(item.get("type") or "").strip().lower()
            if part_type == "text":
                text = str(item.get("text") or "")
                if len(text) > 1200:
                    text = text[:1200] + f"...[truncated {len(text) - 1200} chars]"
                sanitized.append({"type": "text", "text": text})
        return sanitized
    if isinstance(content, dict):
        out = dict(content)
        if "data_url" in out:
            out["data_url"] = "[omitted_data_url]"
        return out
    return content


def strip_meta_system_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in messages:
        role = str(item.get("role") or "").strip().lower()
        if role != "system":
            out.append(item)
            continue
        content = str(item.get("content") or "")
        if "嵌入在网页工作区中的环境驱动单体智能体" in content:
            continue
        if content.startswith("[Session memory summary]"):
            continue
        out.append(item)
    return out


def dedupe_preserve_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in values:
        key = str(item or "").strip()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(key)
    return out


def latest_user_query(messages: list[dict[str, Any]] | None) -> str:
    for item in reversed(messages or []):
        role = str(item.get("role") or "").strip().lower()
        if role == "user":
            content = item.get("content")
            if isinstance(content, str):
                return content.strip()
            if isinstance(content, list):
                text_parts: list[str] = []
                for part in content:
                    if isinstance(part, dict) and str(part.get("type") or "").strip().lower() == "text":
                        text_parts.append(str(part.get("text") or ""))
                return "".join(text_parts).strip()
    return ""


def latest_tool_observation_summary(recent_changes: list[dict[str, Any]] | None) -> str:
    for change in reversed(recent_changes or []):
        if not isinstance(change, dict):
            continue
        change_type = str(change.get("change_type") or "").strip().lower()
        if change_type not in {"tool_result", "tool_error"}:
            continue
        tool_name = str(change.get("tool_name") or "").strip()
        summary = str(change.get("summary") or "").strip()
        query = str(change.get("query") or "").strip()
        status = str(change.get("status") or "").strip()
        parts = [p for p in [f"tool={tool_name}" if tool_name else "", f"status={status}" if status else "", f"query={query}" if query else "", f"summary={summary}" if summary else ""] if p]
        return "; ".join(parts)
    return ""


def build_continuity_prompt(
    *,
    step_count: int,
    previous_thinking: str,
    latest_user_query_value: str,
    latest_tool_observation: str,
) -> str:
    unresolved = previous_thinking[-260:].strip() if previous_thinking else ""
    parts = [
        "[连续思考契约]",
        "你处于同一任务的持续推理链中。",
        "不要重新开题，不要复述用户原问题，除非用户目标发生变化。",
        "只输出能推动下一动作的增量推理，并明确承接最近一次工具观察。",
        f"当前循环步数: {int(step_count)}。",
    ]
    if latest_user_query_value:
        parts.append(f"当前用户目标(仅供参照): {latest_user_query_value}")
    if latest_tool_observation:
        parts.append(f"最近工具观察: {latest_tool_observation}")
    if unresolved:
        parts.append(f"上一轮推理尾部: {unresolved}")
    return "\n".join(parts)


def is_fresh_conversation(messages: list[Any] | None) -> bool:
    normalized = sanitize_conversation_messages(messages)
    return len(normalized) <= 1


def to_state_messages(messages: list[Any] | None) -> list[dict[str, str]]:
    return sanitize_conversation_messages(messages)


def from_state_messages(messages: list[Any] | None) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for item in messages or []:
        role = str(_read_field(item, "role") or "assistant").strip().lower()
        if role not in ALLOWED_ROLES:
            continue
        out.append({"role": role, "content": str(_read_field(item, "content") or "")})
    return out


__all__ = [
    "sanitize_conversation_messages",
    "normalize_messages",
    "sanitize_tool_content_for_history",
    "strip_meta_system_messages",
    "dedupe_preserve_order",
    "latest_user_query",
    "latest_tool_observation_summary",
    "build_continuity_prompt",
    "is_fresh_conversation",
    "to_state_messages",
    "from_state_messages",
]
