from __future__ import annotations


def test_build_citation_anchor_from_unit_normalizes_layout_bbox() -> None:
    from app.agent.citations import build_citation_anchor_from_unit

    unit = {
        "unit_id": 251,
        "unit_key": "page:7/block:6",
        "unit_type": "layout_text",
        "page_no_start": 7,
        "page_no_end": 7,
        "title": "2025-gaokao-math.pdf",
        "text_content": "图例显示不同颜色对应不同风速等级。",
        "primary_image_path": None,
        "metadata_json": {
            "layout_unit_key": "page:7/block:6",
            "bbox_norm": {"x1": 0.11, "y1": 0.32, "x2": 0.55, "y2": 0.40},
            "bbox_abs": {"x1": 110, "y1": 320, "x2": 550, "y2": 400},
        },
        "file_id": 1077,
    }

    anchor = build_citation_anchor_from_unit(
        unit,
        citation_id="cite:1",
        citation_index=1,
        source_ref="unit:251",
    )

    assert anchor["citation_id"] == "cite:1"
    assert anchor["citation_index"] == 1
    assert anchor["source_ref"] == "unit:251"
    assert anchor["anchor_type"] == "layout_block"
    assert anchor["file_id"] == 1077
    assert anchor["page_no"] == 7
    assert anchor["unit_key"] == "page:7/block:6"
    assert anchor["excerpt"] == "图例显示不同颜色对应不同风速等级。"
    assert anchor["bbox_norm"] == {"x": 0.11, "y": 0.32, "w": 0.44, "h": 0.08}
    assert anchor["bbox_abs"] == {"x1": 110, "y1": 320, "x2": 550, "y2": 400}
    assert anchor["preview_url"] == "/api/files/preview/1077?page=7"


def test_dedupe_citation_anchors_keeps_first_identity_and_drops_duplicates() -> None:
    from app.agent.citations import dedupe_citation_anchors

    anchors = [
        {"citation_id": "cite:1", "source_ref": "unit:251", "file_id": 1077, "page_no": 7},
        {"citation_id": "cite:2", "source_ref": "unit:251", "file_id": 1077, "page_no": 7},
        {"citation_id": "cite:3", "source_ref": "chunk:889", "file_id": 1077, "page_no": 8},
    ]

    deduped = dedupe_citation_anchors(anchors)

    assert deduped == [
        {"citation_id": "cite:1", "source_ref": "unit:251", "file_id": 1077, "page_no": 7},
        {"citation_id": "cite:3", "source_ref": "chunk:889", "file_id": 1077, "page_no": 8},
    ]


def test_build_final_answer_payload_auto_injects_markers_when_rag_candidates_exist() -> None:
    from app.agent.final_answer_citations import build_final_answer_payload

    payload = build_final_answer_payload(
        "这是普通回答，没有引用标记。",
        [
            {
                "tool_name": "read_kb_evidence",
                "status": "ok",
                "output": {
                    "citation_candidates": [
                        {"citation_id": "cite:1", "citation_index": 1, "source_ref": "unit:251"}
                    ]
                },
            }
        ],
    )

    assert payload["used_rag_evidence"] is True
    assert payload["citation_status"] == "complete"
    assert payload["cited_indices"] == [1]
    assert payload["answer_text"].endswith("[1]")
    assert payload["citations"][0]["source_ref"] == "unit:251"


def test_build_final_answer_payload_resolves_only_cited_rag_indices() -> None:
    from app.agent.final_answer_citations import build_final_answer_payload

    payload = build_final_answer_payload(
        "图例说明风速按颜色分级展示[1]，横轴表示时间顺序[2]。",
        [
            {
                "tool_name": "read_kb_evidence",
                "status": "ok",
                "output": {
                    "citation_candidates": [
                        {"citation_id": "cite:1", "citation_index": 1, "source_ref": "unit:251"},
                        {"citation_id": "cite:2", "citation_index": 2, "source_ref": "unit:252"},
                        {"citation_id": "cite:3", "citation_index": 3, "source_ref": "unit:253"},
                    ]
                },
            }
        ],
    )

    assert payload["used_rag_evidence"] is True
    assert payload["citation_status"] == "complete"
    assert [item["citation_index"] for item in payload["citations"]] == [1, 2]


def test_build_final_answer_payload_ignores_non_rag_tool_results() -> None:
    from app.agent.final_answer_citations import build_final_answer_payload

    payload = build_final_answer_payload(
        "这是带有 [1] 的普通回答。",
        [
            {
                "tool_name": "read_studio_document",
                "status": "ok",
                "output": {
                    "citation_candidates": [
                        {"citation_id": "cite:1", "citation_index": 1, "source_ref": "question:88"}
                    ]
                },
            }
        ],
    )

    assert payload["used_rag_evidence"] is False
    assert payload["citation_status"] == "none"
    assert payload["citations"] == []


def test_build_final_answer_payload_injects_citations_when_rag_used_but_model_omits_markers() -> None:
    from app.agent.final_answer_citations import build_final_answer_payload

    payload = build_final_answer_payload(
        "视风风速对应的向量坐标是(3,1)。",
        [
            {
                "tool_name": "read_kb_evidence",
                "status": "ok",
                "output": {
                    "citation_candidates": [
                        {"citation_id": "cite:1", "citation_index": 1, "source_ref": "unit:193"},
                        {"citation_id": "cite:2", "citation_index": 2, "source_ref": "unit:171"},
                    ]
                },
            }
        ],
    )

    assert payload["used_rag_evidence"] is True
    assert payload["citation_status"] == "complete"
    assert payload["cited_indices"] == [1, 2]
    assert payload["answer_text"].endswith("[1][2]")
    assert [item["citation_index"] for item in payload["citations"]] == [1, 2]
