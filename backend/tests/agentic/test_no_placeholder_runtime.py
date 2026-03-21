from __future__ import annotations

import json


def test_runtime_emits_model_answer_not_placeholder() -> None:
    import app.agent.assistant_graph.runtime_app as runtime_app
    import app.agent.assistant_graph.runtime_nodes as runtime_nodes

    class _FakeClient:
        def chat(self, messages, **kwargs):
            return (
                json.dumps(
                    {
                        "认知更新": {
                            "摘要": "当前已经可以直接回答。",
                            "已确认": ["问题足够明确。"],
                            "未决问题": [],
                            "阻塞张力": "",
                            "下一关注点": "直接回答。",
                        },
                        "延续承诺": {
                            "直接回复": "real answer",
                            "原因": "不需要更多外部变化。",
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
        result = app.invoke({"messages": [{"role": "user", "content": "question"}]})
    finally:
        runtime_nodes._new_client = original_client  # type: ignore[assignment]
        if runtime_app._APP is not None:
            runtime_app._APP.close()
        runtime_app._APP = original_app

    assert result["messages"][-1]["content"] == "real answer"
    assert "Learning coach received task" not in result["messages"][-1]["content"]
