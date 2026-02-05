from __future__ import annotations



import json

from typing import List



from .token_utils import _estimate_tokens_for_messages

from .types import (

    AgentMessageEntry,

    AgentState,

    _extract_role_content,

    _limit_text,

)



SESSION_STATE_VIEW_FIELDS: dict[str, list[str]] = {

    "supervisor": ["mastery_brief", "active_topic_ids", "recent_difficulty_feedback"],

    "solver_intent": ["mastery_brief", "error_patterns", "practice_preferences"],

    "solver_reply": ["mastery_full", "learning_style", "difficulty_pref", "error_patterns"],

    "direct_reply": ["tone_preference"],

}

DEFAULT_SESSION_VIEW_FIELDS = ["mastery_brief"]





def _session_state_view(state: AgentState, node_name: str) -> dict:

    allowed_fields = SESSION_STATE_VIEW_FIELDS.get(node_name, DEFAULT_SESSION_VIEW_FIELDS)

    view: dict = {}



    raw_state = state.get("session_state")

    if not isinstance(raw_state, dict):

        raw_state = {}

    for field in allowed_fields:

        if field in raw_state:

            view[field] = raw_state[field]



    if not view:

        profile = state.get("session_profile")

        if isinstance(profile, dict):

            for field in allowed_fields:

                if field in profile:

                    view[field] = profile[field]



    mastery = view.get("mastery_full")

    if isinstance(mastery, dict) and len(mastery) > 5:

        view["mastery_full"] = {k: mastery[k] for k in list(mastery.keys())[:5]}

    return view





def _dialogue_window_snippet(dialogue_window: List[AgentMessageEntry] | None) -> str:

    if not dialogue_window:

        return ""

    lines: List[str] = []

    for msg in dialogue_window:

        role, content = _extract_role_content(msg)

        if role not in ("user", "assistant"):

            continue

        lines.append(f"{role}: {_limit_text(content, 360)}")

    return "\n".join(lines[-8:])





def _latest_user_from_dialogue(dialogue_window: List[AgentMessageEntry] | None) -> str | None:

    if not dialogue_window:

        return None

    for msg in reversed(dialogue_window):

        role, content = _extract_role_content(msg)

        if role == "user" and content:

            return content

    return None





PROMPT_SLOT_SEQUENCE: list[str] = [

    "instruction",

    "session_state_view",

    "history_summary",

    "retrieved_snippets",

    "doc_context",

    "vision_summary",

    "note_context",

    "batch_config",

    "tool_feedback",

    "tool_summaries",

    "supervisor_instruction",

    "reply_outline",

    "expected_new_questions",

    "focus_instruction",

    "session_state_update_instruction",

    "skill_instruction",

    "dialogue_window",

]



ALLOWED_DYNAMIC_SLOTS = {

    "note_context",

    "batch_config",

    "tool_feedback",

    "tool_summaries",

    "supervisor_instruction",

    "reply_outline",

    "expected_new_questions",

    "focus_instruction",

    "session_state_update_instruction",

    "skill_instruction",

    "doc_context",

    "vision_summary",

}



_SLOT_REMOVAL_PRIORITY: list[str] = [

    "retrieved_snippets",

    "tool_summaries",

    "batch_config",

    "note_context",

    "vision_summary",

    "history_summary",

    "doc_context",

]





def _enforce_slot_budget(slots: List[tuple[str, AgentMessageEntry]], limit: int) -> List[tuple[str, AgentMessageEntry]]:

    if not slots or limit <= 0:

        return slots



    def _calc_tokens() -> int:

        return _estimate_tokens_for_messages([msg for _slot, msg in slots])



    current_tokens = _calc_tokens()

    if current_tokens <= limit:

        return slots



    for slot_name in _SLOT_REMOVAL_PRIORITY:

        idx = next((i for i, (name, _msg) in enumerate(slots) if name == slot_name), None)

        if idx is None:

            continue

        slots.pop(idx)

        current_tokens = _calc_tokens()

        if current_tokens <= limit:

            return slots

    return slots





