from __future__ import annotations


def test_build_evidence_from_units_prefers_layout_crop_for_inline_image(monkeypatch) -> None:
    from app.agent.tools import knowledge_evidence as module

    monkeypatch.setattr(
        module,
        "_encode_asset_as_data_url",
        lambda path: f"data:image/mock;base64,{path}",
    )
    units = [
        {
            "unit_id": 11,
            "unit_key": "page:3",
            "unit_type": "page",
            "page_no_start": 3,
            "page_no_end": 3,
            "title": "paper-a.pdf",
            "text_content": "page summary",
            "primary_image_path": "uploads/2/paper-a.page3.png",
            "metadata_json": {"unit_type": "page"},
            "distance": 0.01,
            "file_id": 1056,
            "source_id": 700,
            "document_id": None,
            "source_type": "kb",
        },
        {
            "unit_id": 12,
            "unit_key": "page:3/block:1",
            "unit_type": "layout_image",
            "page_no_start": 3,
            "page_no_end": 3,
            "title": "paper-a.pdf",
            "text_content": None,
            "primary_image_path": "uploads/2/paper-a.page3.blocks/block0001.image.png",
            "metadata_json": {
                "unit_type": "layout_image",
                "layout_unit_key": "page:3/block:1",
                "parent_unit_key": "page:3",
                "relation_type": "same_page",
                "block_label": "image",
                "asset_ref": "uploads/2/paper-a.page3.blocks/block0001.image.png",
            },
            "distance": 0.05,
            "file_id": 1056,
            "source_id": 700,
            "document_id": None,
            "source_type": "kb",
        },
    ]

    built = module._build_evidence_from_units(query="question near figure", units=units)

    assert [item["asset_kind"] for item in built["asset_refs"]] == ["layout_crop", "page_preview"]
    assert built["best_asset_ref"]["asset_kind"] == "layout_crop"
    assert built["vision_asset_inline"]["chunk_id"] == 12
    assert built["model_message_content"][1]["image_url"]["url"].endswith(
        "uploads/2/paper-a.page3.blocks/block0001.image.png"
    )


def test_build_evidence_from_units_preserves_layout_relation_metadata() -> None:
    from app.agent.tools import knowledge_evidence as module

    units = [
        {
            "unit_id": 12,
            "unit_key": "page:3/block:1",
            "unit_type": "layout_image",
            "page_no_start": 3,
            "page_no_end": 3,
            "title": "paper-a.pdf",
            "text_content": None,
            "primary_image_path": "uploads/2/paper-a.page3.blocks/block0001.image.png",
            "metadata_json": {
                "unit_type": "layout_image",
                "layout_unit_key": "page:3/block:1",
                "parent_unit_key": "page:3",
                "relation_type": "same_page",
                "block_label": "image",
                "asset_ref": "uploads/2/paper-a.page3.blocks/block0001.image.png",
            },
            "distance": 0.05,
            "file_id": 1056,
            "source_id": 700,
            "document_id": None,
            "source_type": "kb",
        },
    ]

    built = module._build_evidence_from_units(query="question near figure", units=units)

    assert built["asset_refs"][0]["asset_kind"] == "layout_crop"
    assert built["asset_refs"][0]["layout_unit_key"] == "page:3/block:1"
    assert built["asset_refs"][0]["parent_unit_key"] == "page:3"
    assert built["asset_refs"][0]["relation_type"] == "same_page"
    assert built["model_input"]["evidence_units"][0]["metadata_json"]["layout_unit_key"] == "page:3/block:1"


