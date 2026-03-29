from __future__ import annotations


def test_resolve_final_answer_payload_builds_from_stream_result() -> None:
    from app.agent.router import _resolve_final_answer_payload

    result = {
        "messages": [
            {
                "role": "assistant",
                "content": "视风风速向量坐标是(3,1)。",
            }
        ],
        "tool_results": [
            {
                "tool_name": "read_kb_evidence",
                "status": "ok",
                "output": {
                    "citation_candidates": [
                        {
                            "citation_id": "cite:1",
                            "citation_index": 1,
                            "source_ref": "unit:193",
                            "file_id": 1077,
                            "page_no": 2,
                        }
                    ]
                },
            }
        ],
    }

    payload = _resolve_final_answer_payload(result)

    assert isinstance(payload, dict)
    assert payload["used_rag_evidence"] is True
    assert payload["citations"]
    assert payload["answer_text"].endswith("[1]")
