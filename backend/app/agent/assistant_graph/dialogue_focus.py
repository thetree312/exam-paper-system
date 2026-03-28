from __future__ import annotations

from typing import Any


_SCOPE_RESET_CUES = (
    "换个问题",
    "另一个问题",
    "新问题",
    "另外一个问题",
    "switch topic",
    "new question",
    "different question",
    "different issue",
)

_FEEDBACK_CUES = (
    "不对",
    "不是",
    "错了",
    "看错",
    "反了",
    "漏了",
    "参考答案",
    "wrong",
    "incorrect",
    "not right",
    "not correct",
    "you missed",
    "actually",
)


def _text_content(message: dict[str, Any] | None) -> str:
    msg = message if isinstance(message, dict) else {}
    content = msg.get("content")
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        if str(item.get("type") or "text").strip().lower() != "text":
            continue
        text = str(item.get("text") or "").strip()
        if text:
            parts.append(text)
    return "\n".join(parts).strip()


def _visible_user_texts(messages: list[dict[str, Any]] | None) -> list[str]:
    texts: list[str] = []
    for item in messages or []:
        if str((item or {}).get("role") or "").strip().lower() != "user":
            continue
        text = _text_content(item)
        if text:
            texts.append(text)
    return texts


def _has_prior_assistant(messages: list[dict[str, Any]] | None) -> bool:
    latest_user_index = -1
    for idx in range(len(messages or []) - 1, -1, -1):
        item = (messages or [])[idx]
        if str((item or {}).get("role") or "").strip().lower() == "user":
            latest_user_index = idx
            break
    if latest_user_index <= 0:
        return False
    for item in (messages or [])[:latest_user_index]:
        if str((item or {}).get("role") or "").strip().lower() == "assistant":
            return True
    return False


def _looks_like_scope_reset(text: str) -> bool:
    lowered = str(text or "").strip().lower()
    return any(cue in lowered for cue in _SCOPE_RESET_CUES)


def _looks_like_feedback(text: str) -> bool:
    lowered = str(text or "").strip().lower()
    return any(cue in lowered for cue in _FEEDBACK_CUES)


def derive_dialogue_focus(
    *,
    messages: list[dict[str, Any]] | None,
    previous_scope: str | None,
) -> dict[str, str | None]:
    user_texts = _visible_user_texts(messages)
    latest_user = str(user_texts[-1] if user_texts else "").strip()
    first_user = str(user_texts[0] if user_texts else "").strip()

    subject_scope = str(previous_scope or "").strip() or first_user or latest_user
    if latest_user and _looks_like_scope_reset(latest_user):
        subject_scope = latest_user

    turn_intent = latest_user or subject_scope
    feedback_signal = None
    if latest_user and _has_prior_assistant(messages) and _looks_like_feedback(latest_user):
        feedback_signal = latest_user

    return {
        "subject_scope": subject_scope or None,
        "turn_intent": turn_intent or None,
        "feedback_signal": feedback_signal,
    }