def test_build_evidence_from_units_falls_back_to_asset_ref_when_primary_image_missing(monkeypatch) -> None:
    from app.agent.tools import knowledge_evidence as module

    monkeypatch.setattr(
        module,
        "_encode_asset_as_data_url",
        lambda path: f"data:image/mock;base64,{path}",
    )

    units = [
        {
            "unit_id": 193,
            "unit_key": "page:2/block:1",
            "unit_type": "layout_text",
            "page_no_start": 2,
            "page_no_end": 2,
            "title": "paper.pdf",
            "text_content": "某时刻测得的视风风速对应的向量与船速对应的向量如图2",
            "primary_image_path": None,
            "metadata_json": {
                "layout_unit_key": "page:2/block:1",
                "parent_unit_key": "page:2",
                "relation_type": "same_page",
                "block_label": "text",
                "asset_ref": "uploads/2/paper.page2.blocks/block0001.text.png",
            },
            "distance": 0.01,
            "file_id": 1077,
            "source_id": 700,
            "document_id": None,
            "source_type": "kb",
        },
    ]

    built = module._build_evidence_from_units(query="图2 视风风速 坐标", units=units)

    assert built["asset_refs"][0]["asset_rel_path"] == "uploads/2/paper.page2.blocks/block0001.text.png"
    assert built["best_asset_ref"]["asset_kind"] == "layout_crop"
    assert built["model_message_content"][1]["image_url"]["url"].endswith(
        "uploads/2/paper.page2.blocks/block0001.text.png"
    )


def test_build_evidence_from_units_exposes_bbox_for_citation_anchor() -> None:
    from app.agent.tools import knowledge_evidence as module

    units = [
        {
            "unit_id": 12,
            "unit_key": "page:3/block:1",
            "unit_type": "layout_image",
            "page_no_start": 3,
            "page_no_end": 3,
            "title": "paper-a.pdf",
            "text_content": None,
            "primary_image_path": "uploads/2/paper-a.page3.blocks/block0001.image.png",
            "metadata_json": {
                "unit_type": "layout_image",
                "layout_unit_key": "page:3/block:1",
                "parent_unit_key": "page:3",
                "relation_type": "same_page",
                "block_label": "image",
                "asset_ref": "uploads/2/paper-a.page3.blocks/block0001.image.png",
                "bbox_norm": {"x1": 0.1, "y1": 0.2, "x2": 0.6, "y2": 0.7},
                "bbox_abs": {"x1": 100, "y1": 200, "x2": 600, "y2": 700},
            },
            "distance": 0.05,
            "file_id": 1056,
            "source_id": 700,
            "document_id": None,
            "source_type": "kb",
        },
    ]

    built = module._build_evidence_from_units(query="question near figure", units=units)

    assert built["asset_refs"][0]["bbox_norm"] == {"x1": 0.1, "y1": 0.2, "x2": 0.6, "y2": 0.7}
    assert built["asset_refs"][0]["bbox_abs"] == {"x1": 100, "y1": 200, "x2": 600, "y2": 700}
    assert built["citation_candidates"][0]["citation_index"] == 1
    assert built["citation_candidates"][0]["source_ref"] == "unit:12"
    assert built["model_input"]["citation_candidates"][0]["source_ref"] == "unit:12"


def test_read_kb_snippets_from_unit_refs_preserves_citation_candidates(monkeypatch) -> None:
    from app.agent.tools import knowledge_evidence as module

    class FakeRAG:
        def get_units_by_ids(self, *, tenant_id, user_id, unit_ids):
            return [
                {
                    "unit_id": 12,
                    "unit_key": "page:3/block:1",
                    "unit_type": "layout_text",
                    "page_no_start": 3,
                    "page_no_end": 3,
                    "title": "paper-a.pdf",
                    "text_content": "图2中视风风速对应的向量起点为(0,2)，终点为(3,3)。",
                    "primary_image_path": "uploads/2/paper-a.page3.blocks/block0001.text.png",
                    "metadata_json": {
                        "layout_unit_key": "page:3/block:1",
                        "parent_unit_key": "page:3",
                        "relation_type": "same_page",
                        "block_label": "text",
                        "bbox_norm": {"x1": 0.1, "y1": 0.2, "x2": 0.6, "y2": 0.3},
                        "bbox_abs": {"x1": 100, "y1": 200, "x2": 600, "y2": 300},
                    },
                    "distance": 0.01,
                    "file_id": 1056,
                    "source_id": 700,
                    "document_id": None,
                    "source_type": "kb",
                },
            ]

    monkeypatch.setattr(module, "RAGService", lambda: FakeRAG())
    monkeypatch.setattr(module, "_encode_asset_as_data_url", lambda _path: None)

    result = module._read_kb_snippets_from_refs(["unit:12"], query="第六题 图2 坐标", ctx={"tenant_id": 2, "user_id": 2})

    assert result["citation_candidates"][0]["source_ref"] == "unit:12"
    assert result["model_input"]["citation_candidates"][0]["source_ref"] == "unit:12"
    assert "citation_candidates" in result["model_message_content"][0]["text"]


