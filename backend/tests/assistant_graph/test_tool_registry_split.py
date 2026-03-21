from __future__ import annotations


def test_tool_registry_contains_split_kb_tools() -> None:
    from app.agent.tools.registry import tool_definitions

    names = [t.name for t in tool_definitions()]
    assert "read_kb_evidence" in names
    assert "search_kb_candidates" in names
    assert "read_kb_snippets" in names
    assert "get_workspace_resource_summary" in names
    assert "resolve_question_card_candidates" in names
    assert "read_workspace_question_card" in names
