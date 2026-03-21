from __future__ import annotations


def test_persist_stores_raw_continuation_metadata_without_summary() -> None:
    from app.agent.assistant_graph.nodes.persist import persist_node

    state = {
        "tenant_id": 1,
        "user_id": 2,
        "session_id": None,
        "loaded_tools": ["tool_search", "read_kb_evidence", "read_workspace_index"],
        "tool_search_history": [
            {"query": "need kb retrieval", "added_tools": ["read_kb_evidence"]},
            {"query": "need workspace index", "added_tools": ["read_workspace_index"]},
        ],
        "user_profile": {},
    }

    out = persist_node(state)
    profile = out.get("user_profile") if isinstance(out.get("user_profile"), dict) else {}

    assert "continuation_summary_v1" not in profile
    assert profile.get("continuation_loaded_tools") == ["tool_search", "read_kb_evidence", "read_workspace_index", "load_tools"]
    assert profile.get("continuation_tool_search_history") == [
        {"query": "need kb retrieval", "added_tools": ["read_kb_evidence"]},
        {"query": "need workspace index", "added_tools": ["read_workspace_index"]},
    ]

