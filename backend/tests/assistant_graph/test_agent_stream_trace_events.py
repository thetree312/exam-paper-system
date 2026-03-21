from __future__ import annotations

from types import SimpleNamespace


def test_iter_stream_trace_events_keeps_assistant_text_for_message_stream() -> None:
    from app.agent.assistant_graph.router_runtime import iter_stream_trace_events

    message = SimpleNamespace(type="ai", content="final answer")

    events = iter_stream_trace_events("messages", (message, {"node": "agent_turn"}))

    assert events[0] == {"kind": "assistant_text", "id": None, "text": "final answer"}
    assert any(
        e.get("kind") == "agent_trace"
        and isinstance(e.get("payload"), dict)
        and e["payload"].get("trace_type") == "model_event"
        for e in events
    )


def test_iter_stream_trace_events_accepts_ai_message_chunk_stream() -> None:
    from app.agent.assistant_graph.router_runtime import iter_stream_trace_events

    message = SimpleNamespace(type="AIMessageChunk", content="增量token")

    events = iter_stream_trace_events("messages", (message, {"node": "decide"}))

    assert any(
        e.get("kind") == "assistant_text"
        and e.get("text") == "增量token"
        for e in events
    )


def test_iter_stream_trace_events_redacts_data_url_in_tool_output() -> None:
    from app.agent.assistant_graph.router_runtime import iter_stream_trace_events

    events = iter_stream_trace_events(
        "updates",
        {
            "execute_tools": {
                "tool_results": [
                    {
                        "tool_name": "read_kb_evidence",
                        "status": "ok",
                        "observation": {"query": "q", "summary": "s"},
                        "output": {
                            "vision_asset_inline": {
                                "data_url": "data:image/png;base64,AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDDEEEEEEEE"
                            }
                        },
                    }
                ]
            }
        },
    )

    payload = events[0]["payload"]
    data_url = payload["output"]["vision_asset_inline"]["data_url"]
    assert data_url.startswith("data:image/png;base64,")
    assert "[base64_len=" in data_url


def test_iter_stream_trace_events_extracts_tool_state_world_and_halt_payloads() -> None:
    from app.agent.assistant_graph.router_runtime import iter_stream_trace_events

    events = iter_stream_trace_events(
        "updates",
        {
            "agent_turn": {
                "tool_results": [
                    {
                        "tool_name": "read_kb_evidence",
                        "status": "ok",
                        "observation": {"query": "q", "summary": "s"},
                        "state_delta": {"evidence_items": [{"source_ref": "source:1"}]},
                    }
                ],
                "observations": [
                    {"status": "ok", "tool_name": "read_kb_evidence", "summary": "s"}
                ],
                "recent_changes": [
                    {
                        "change_type": "tool_result",
                        "tool_name": "read_kb_evidence",
                        "status": "ok",
                        "query": "q",
                        "summary": "s",
                        "source_refs": ["source:1"],
                    }
                ],
                "runtime_snapshot": {
                    "environment_window": {"active_surface": "workspace"},
                    "attention_state": {"focused_objects": ["query:q"], "stalled_paths": []},
                    "active_window": {"objects": [{"id": "source:1", "kind": "resource"}]},
                },
                "halt_reason": "answered",
            }
        },
    )

    assert events[-1] == {
        "kind": "agent_trace",
        "node": "agent_turn",
        "payload": {"trace_type": "halt", "node": "agent_turn", "halt_reason": "answered"},
    }


def test_iter_stream_trace_events_includes_model_native_thinking_payload() -> None:
    from app.agent.assistant_graph.router_runtime import iter_stream_trace_events

    events = iter_stream_trace_events(
        "updates",
        {
            "decide": {
                "model_native_traces": [
                    {
                        "trace_type": "model_native_thinking",
                        "node": "decide",
                        "content": "先确认问题语义，再决定是否检索。",
                        "chunks": ["先确认问题语义，", "再决定是否检索。"],
                    }
                ]
            }
        },
    )

    assert any(
        e.get("kind") == "agent_trace"
        and isinstance(e.get("payload"), dict)
        and e["payload"].get("trace_type") == "model_native_thinking"
        and e["payload"].get("content") == "先确认问题语义，再决定是否检索。"
        for e in events
    )


def test_iter_stream_trace_events_includes_world_state_changed_change() -> None:
    from app.agent.assistant_graph.router_runtime import iter_stream_trace_events

    events = iter_stream_trace_events(
        "updates",
        {
            "execute_tools": {
                "recent_changes": [
                    {
                        "change_type": "world_state_changed",
                        "diff": {"target_resolution": {"from": "unbound", "to": "ambiguous"}},
                    }
                ]
            }
        },
    )

    assert any(
        e.get("kind") == "agent_trace"
        and isinstance(e.get("payload"), dict)
        and e["payload"].get("trace_type") == "world_state_changed"
        for e in events
    )


def test_iter_stream_trace_events_emits_world_state_snapshot() -> None:
    from app.agent.assistant_graph.router_runtime import iter_stream_trace_events

    events = iter_stream_trace_events(
        "updates",
        {
            "memory_sync": {
                "runtime_snapshot": {
                    "environment_window": {"active_surface": "knowledge_base"},
                    "attention_state": {"focused_objects": ["kb_file:1056"], "stalled_paths": []},
                    "active_window": {"objects": ["kb_file:1056"]},
                }
            }
        },
    )

    assert any(
        e.get("kind") == "agent_trace"
        and isinstance(e.get("payload"), dict)
        and e["payload"].get("trace_type") == "world_state"
        and e["payload"].get("runtime_snapshot", {}).get("attention_state", {}).get("focused_objects") == ["kb_file:1056"]
        for e in events
    )
