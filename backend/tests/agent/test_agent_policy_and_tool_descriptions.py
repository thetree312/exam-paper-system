from __future__ import annotations


def test_agent_policy_targets_web_app_not_current_workroom() -> None:
    from app.agent.assistant_graph import runtime_bootstrap as rb

    policy = rb._AGENT_POLICY_TEXT

    assert "网页工作区中的" not in policy
    assert "当前网页环境中" not in policy
    assert "web 应用" in policy
    assert "不要假设信息只来自单一区域" in policy


def test_tool_descriptions_explain_environment_scope_without_center_bias() -> None:
    from app.agent.tools.registry import tool_definitions

    defs = {item.name: item.description for item in tool_definitions()}

    assert "center studio" not in defs["list_studio_sources"].lower()
    assert "current workroom" in defs["list_studio_sources"].lower()
    assert "studio area" in defs["list_studio_sources"].lower()

    assert "current workroom" in defs["get_studio_resource_summary"].lower()
    assert "studio area" in defs["get_studio_resource_summary"].lower()

    assert "current workroom" in defs["resolve_question_card_candidates"].lower()
    assert "current workroom" in defs["read_studio_question_card"].lower()
    assert "bound source files" in defs["read_kb_evidence"].lower()
    assert "bound source files" in defs["search_kb_candidates"].lower()