def _coerce_message(value: str | AgentMessageEntry) -> AgentMessageEntry | None:

    if isinstance(value, dict):

        content = value.get("content")

        if content in (None, ""):

            return None

        role = value.get("role") or "system"

        return {"role": role, "content": str(content)}

    if value is None:

        return None

    text = str(value).strip()

    if not text:

        return None

    return {"role": "system", "content": text}





def _normalize_slot_values(values: List[str | AgentMessageEntry] | str | AgentMessageEntry | None) -> list[AgentMessageEntry]:

    if values is None:

        return []

    if not isinstance(values, list):

        values = [values]

    normalized: list[AgentMessageEntry] = []

    for v in values:

        msg = _coerce_message(v)

        if msg:

            normalized.append(msg)

    return normalized





def _build_slot_prompt(

    *,

    state: AgentState,

    node_name: str,

    instruction: str | None,

    slot_payload: dict[str, List[str | AgentMessageEntry] | str | AgentMessageEntry] | None = None,

    token_limit: int = 8000,

) -> List[AgentMessageEntry]:

    slot_messages: dict[str, list[AgentMessageEntry]] = {name: [] for name in PROMPT_SLOT_SEQUENCE}



    if instruction:

        slot_messages["instruction"].extend(_normalize_slot_values(instruction))



    session_view = _session_state_view(state, node_name)

    if session_view:

        session_view_json = json.dumps(session_view, ensure_ascii=False)

        slot_messages["session_state_view"].append({"role": "system", "content": f"【会话状态】\n{session_view_json}"})



    history_summary = state.get("history_summary")

    if isinstance(history_summary, str) and history_summary.strip():

        slot_messages["history_summary"].append(

            {"role": "system", "content": f"【历史对话摘要】\n{history_summary.strip()}"}

        )



    if state.get("rag_enabled") and state.get("retrieved_snippets"):

        snippets = "\n".join(state.get("retrieved_snippets") or [])

        if snippets.strip():

            slot_messages["retrieved_snippets"].append(

                {"role": "system", "content": f"【历史讲解参考】\n{snippets.strip()}"}

            )



    doc_context = state.get("doc_context")

    if isinstance(doc_context, str) and doc_context.strip():

        slot_messages["doc_context"].append({"role": "system", "content": doc_context.strip()})



    vision_summary = state.get("vision_summary")

    if isinstance(vision_summary, str) and vision_summary.strip():

        slot_messages["vision_summary"].append(

            {"role": "system", "content": f"【图像理解摘要】\n{vision_summary.strip()}"}

        )



    tool_summaries = state.get("tool_summaries")

    if isinstance(tool_summaries, list) and tool_summaries:

        joined = "\n".join(str(item) for item in tool_summaries if item)

        if joined.strip():

            slot_messages["tool_summaries"].append(

                {"role": "system", "content": f"【本轮出题结果摘要】\n{joined.strip()}"}

            )



    if slot_payload:

        invalid = set(slot_payload.keys()) - ALLOWED_DYNAMIC_SLOTS

        if invalid:

            raise ValueError(f"不支持的 Prompt 槽位: {invalid}")

        for slot_name, payload_values in slot_payload.items():

            slot_messages[slot_name].extend(_normalize_slot_values(payload_values))



    dialogue_entries = []

    for msg in state.get("dialogue_window") or []:

        if isinstance(msg, dict):

            role = msg.get("role")

            content = msg.get("content")

            if role in ("user", "assistant") and content:

                dialogue_entries.append({"role": role, "content": str(content)})

    slot_messages["dialogue_window"].extend(dialogue_entries)



    ordered_slots: list[tuple[str, AgentMessageEntry]] = []

    for slot_name in PROMPT_SLOT_SEQUENCE:

        for msg in slot_messages.get(slot_name, []):

            ordered_slots.append((slot_name, msg))



    ordered_slots = _enforce_slot_budget(ordered_slots, token_limit)

    return [msg for _slot, msg in ordered_slots]





__all__ = [

    "ALLOWED_DYNAMIC_SLOTS",

    "PROMPT_SLOT_SEQUENCE",

    "SESSION_STATE_VIEW_FIELDS",

    "DEFAULT_SESSION_VIEW_FIELDS",

    "_build_slot_prompt",

    "_dialogue_window_snippet",

    "_enforce_slot_budget",

    "_latest_user_from_dialogue",

    "_session_state_view",

]

