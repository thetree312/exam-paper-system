from __future__ import annotations

import json

from app.agent.assistant_graph.evidence_register import build_compact_tool_observation_content


def test_compact_tool_observation_content_keeps_citation_candidates() -> None:
    content = build_compact_tool_observation_content(
        tool_name="read_kb_evidence",
        tool_call_id="call-1",
        trace={
            "observation": {
                "query": "第六题 图例 坐标",
                "summary": "Readable evidence was found.",
            }
        },
        output={
            "answerability": "partial_evidence",
            "target_resolution": "bound",
            "source_refs": ["unit:193"],
            "model_message_content": [
                {
                    "type": "text",
                    "text": json.dumps(
                        {
                            "query": "第六题 图例 坐标",
                            "snippets": [{"chunk_id": 193, "file_id": 1077, "content": "snippet"}],
                            "citation_candidates": [
                                {
                                    "citation_id": "cite:1",
                                    "citation_index": 1,
                                    "source_ref": "chunk:193",
                                    "file_id": 1077,
                                    "page_no": 2,
                                    "bbox_norm": {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4},
                                    "excerpt": "某时刻测得的视风风速对应的向量与船速对应的向量如图2",
                                }
                            ],
                        },
                        ensure_ascii=False,
                    ),
                }
            ],
        },
        include_carryforward=True,
        include_observation_memory=True,
        include_image_parts=False,
    )

    assert isinstance(content, list)
    payload = json.loads(content[0]["text"])
    assert payload["query"] == "第六题 图例 坐标"
    assert payload["citation_candidates"][0]["citation_index"] == 1
    assert payload["citation_candidates"][0]["source_ref"] == "chunk:193"
    assert payload["citation_candidates"][0]["bbox_norm"]["w"] == 0.3