def test_read_kb_snippets_from_chunk_refs_preserves_citation_candidates(monkeypatch) -> None:
    from app.agent.tools import knowledge_evidence as module

    class FakeRAG:
        def get_chunks_by_ids(self, *, tenant_id, user_id, chunk_ids):
            return [
                {
                    "chunk_id": 193,
                    "distance": 0.0,
                    "chunk_type": "layout_text",
                    "content": "某时刻测得的视风风速对应的向量如图2。",
                    "metadata_json": {
                        "modality": "text",
                        "page_no": 2,
                        "bbox_norm": {"x1": 0.08, "y1": 0.09, "x2": 0.89, "y2": 0.13},
                        "bbox_abs": {"x1": 103, "y1": 147, "x2": 1071, "y2": 220},
                        "layout_unit_key": "page:2/block:3",
                        "parent_unit_key": "page:2",
                        "relation_type": "same_page",
                        "block_label": "text",
                    },
                    "file_id": 1077,
                    "document_id": None,
                    "page_start": 2,
                    "page_end": 2,
                    "source_id": 800,
                    "source_type": "kb",
                    "title": "2025全国一卷数学真题.pdf",
                }
            ]

    monkeypatch.setattr(module, "RAGService", lambda: FakeRAG())

    result = module._read_kb_snippets_from_refs(["chunk:193"], query="第六题 图2 坐标", ctx={"tenant_id": 2, "user_id": 2})

    assert result["citation_candidates"][0]["source_ref"] == "chunk:193"
    assert result["model_input"]["citation_candidates"][0]["source_ref"] == "chunk:193"
    assert "citation_candidates" in result["model_message_content"][0]["text"]


def test_tool_read_kb_snippets_fallback_preserves_citation_candidates(monkeypatch) -> None:
    from app.agent.tools import knowledge_evidence as module

    monkeypatch.setattr(
        module,
        "tool_read_kb_evidence",
        lambda args, ctx: {
            "query": args.get("query"),
            "snippets": [{"chunk_id": 193, "file_id": 1077, "page_start": 2, "page_end": 2, "content": "图2证据"}],
            "asset_refs": [],
            "source_refs": ["unit:193"],
            "doc_coverage": [{"file_id": 1077, "hit_count": 1, "text_hit_count": 1, "image_hit_count": 0, "best_distance": 0.0}],
            "target_resolution": "bound",
            "answerability": "partial_evidence",
            "evidence_modality": "text",
            "feedback": {"status": "partial"},
            "citation_candidates": [
                {
                    "citation_id": "cite:1",
                    "citation_index": 1,
                    "source_ref": "unit:193",
                    "file_id": 1077,
                    "page_no": 2,
                }
            ],
            "model_message_content": [{"type": "text", "text": "{\"query\":\"第六题\"}"}],
        },
    )

    result = module.tool_read_kb_snippets({"query": "第六题 图2 坐标"}, ctx={"tenant_id": 2, "user_id": 2})

    assert result["citation_candidates"][0]["source_ref"] == "unit:193"
    assert result["model_input"]["citation_candidates"][0]["source_ref"] == "unit:193"
    assert "citation_candidates" in result["model_message_content"][0]["text"]


