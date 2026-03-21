from __future__ import annotations


def test_build_unknown_tool_output_is_semantic() -> None:
    from app.agent.assistant_graph.capability_realization import _build_unknown_tool_output

    out = _build_unknown_tool_output("open_document")

    assert out["error_type"] == "unknown_tool"
    assert out["attempted_tool"] == "open_document"
    assert isinstance(out.get("available_tools"), list)
    assert out.get("hint")
    assert isinstance(out.get("feedback"), dict)
    assert out["feedback"]["error_type"] == "unknown_tool"
    assert out["feedback"]["status"] == "error"


def test_tool_result_to_trace_keeps_unknown_tool_semantic_fields() -> None:
    from app.agent.assistant_graph.capability_realization import _build_unknown_tool_output
    from app.agent.assistant_graph.llm_tools import tool_result_to_trace as _tool_result_to_trace

    output = _build_unknown_tool_output("open_document")
    trace = _tool_result_to_trace(
        "open_document",
        {"source_file_id": 1},
        output,
        ok=False,
        tool_call_id="call-1",
    )

    assert trace["status"] == "error"
    compact = trace["output"]
    assert compact["error_type"] == "unknown_tool"
    assert compact["attempted_tool"] == "open_document"
    assert isinstance(compact.get("available_tools"), list)
    assert compact["feedback"]["status"] == "error"
