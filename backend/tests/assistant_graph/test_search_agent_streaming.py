from __future__ import annotations

from typing import Any


def test_execution_runtime_emits_tool_events_without_user_delta(monkeypatch: Any) -> None:
    from app.agent.assistant_graph.nodes import execution_runtime
    from app.agent.assistant_graph.stream_registry import register_stream_handler, unregister_stream_handler

    events: list[dict] = []

    def _handler(evt: dict) -> None:
        events.append(evt)

    def _worker(_state: dict, _task: dict) -> dict:
        return {
            "result_type": "vector_retrieval",
            "content": {"query": "第6题", "snippets": [{"chunk_id": 1, "content": "示例"}]},
            "provenance": [{"source_type": "kb", "source_id": "s1", "file_id": 100}],
        }

    monkeypatch.setitem(execution_runtime.WORKER_REGISTRY, "vector_retrieve", _worker)

    thread_id = "test-runtime-streaming"
    register_stream_handler(thread_id, _handler)
    try:
        state = {
            "thread_id": thread_id,
            "active_tasks": [
                {
                    "task_id": "t1",
                    "tool": "vector_retrieve",
                    "objective": "检索第6题",
                    "inputs": {"query": "第6题"},
                }
            ],
        }
        out = execution_runtime.execution_runtime_node(state)
    finally:
        unregister_stream_handler(thread_id)

    results = out.get("task_results") or []
    assert len(results) == 1
    assert results[0].get("status") == "ok"
    assert results[0].get("result_type") == "vector_retrieval"
    assert not any(e.get("type") == "delta" for e in events)
    assert any(e.get("type") == "agent_trace" and e.get("stage") == "tool.start" for e in events)
    assert any(e.get("type") == "agent_trace" and e.get("stage") == "tool.end" for e in events)