def test_read_kb_snippets_from_group_refs_expands_member_chunks(monkeypatch) -> None:
    from app.agent.tools import knowledge_evidence as module

    class FakeRAG:
        def get_semantic_groups_by_ids(self, *, tenant_id, user_id, group_ids):
            return [
                {
                    "group_id": 901,
                    "group_key": "group:1",
                    "group_type": "mixed_region",
                    "page_no_start": 1,
                    "page_no_end": 2,
                    "title": "paper.pdf",
                    "text_content": "question stem plus figure",
                    "primary_image_path": "uploads/2/paper.page2.blocks/block0002.image.png",
                    "metadata_json": {"dominant_modality": "mixed"},
                    "distance": 0.01,
                    "file_id": 1056,
                    "source_id": 700,
                    "document_id": None,
                    "source_type": "kb",
                    "members": [
                        {
                            "group_id": 901,
                            "member_role": "body",
                            "member_order": 0,
                            "chunk_id": 401,
                            "chunk_type": "layout_text",
                            "content": "question stem",
                            "metadata_json": {
                                "modality": "text",
                                "page_no": 1,
                                "layout_unit_key": "page:1/block:13",
                                "parent_unit_key": "page:1",
                                "bbox_norm": {"x1": 0.08, "y1": 0.84, "x2": 0.90, "y2": 0.93},
                            },
                            "file_id": 1056,
                            "document_id": None,
                            "page_start": 1,
                            "page_end": 1,
                            "source_id": 700,
                            "source_type": "kb",
                            "title": "paper.pdf",
                        },
                        {
                            "group_id": 901,
                            "member_role": "figure",
                            "member_order": 1,
                            "chunk_id": 402,
                            "chunk_type": "layout_image",
                            "content": "[layout image page 2]",
                            "metadata_json": {
                                "modality": "image",
                                "page_no": 2,
                                "asset_ref": "uploads/2/paper.page2.blocks/block0002.image.png",
                                "layout_unit_key": "page:2/block:3",
                                "parent_unit_key": "page:2",
                                "bbox_norm": {"x1": 0.10, "y1": 0.15, "x2": 0.30, "y2": 0.45},
                            },
                            "file_id": 1056,
                            "document_id": None,
                            "page_start": 2,
                            "page_end": 2,
                            "source_id": 700,
                            "source_type": "kb",
                            "title": "paper.pdf",
                        },
                    ],
                }
            ]

    monkeypatch.setattr(module, "RAGService", lambda: FakeRAG())
    monkeypatch.setattr(module, "_encode_asset_as_data_url", lambda _path: None)

    result = module._read_kb_snippets_from_refs(["group:901"], query="question with figure", ctx={"tenant_id": 2, "user_id": 2})

    assert result["source_refs"] == ["group:901"]
    assert result["snippets"][0]["chunk_id"] == 401
    assert result["asset_refs"][0]["chunk_id"] == 402
    assert result["citation_candidates"][0]["source_ref"] == "chunk:402"
    assert result["citation_candidates"][1]["source_ref"] == "chunk:401"


