from __future__ import annotations

from typing import Any


def test_runtime_common_memory_sync_advances_step_count() -> None:
    from app.agent.assistant_graph import runtime_common as rc

    state = {
        "context": {"ui_context": "exam_editor"},
        "messages": [{"role": "user", "content": "第六题的视风风速的坐标是什么"}],
        "step_count": 0,
        "runtime_snapshot": {},
        "world_state": {},
        "recent_changes": [],
        "short_term_rounds": 12,
        "short_term_summary": None,
        "evidence_register": [],
    }

    out = rc._node_memory_sync(state)  # type: ignore[arg-type]

    assert out["step_count"] == 1
    assert ((out["world_state"] or {}).get("last_step") or 0) == 1


def test_runtime_bootstrap_execute_tools_advances_step_count_and_world_model(monkeypatch: Any) -> None:
    import app.agent.assistant_graph.runtime_bootstrap as rb

    monkeypatch.setattr(
        rb,
        "_execute_tool_action",
        lambda **_: {
            "tool_name": "read_kb_evidence",
            "trace": {
                "tool_name": "read_kb_evidence",
                "tool_call_id": "call-1",
                "status": "ok",
                "observation": {"query": "第六题", "summary": "Readable evidence was found."},
                "source_refs": ["unit:1"],
                "output": {},
            },
            "history_msg": {"role": "tool", "name": "read_kb_evidence", "tool_call_id": "call-1", "content": []},
            "transient_msg": {"role": "tool", "name": "read_kb_evidence", "tool_call_id": "call-1", "content": []},
            "evidence_frame": {
                "frame_id": "frame-1",
                "tool_name": "read_kb_evidence",
                "tool_call_id": "call-1",
                "query": "第六题",
                "source_refs": ["unit:1"],
                "answerability": "answerable",
                "target_resolution": "bound",
                "summary": "Readable evidence was found.",
                "content": [{"type": "text", "text": "ok"}],
                "created_step": 1,
                "last_selected_step": None,
            },
            "feedback": {},
            "interrupt_request": None,
        },
    )
    monkeypatch.setattr(rb, "get_stream_writer", lambda: None)

    state = {
        "context": {"ui_context": "exam_editor", "agent_max_parallel_tools": 1},
        "messages": [{"role": "user", "content": "第六题的视风风速的坐标是什么"}],
        "step_count": 0,
        "task_phase": "acting",
        "recent_changes": [],
        "world_model": {},
        "runtime_snapshot": {},
        "model_turn": {
            "response_text": "",
            "tool_calls": [{"name": "read_kb_evidence", "arguments": {"query": "第六题"}, "reason": "", "call_id": "call-1"}],
            "interrupt_request": None,
            "assistant_tool_message": {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "call-1", "type": "function", "function": {"name": "read_kb_evidence", "arguments": "{}"}}],
            },
        },
        "evidence_register": [],
    }

    cmd = rb._node_execute_tools(state)  # type: ignore[arg-type]

    assert getattr(cmd, "goto", None) == "memory_sync"
    assert cmd.update["step_count"] == 1
    assert ((cmd.update["world_model"] or {}).get("last_step") or 0) == 1


def test_runtime_bootstrap_interrupt_user_advances_step_count(monkeypatch: Any) -> None:
    import app.agent.assistant_graph.runtime_bootstrap as rb

    monkeypatch.setattr(
        rb,
        "interrupt",
        lambda payload: {
            "interrupt_id": "intr-1",
            "action_id": "submit",
            "form_state": {"clarification": "基于现有真题变式"},
        },
    )

    state = {
        "context": {"ui_context": "exam_editor"},
        "messages": [{"role": "assistant", "content": "请补充信息"}],
        "interrupt_payload": {
            "interrupt_id": "intr-1",
            "openui": {"fields": [{"id": "clarification", "name": "clarification", "label": "请补充说明", "type": "text"}]},
        },
        "step_count": 2,
        "runtime_snapshot": {},
        "world_model": {},
    }

    cmd = rb._node_interrupt_user(state)  # type: ignore[arg-type]

    assert getattr(cmd, "goto", None) == "memory_sync"
    assert cmd.update["step_count"] == 3
    assert ((cmd.update["world_model"] or {}).get("last_step") or 0) == 3


def test_runtime_nodes_execute_tools_advances_step_count_between_rounds(monkeypatch: Any) -> None:
    import app.agent.assistant_graph.runtime_nodes as rn

    monkeypatch.setattr(
        rn,
        "_execute_tool_action",
        lambda **_: {
            "tool_name": "read_kb_evidence",
            "trace": {
                "tool_name": "read_kb_evidence",
                "status": "ok",
                "observation": {"query": "第六题", "summary": "Readable evidence was found."},
                "source_refs": ["unit:1"],
                "output": {},
            },
            "history_msg": {"role": "tool", "name": "read_kb_evidence", "tool_call_id": "call-1", "content": []},
            "transient_msg": {"role": "tool", "name": "read_kb_evidence", "tool_call_id": "call-1", "content": []},
            "feedback": {},
            "interrupt_request": None,
        },
    )

    state = {
        "context": {"ui_context": "exam_editor", "agent_max_parallel_tools": 1},
        "messages": [{"role": "user", "content": "第六题的视风风速的坐标是什么"}],
        "step_count": 0,
        "task_phase": "acting",
        "recent_changes": [],
        "world_state": {},
        "runtime_snapshot": {},
        "exec_state": {
            "pending_tool_calls": [{"name": "read_kb_evidence", "arguments": {"query": "第六题"}, "reason": "", "call_id": "call-1"}],
            "pending_tool_call": None,
            "pending_response": "",
            "pending_assistant_tool_message": {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "call-1", "type": "function", "function": {"name": "read_kb_evidence", "arguments": "{}"}}],
            },
        },
        "evidence_register": [],
    }

    cmd = rn._node_execute_tools(state)  # type: ignore[arg-type]

    assert getattr(cmd, "goto", None) == "memory_sync"
    assert cmd.update["step_count"] == 1
    assert ((cmd.update["world_state"] or {}).get("last_step") or 0) == 1
