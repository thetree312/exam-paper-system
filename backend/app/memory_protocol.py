from __future__ import annotations

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
    "skill_instruction",
    "session_state_update_instruction",
}

SLOT_REMOVAL_PRIORITY: list[str] = [
    "retrieved_snippets",
    "tool_summaries",
    "batch_config",
    "note_context",
    "vision_summary",
    "history_summary",
    "doc_context",
]

SESSION_STATE_VIEW_FIELDS: dict[str, list[str]] = {
    "supervisor": ["mastery_brief", "active_topic_ids", "recent_difficulty_feedback"],
    "solver_intent": ["mastery_brief", "error_patterns", "practice_preferences"],
    "solver_reply": ["mastery_full", "learning_style", "difficulty_pref", "error_patterns"],
    "direct_reply": ["tone_preference"],
}

DEFAULT_SESSION_VIEW_FIELDS = ["mastery_brief"]