def test_build_evidence_from_groups_emits_evidence_packages_and_primary_visual(monkeypatch) -> None:
    from app.agent.tools import knowledge_evidence as module

    monkeypatch.setattr(module, "_encode_asset_as_data_url", lambda path: f"data:image/mock;base64,{path}")

    groups = [
        {
            "group_id": 901,
            "group_key": "group:1",
            "group_type": "mixed_region",
            "page_no_start": 2,
            "page_no_end": 2,
            "title": "paper.pdf",
            "text_content": "question stem plus figure",
            "primary_image_path": "uploads/2/paper.page2.blocks/block0003.image.png",
            "metadata_json": {"dominant_modality": "mixed"},
            "distance": 0.01,
            "file_id": 1056,
            "source_id": 700,
            "document_id": None,
            "source_type": "kb",
            "members": [
                {
                    "group_id": 901,
                    "member_role": "body",
                    "member_order": 0,
                    "chunk_id": 401,
                    "chunk_type": "layout_text",
                    "content": "question stem",
                    "metadata_json": {
                        "modality": "text",
                        "page_no": 2,
                        "layout_unit_key": "page:2/block:1",
                    },
                    "file_id": 1056,
                    "document_id": None,
                    "page_start": 2,
                    "page_end": 2,
                    "source_id": 700,
                    "source_type": "kb",
                    "title": "paper.pdf",
                },
                {
                    "group_id": 901,
                    "member_role": "decoration",
                    "member_order": 1,
                    "chunk_id": 402,
                    "chunk_type": "layout_image",
                    "content": "[layout image page 2]",
                    "metadata_json": {
                        "modality": "image",
                        "page_no": 2,
                        "asset_ref": "uploads/2/paper.page2.blocks/block0000.image.png",
                        "layout_unit_key": "page:2/block:0",
                        "block_label": "image",
                        "bbox_norm": {"x1": 0.08, "y1": 0.05, "x2": 0.90, "y2": 0.08},
                    },
                    "file_id": 1056,
                    "document_id": None,
                    "page_start": 2,
                    "page_end": 2,
                    "source_id": 700,
                    "source_type": "kb",
                    "title": "paper.pdf",
                },
                {
                    "group_id": 901,
                    "member_role": "figure",
                    "member_order": 2,
                    "chunk_id": 403,
                    "chunk_type": "layout_image",
                    "content": "[layout image page 2]",
                    "metadata_json": {
                        "modality": "image",
                        "page_no": 2,
                        "asset_ref": "uploads/2/paper.page2.blocks/block0003.image.png",
                        "layout_unit_key": "page:2/block:3",
                        "block_label": "image",
                        "bbox_norm": {"x1": 0.10, "y1": 0.33, "x2": 0.30, "y2": 0.47},
                    },
                    "file_id": 1056,
                    "document_id": None,
                    "page_start": 2,
                    "page_end": 2,
                    "source_id": 700,
                    "source_type": "kb",
                    "title": "paper.pdf",
                },
            ],
        }
    ]

    built = module._build_evidence_from_groups(query="question with figure", groups=groups)

    assert built["evidence_packages"][0]["group_ref"] == "group:901"
    assert built["evidence_packages"][0]["primary_visual_ref"] == "chunk:403"
    assert built["evidence_packages"][0]["supporting_text_refs"] == ["chunk:401"]
    assert "evidence_packages" in built["model_input"]
    assert built["best_asset_ref"]["chunk_id"] == 403
    assert built["model_message_content"][1]["image_url"]["url"].endswith("block0003.image.png")


def test_tool_read_kb_evidence_exposes_evidence_packages(monkeypatch) -> None:
    from app.agent.tools import knowledge_evidence as module

    class FakeRAG:
        def search_semantic_groups(self, **kwargs):
            return [
                {
                    "group_id": 901,
                    "group_key": "group:1",
                    "group_type": "mixed_region",
                    "page_no_start": 2,
                    "page_no_end": 2,
                    "title": "paper.pdf",
                    "text_content": "question stem plus figure",
                    "primary_image_path": "uploads/2/paper.page2.blocks/block0003.image.png",
                    "metadata_json": {"dominant_modality": "mixed"},
                    "distance": 0.01,
                    "file_id": 1056,
                    "source_id": 700,
                    "document_id": None,
                    "source_type": "kb",
                    "members": [
                        {
                            "group_id": 901,
                            "member_role": "body",
                            "member_order": 0,
                            "chunk_id": 401,
                            "chunk_type": "layout_text",
                            "content": "question stem",
                            "metadata_json": {"modality": "text", "page_no": 2},
                            "file_id": 1056,
                            "document_id": None,
                            "page_start": 2,
                            "page_end": 2,
                            "source_id": 700,
                            "source_type": "kb",
                            "title": "paper.pdf",
                        },
                        {
                            "group_id": 901,
                            "member_role": "figure",
                            "member_order": 1,
                            "chunk_id": 403,
                            "chunk_type": "layout_image",
                            "content": "[layout image page 2]",
                            "metadata_json": {
                                "modality": "image",
                                "page_no": 2,
                                "asset_ref": "uploads/2/paper.page2.blocks/block0003.image.png",
                                "bbox_norm": {"x1": 0.10, "y1": 0.33, "x2": 0.30, "y2": 0.47},
                            },
                            "file_id": 1056,
                            "document_id": None,
                            "page_start": 2,
                            "page_end": 2,
                            "source_id": 700,
                            "source_type": "kb",
                            "title": "paper.pdf",
                        },
                    ],
                }
            ]

    monkeypatch.setattr(module, "RAGService", lambda: FakeRAG())
    monkeypatch.setattr(module, "_encode_asset_as_data_url", lambda path: f"data:image/mock;base64,{path}")
    monkeypatch.setattr(module, "ctx_source_file_ids", lambda _ctx: [1056])

    result = module.tool_read_kb_evidence(
        {"query": "question with figure", "top_k": 3},
        {"tenant_id": 2, "user_id": 2, "workroom_id": 30},
    )

    assert result["evidence_packages"][0]["primary_visual_ref"] == "chunk:403"
    assert result["model_input"]["evidence_packages"][0]["primary_visual_ref"] == "chunk:403"


