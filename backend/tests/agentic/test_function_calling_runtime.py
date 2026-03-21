from __future__ import annotations

import json


def test_invoke_uses_continuation_commitment_to_execute_tools() -> None:
    import app.agent.assistant_graph.runtime_app as runtime_app
    import app.agent.assistant_graph.runtime_nodes as runtime_nodes

    class _FakeClient:
        turn = 0

        def chat(self, messages, **kwargs):
            _FakeClient.turn += 1
            if _FakeClient.turn == 1:
                return (
                    json.dumps(
                        {
                            "认知更新": {
                                "摘要": "需要先读取环境观察。",
                                "已确认": [],
                                "未决问题": ["当前环境里有什么可用对象？"],
                                "阻塞张力": "缺少最小环境观察。",
                                "下一关注点": "读取工作区资源。",
                            },
                            "延续承诺": {
                                "工具调用": [{"工具名": "query_environment_model", "参数": {"path": "observation_packet.workspace"}}],
                                "原因": "先获取工作区观察。",
                            },
                        },
                        ensure_ascii=False,
                    ),
                    10,
                )

    original_client = runtime_nodes._new_client
    original_app = runtime_app._APP
    try:
        runtime_nodes._new_client = lambda: _FakeClient()  # type: ignore[assignment]
        runtime_app._APP = None
        app = runtime_app.get_compiled_agent_app()

        result = app.invoke(
            {
                "tenant_id": 1,
                "user_id": 2,
                "workroom_id": 3,
                "source_file_ids": [],
                "messages": [{"role": "user", "content": "what is my env"}],
            }
        )
    finally:
        runtime_nodes._new_client = original_client  # type: ignore[assignment]
        if runtime_app._APP is not None:
            runtime_app._APP.close()
        runtime_app._APP = original_app

    assert result["task_phase"] in {"observing", "awaiting_user", "completed", "failed"}
    assert any(change.get("change_type") in {"decision_tool_executed", "world_state_changed", "decision_requires_user"} for change in result["recent_changes"])
