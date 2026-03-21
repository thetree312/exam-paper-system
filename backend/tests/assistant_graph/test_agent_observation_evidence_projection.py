from __future__ import annotations


def test_build_model_view_uses_top_level_environment_and_evidence_projection() -> None:
    from app.agent.assistant_graph.agent_observation import build_model_view

    model_view = build_model_view(
        {
            "messages": [{"role": "user", "content": "第六题图例里视风风速的坐标是什么？"}],
            "environment": {
                "kb": {"content_state": "has_source_content", "objects": ["source:1054"]},
                "workspace": {"content_state": "empty", "objects": []},
            },
            "task_results": [
                {
                    "result_type": "kb_evidence",
                    "content": {
                        "query": "第六题 图例 视风风速 坐标",
                        "snippets": [
                            {"page": 2, "content": "视风风速向量从(0,2)指向(3,3)。"},
                            {"page": 2, "content": "图例中风速坐标标注清晰。"},
                        ],
                    },
                }
            ],
        }
    )

    assert model_view["environment"] == {
        "kb": {"content_state": "has_source_content", "objects": ["source:1054"]},
        "workspace": {"content_state": "empty", "objects": []},
    }
    last_action_result = model_view.get("last_action_result") or {}
    assert last_action_result == {
        "kind": "kb_evidence",
        "snippet_previews": [
            "视风风速向量从(0,2)指向(3,3)。",
            "图例中风速坐标标注清晰。",
        ],
        "pages": [2, 2],
    }