def test_build_evidence_from_groups_uses_primary_package_for_citations_and_snippets(monkeypatch) -> None:
    from app.agent.tools import knowledge_evidence as module

    monkeypatch.setattr(module, "_encode_asset_as_data_url", lambda path: f"data:image/mock;base64,{path}")

    groups = [
        {
            "group_id": 15,
            "group_key": "group:15",
            "group_type": "mixed_region",
            "page_no_start": 2,
            "page_no_end": 2,
            "title": "paper.pdf",
            "text_content": "question package",
            "primary_image_path": "uploads/2/paper.page2.blocks/block0003.image.png",
            "metadata_json": {"dominant_modality": "mixed"},
            "distance": 0.20,
            "file_id": 1056,
            "source_id": 700,
            "document_id": None,
            "source_type": "kb",
            "members": [
                {
                    "group_id": 15,
                    "member_role": "decoration",
                    "member_order": 0,
                    "chunk_id": 1214,
                    "chunk_type": "layout_image",
                    "content": "[layout image page 2]",
                    "metadata_json": {
                        "modality": "image",
                        "page_no": 2,
                        "asset_ref": "uploads/2/paper.page2.blocks/block0000.image.png",
                        "bbox_norm": {"x1": 0.08, "y1": 0.05, "x2": 0.90, "y2": 0.08},
                    },
                    "file_id": 1056,
                    "document_id": None,
                    "page_start": 2,
                    "page_end": 2,
                    "source_id": 700,
                    "source_type": "kb",
                    "title": "paper.pdf",
                },
                {
                    "group_id": 15,
                    "member_role": "body",
                    "member_order": 1,
                    "chunk_id": 1215,
                    "chunk_type": "layout_text",
                    "content": "question stem",
                    "metadata_json": {"modality": "text", "page_no": 2},
                    "file_id": 1056,
                    "document_id": None,
                    "page_start": 2,
                    "page_end": 2,
                    "source_id": 700,
                    "source_type": "kb",
                    "title": "paper.pdf",
                },
                {
                    "group_id": 15,
                    "member_role": "table",
                    "member_order": 2,
                    "chunk_id": 1216,
                    "chunk_type": "layout_table",
                    "content": "<table>...</table>",
                    "metadata_json": {"modality": "text", "page_no": 2},
                    "file_id": 1056,
                    "document_id": None,
                    "page_start": 2,
                    "page_end": 2,
                    "source_id": 700,
                    "source_type": "kb",
                    "title": "paper.pdf",
                },
                {
                    "group_id": 15,
                    "member_role": "figure",
                    "member_order": 3,
                    "chunk_id": 1217,
                    "chunk_type": "layout_image",
                    "content": "[layout image page 2]",
                    "metadata_json": {
                        "modality": "image",
                        "page_no": 2,
                        "asset_ref": "uploads/2/paper.page2.blocks/block0003.image.png",
                        "bbox_norm": {"x1": 0.10, "y1": 0.33, "x2": 0.30, "y2": 0.47},
                    },
                    "file_id": 1056,
                    "document_id": None,
                    "page_start": 2,
                    "page_end": 2,
                    "source_id": 700,
                    "source_type": "kb",
                    "title": "paper.pdf",
                },
            ],
        },
        {
            "group_id": 20,
            "group_key": "group:20",
            "group_type": "text_flow",
            "page_no_start": 6,
            "page_no_end": 6,
            "title": "paper.pdf",
            "text_content": "notice section",
            "primary_image_path": None,
            "metadata_json": {"dominant_modality": "text"},
            "distance": 0.21,
            "file_id": 1056,
            "source_id": 700,
            "document_id": None,
            "source_type": "kb",
            "members": [
                {
                    "group_id": 20,
                    "member_role": "body",
                    "member_order": 0,
                    "chunk_id": 1260,
                    "chunk_type": "layout_text",
                    "content": "notice text",
                    "metadata_json": {"modality": "text", "page_no": 6},
                    "file_id": 1056,
                    "document_id": None,
                    "page_start": 6,
                    "page_end": 6,
                    "source_id": 700,
                    "source_type": "kb",
                    "title": "paper.pdf",
                },
            ],
        },
    ]

    built = module._build_evidence_from_groups(query="question with figure", groups=groups)

    assert built["evidence_packages"][0]["group_ref"] == "group:15"
    assert built["best_asset_ref"]["chunk_id"] == 1217
    assert [item["chunk_id"] for item in built["snippets"]] == [1215, 1216]
    assert [item["chunk_id"] for item in built["asset_refs"]] == [1217, 1214]
    assert [item["chunk_id"] for item in built["citation_candidates"]] == [1217, 1215, 1216, 1214]


