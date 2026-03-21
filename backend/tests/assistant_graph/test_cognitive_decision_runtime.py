from __future__ import annotations

import json
from typing import Any


def test_agent_policy_requires_native_thinking_in_chinese() -> None:
    from app.agent.assistant_graph.runtime_common import _AGENT_POLICY_TEXT

    assert "原生 thinking" in _AGENT_POLICY_TEXT
    assert "原生 reasoning" in _AGENT_POLICY_TEXT
    assert "全部使用简体中文" in _AGENT_POLICY_TEXT


def test_parse_decision_payload_accepts_chinese_cognitive_update_and_commitment() -> None:
    from app.agent.assistant_graph.runtime_nodes import _parse_decision_payload

    payload = _parse_decision_payload(
        json.dumps(
            {
                "认知更新": {
                    "摘要": "当前还不能安全行动，因为第六题指向的对象尚未唯一绑定。",
                    "已确认": ["当前工作区没有打开文档。"],
                    "未决问题": ["用户说的第六题属于哪一份材料？"],
                    "阻塞张力": "共享指称尚未完成。",
                    "下一关注点": "先获得能唯一绑定第六题对象的新观察。",
                },
                "延续承诺": {
                    "用户澄清请求": "你说的第六题是哪个文件或试卷里的第六题？",
                    "原因": "当前缺的是指称绑定，不是证据细节。",
                },
            },
            ensure_ascii=False,
        )
    )

    assert payload["认知更新"]["摘要"] == "当前还不能安全行动，因为第六题指向的对象尚未唯一绑定。"
    assert payload["延续承诺"]["用户澄清请求"] == "你说的第六题是哪个文件或试卷里的第六题？"
    assert payload["延续承诺"]["工具调用"] == []
    assert payload["延续承诺"]["直接回复"] == ""


def test_node_decide_stores_chinese_cognition_and_continuation_turn() -> None:
    import app.agent.assistant_graph.runtime_nodes as rn

    def _fake_invoke_model_text(
        *,
        client: Any,
        messages: list[dict[str, Any]],
        node_name: str,
        stream_writer: Any = None,
    ) -> tuple[str, list[str]]:
        return (
            json.dumps(
                {
                    "认知更新": {
                        "摘要": "当前还不能安全行动，因为第六题指向的对象尚未唯一绑定。",
                        "已确认": ["当前工作区没有打开文档。", "知识库里存在多个候选来源。"],
                        "未决问题": ["用户说的第六题属于哪一份材料？"],
                        "阻塞张力": "共享指称尚未完成，继续取证会扩大噪音。",
                        "下一关注点": "先获得能唯一绑定第六题对象的新观察。",
                    },
                    "延续承诺": {
                        "用户澄清请求": "你说的第六题是哪个文件或试卷里的第六题？",
                        "原因": "当前缺的是指称绑定，不是证据细节。",
                    },
                },
                ensure_ascii=False,
            ),
            ["先修订当前认知状态，再决定是否引入外部变化。"],
        )

    original_invoke = rn._invoke_model_text
    original_new_client = rn._new_client
    original_writer = rn.get_stream_writer
    try:
        rn._invoke_model_text = _fake_invoke_model_text  # type: ignore[assignment]
        rn._new_client = lambda: object()  # type: ignore[assignment]
        rn.get_stream_writer = lambda: None  # type: ignore[assignment]

        state = {
            "context": {"ui_context": "exam_editor"},
            "messages": [
                {"role": "system", "content": "base system"},
                {"role": "user", "content": "第六题图例视风风速的坐标是什么"},
            ],
            "model_messages": [
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "当前用户请求": "第六题图例视风风速的坐标是什么",
                            "当前世界状态": {},
                            "当前认知状态": None,
                            "新观察": {},
                        },
                        ensure_ascii=False,
                    ),
                },
            ],
            "runtime_snapshot": {},
            "step_count": 0,
        }

        cmd = rn._node_decide(state)  # type: ignore[arg-type]
    finally:
        rn._invoke_model_text = original_invoke  # type: ignore[assignment]
        rn._new_client = original_new_client  # type: ignore[assignment]
        rn.get_stream_writer = original_writer  # type: ignore[assignment]

    assert getattr(cmd, "goto", None) == "execute_tools"
    assert cmd.update["cognitive_state"]["摘要"] == "当前还不能安全行动，因为第六题指向的对象尚未唯一绑定。"
    assert cmd.update["continuation_turn"]["用户澄清请求"] == "你说的第六题是哪个文件或试卷里的第六题？"
    assert cmd.update["thinking_accumulator"] == "当前还不能安全行动，因为第六题指向的对象尚未唯一绑定。"


def test_node_execute_tools_advances_step_count_between_rounds() -> None:
    import app.agent.assistant_graph.runtime_nodes as rn

    state = {
        "context": {"ui_context": "exam_editor"},
        "messages": [{"role": "user", "content": "第六题图例视风风速的坐标是什么"}],
        "step_count": 0,
        "task_phase": "acting",
        "recent_changes": [],
        "world_state": {},
        "runtime_snapshot": {},
        "continuation_turn": {
            "工具调用": [{"name": "list_workspace_sources", "arguments": {}, "reason": "", "call_id": "call-1"}],
            "助手工具消息": {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "call-1", "type": "function", "function": {"name": "list_workspace_sources", "arguments": "{}"}}],
            },
            "用户澄清请求": "",
            "直接回复": "",
            "原因": "需要新的环境观察。",
        },
    }

    original_execute = rn._execute_tool_action
    try:
        rn._execute_tool_action = lambda **_: {  # type: ignore[assignment]
            "tool_name": "list_workspace_sources",
            "trace": {
                "tool_name": "list_workspace_sources",
                "status": "ok",
                "observation": {"query": "", "summary": "已读取工作区资源汇总。"},
                "source_refs": [],
                "output": {"objects": [], "observations": []},
            },
            "history_msg": {"role": "tool", "name": "list_workspace_sources", "tool_call_id": "call-1", "content": "{}"},
            "transient_msg": {"role": "tool", "name": "list_workspace_sources", "tool_call_id": "call-1", "content": "{}"},
            "feedback": {},
            "interrupt_request": None,
        }
        cmd = rn._node_execute_tools(state)  # type: ignore[arg-type]
    finally:
        rn._execute_tool_action = original_execute  # type: ignore[assignment]

    assert getattr(cmd, "goto", None) == "memory_sync"
    assert cmd.update["step_count"] == 1


def test_parse_decision_payload_accepts_markdown_json_fence() -> None:
    from app.agent.assistant_graph.runtime_nodes import _parse_decision_payload

    raw = """```json
{
  "璁ょ煡鏇存柊": {
    "鎽樿": "当前还不能直接回答。",
    "宸茬‘璁?": ["工作区为空。"],
    "鏈喅闂": ["第六题属于哪份材料？"],
    "闃诲寮犲姏": "指代尚未唯一绑定。",
    "涓嬩竴鍏虫敞鐐?": "先澄清第六题来源。"
  },
  "寤剁画鎵胯": {
    "鐢ㄦ埛婢勬竻璇锋眰": "你说的第六题属于哪份试卷或文件？",
    "鍘熷洜": "当前缺的是指代绑定。"
  }
}
```"""

    payload = _parse_decision_payload(raw)

    assert payload["璁ょ煡鏇存柊"]["鎽樿"] == "当前还不能直接回答。"
    assert payload["寤剁画鎵胯"]["鐢ㄦ埛婢勬竻璇锋眰"] == "你说的第六题属于哪份试卷或文件？"