def test_build_evidence_from_groups_keeps_input_group_order_for_active_package(monkeypatch) -> None:
    from app.agent.tools import knowledge_evidence as module

    monkeypatch.setattr(module, "_encode_asset_as_data_url", lambda path: f"data:image/mock;base64,{path}")

    groups = [
        {
            "group_id": 15,
            "group_key": "group:15",
            "group_type": "mixed_region",
            "page_no_start": 2,
            "page_no_end": 2,
            "title": "paper.pdf",
            "text_content": "first relevant group",
            "primary_image_path": "uploads/2/paper.page2.blocks/block0003.image.png",
            "distance": 0.38,
            "file_id": 1056,
            "source_id": 700,
            "document_id": None,
            "source_type": "kb",
            "members": [
                {
                    "group_id": 15,
                    "member_role": "body",
                    "member_order": 0,
                    "chunk_id": 1215,
                    "chunk_type": "layout_text",
                    "content": "question text",
                    "metadata_json": {"modality": "text"},
                    "file_id": 1056,
                    "document_id": None,
                    "page_start": 2,
                    "page_end": 2,
                    "source_id": 700,
                    "source_type": "kb",
                    "title": "paper.pdf",
                },
                {
                    "group_id": 15,
                    "member_role": "figure",
                    "member_order": 1,
                    "chunk_id": 1217,
                    "chunk_type": "layout_image",
                    "content": "[layout image page 2]",
                    "metadata_json": {
                        "modality": "image",
                        "asset_ref": "uploads/2/paper.page2.blocks/block0003.image.png",
                    },
                    "file_id": 1056,
                    "document_id": None,
                    "page_start": 2,
                    "page_end": 2,
                    "source_id": 700,
                    "source_type": "kb",
                    "title": "paper.pdf",
                },
            ],
        },
        {
            "group_id": 17,
            "group_key": "group:17",
            "group_type": "mixed_region",
            "page_no_start": 4,
            "page_no_end": 4,
            "title": "paper.pdf",
            "text_content": "second but visually richer group",
            "primary_image_path": "uploads/2/paper.page4.blocks/block0006.image.png",
            "distance": 0.43,
            "file_id": 1056,
            "source_id": 700,
            "document_id": None,
            "source_type": "kb",
            "members": [
                {
                    "group_id": 17,
                    "member_role": "body",
                    "member_order": 0,
                    "chunk_id": 1238,
                    "chunk_type": "layout_text",
                    "content": "other text",
                    "metadata_json": {"modality": "text"},
                    "file_id": 1056,
                    "document_id": None,
                    "page_start": 4,
                    "page_end": 4,
                    "source_id": 700,
                    "source_type": "kb",
                    "title": "paper.pdf",
                },
                {
                    "group_id": 17,
                    "member_role": "figure",
                    "member_order": 1,
                    "chunk_id": 1242,
                    "chunk_type": "layout_image",
                    "content": "[layout image page 4]",
                    "metadata_json": {
                        "modality": "image",
                        "asset_ref": "uploads/2/paper.page4.blocks/block0006.image.png",
                    },
                    "file_id": 1056,
                    "document_id": None,
                    "page_start": 4,
                    "page_end": 4,
                    "source_id": 700,
                    "source_type": "kb",
                    "title": "paper.pdf",
                },
            ],
        },
    ]

    built = module._build_evidence_from_groups(query="question with figure", groups=groups)

    assert built["source_refs"] == ["group:15"]
    assert built["evidence_packages"][0]["group_ref"] == "group:15"
    assert built["best_asset_ref"]["chunk_id"] == 1217


def test_tool_search_kb_candidates_returns_group_refs(monkeypatch) -> None:
    from app.agent.tools import knowledge_evidence as module

    class FakeRAG:
        def search_semantic_groups(self, **kwargs):
            return [
                {
                    "group_id": 901,
                    "group_key": "group:1",
                    "group_type": "mixed_region",
                    "page_no_start": 1,
                    "page_no_end": 2,
                    "title": "paper.pdf",
                    "distance": 0.1,
                    "source_id": 700,
                    "file_id": 1056,
                    "document_id": None,
                    "source_type": "kb",
                    "members": [],
                }
            ]

    monkeypatch.setattr(module, "RAGService", lambda: FakeRAG())
    monkeypatch.setattr(module, "ctx_source_file_ids", lambda _ctx: [1056])

    result = module.tool_search_kb_candidates(
        {"query": "question with figure", "top_k": 3},
        {"tenant_id": 2, "user_id": 2, "workroom_id": 30},
    )

    assert result["candidate_refs"] == ["group:901"]


def test_build_candidate_refs_from_groups_preserves_input_order() -> None:
    from app.agent.tools import knowledge_evidence as module

    raw = module._build_candidate_refs_from_groups(
        query="question with figure",
        groups=[
            {
                "group_id": 21,
                "group_type": "mixed_region",
                "page_no_start": 7,
                "page_no_end": 7,
                "title": "paper.pdf",
                "distance": 0.36,
                "file_id": 1056,
                "members": [
                    {
                        "chunk_id": 1267,
                        "chunk_type": "layout_image",
                        "member_role": "figure",
                        "metadata_json": {"bbox_norm": {"x1": 0.08, "y1": 0.05, "x2": 0.30, "y2": 0.08}},
                    }
                ],
            },
            {
                "group_id": 15,
                "group_type": "mixed_region",
                "page_no_start": 2,
                "page_no_end": 2,
                "title": "paper.pdf",
                "distance": 0.38,
                "file_id": 1056,
                "members": [
                    {
                        "chunk_id": 1217,
                        "chunk_type": "layout_image",
                        "member_role": "figure",
                        "metadata_json": {"bbox_norm": {"x1": 0.08, "y1": 0.33, "x2": 0.30, "y2": 0.47}},
                    }
                ],
            },
        ],
    )

    assert raw["candidate_refs"] == ["group:21", "group:15"]
