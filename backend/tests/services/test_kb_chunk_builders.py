from __future__ import annotations

from types import SimpleNamespace


def test_build_text_chunk_rows_uses_existing_python_parsed_blocks() -> None:
    from app.services.kb.chunk_builders import build_text_chunk_rows

    blocks = [
        SimpleNamespace(page_num=1, content="第一页题干" * 200),
        SimpleNamespace(page_num=2, content="第二页图注"),
    ]

    rows = build_text_chunk_rows(blocks, chunk_chars=120, overlap_chars=20)

    assert rows
    assert all(row.modality == "text" for row in rows)
    assert rows[0].page_no == 1
    assert any(row.page_no == 2 for row in rows)
    assert all(isinstance(row.embed_input, str) for row in rows)
    assert all(row.token_count > 0 for row in rows)


def test_build_semantic_group_rows_merges_adjacent_multimodal_blocks() -> None:
    from app.services.kb.chunk_builders import build_layout_chunk_rows, build_semantic_group_rows

    layout_blocks = [
        {
            "page_no": 2,
            "layout_unit_key": "page:2/block:1",
            "parent_unit_key": "page:2",
            "relation_type": "same_page",
            "block_label": "text",
            "bbox_norm": {"x1": 0.08, "y1": 0.08, "x2": 0.90, "y2": 0.13},
            "content": "Question stem before figure",
            "crop_asset_ref": "uploads/2/paper.page2.blocks/block0001.text.png",
        },
        {
            "page_no": 2,
            "layout_unit_key": "page:2/block:2",
            "parent_unit_key": "page:2",
            "relation_type": "same_page",
            "block_label": "image",
            "bbox_norm": {"x1": 0.10, "y1": 0.15, "x2": 0.30, "y2": 0.45},
            "content": "",
            "crop_asset_ref": "uploads/2/paper.page2.blocks/block0002.image.png",
        },
        {
            "page_no": 2,
            "layout_unit_key": "page:2/block:3",
            "parent_unit_key": "page:2",
            "relation_type": "same_page",
            "block_label": "text",
            "bbox_norm": {"x1": 0.08, "y1": 0.47, "x2": 0.90, "y2": 0.52},
            "content": "Answer options under figure",
            "crop_asset_ref": "uploads/2/paper.page2.blocks/block0003.text.png",
        },
    ]

    chunk_rows = build_layout_chunk_rows(layout_blocks)
    group_rows, memberships = build_semantic_group_rows(chunk_rows, title="paper.pdf")

    assert len(group_rows) == 1
    assert group_rows[0].group_type == "mixed_region"
    assert group_rows[0].page_no_start == 2
    assert group_rows[0].page_no_end == 2
    assert "Question stem before figure" in str(group_rows[0].text_content)
    assert "Answer options under figure" in str(group_rows[0].text_content)
    assert group_rows[0].primary_image_path == "uploads/2/paper.page2.blocks/block0002.image.png"
    assert [member.member_role for member in memberships] == ["body", "figure", "body"]


def test_build_semantic_group_rows_merges_cross_page_text_flow() -> None:
    from app.services.kb.chunk_builders import build_layout_chunk_rows, build_semantic_group_rows

    layout_blocks = [
        {
            "page_no": 1,
            "layout_unit_key": "page:1/block:9",
            "parent_unit_key": "page:1",
            "relation_type": "same_page",
            "block_label": "text",
            "bbox_norm": {"x1": 0.08, "y1": 0.84, "x2": 0.90, "y2": 0.93},
            "content": "A paragraph ending at the bottom of page one",
            "crop_asset_ref": "uploads/2/paper.page1.blocks/block0009.text.png",
        },
        {
            "page_no": 2,
            "layout_unit_key": "page:2/block:1",
            "parent_unit_key": "page:2",
            "relation_type": "same_page",
            "block_label": "text",
            "bbox_norm": {"x1": 0.08, "y1": 0.08, "x2": 0.90, "y2": 0.14},
            "content": "Continuation at the top of page two",
            "crop_asset_ref": "uploads/2/paper.page2.blocks/block0001.text.png",
        },
    ]

    chunk_rows = build_layout_chunk_rows(layout_blocks)
    group_rows, memberships = build_semantic_group_rows(chunk_rows, title="paper.pdf")

    assert len(group_rows) == 1
    assert group_rows[0].group_type == "text_flow"
    assert group_rows[0].page_no_start == 1
    assert group_rows[0].page_no_end == 2
    assert "A paragraph ending at the bottom of page one" in str(group_rows[0].text_content)
    assert "Continuation at the top of page two" in str(group_rows[0].text_content)
    assert len(memberships) == 2


def test_filter_boilerplate_chunk_rows_for_kb_removes_recurring_top_banner_images() -> None:
    from app.services.kb.chunk_builders import build_layout_chunk_rows, filter_boilerplate_chunk_rows_for_kb

    layout_blocks = [
        {
            "page_no": 1,
            "layout_unit_key": "page:1/block:0",
            "parent_unit_key": "page:1",
            "relation_type": "same_page",
            "block_label": "image",
            "bbox_norm": {"x1": 0.08, "y1": 0.05, "x2": 0.30, "y2": 0.08},
            "content": "[layout image page 1]",
            "crop_asset_ref": "uploads/2/paper.page1.blocks/block0000.image.png",
        },
        {
            "page_no": 2,
            "layout_unit_key": "page:2/block:0",
            "parent_unit_key": "page:2",
            "relation_type": "same_page",
            "block_label": "image",
            "bbox_norm": {"x1": 0.08, "y1": 0.05, "x2": 0.30, "y2": 0.08},
            "content": "[layout image page 2]",
            "crop_asset_ref": "uploads/2/paper.page2.blocks/block0000.image.png",
        },
        {
            "page_no": 3,
            "layout_unit_key": "page:3/block:0",
            "parent_unit_key": "page:3",
            "relation_type": "same_page",
            "block_label": "image",
            "bbox_norm": {"x1": 0.08, "y1": 0.05, "x2": 0.30, "y2": 0.08},
            "content": "[layout image page 3]",
            "crop_asset_ref": "uploads/2/paper.page3.blocks/block0000.image.png",
        },
        {
            "page_no": 2,
            "layout_unit_key": "page:2/block:1",
            "parent_unit_key": "page:2",
            "relation_type": "same_page",
            "block_label": "text",
            "bbox_norm": {"x1": 0.08, "y1": 0.09, "x2": 0.90, "y2": 0.13},
            "content": "Actual question text under the page header",
            "crop_asset_ref": "uploads/2/paper.page2.blocks/block0001.text.png",
        },
    ]

    chunk_rows = build_layout_chunk_rows(layout_blocks)
    filtered_rows = filter_boilerplate_chunk_rows_for_kb(chunk_rows)

    assert len(filtered_rows) == 1
    assert filtered_rows[0].page_no == 2
    assert filtered_rows[0].content == "Actual question text under the page header"


def test_filter_boilerplate_chunk_rows_for_kb_removes_recurring_header_text() -> None:
    from app.services.kb.chunk_builders import build_layout_chunk_rows, filter_boilerplate_chunk_rows_for_kb

    layout_blocks = [
        {
            "page_no": 1,
            "layout_unit_key": "page:1/block:0",
            "parent_unit_key": "page:1",
            "relation_type": "same_page",
            "block_label": "text",
            "bbox_norm": {"x1": 0.06, "y1": 0.04, "x2": 0.92, "y2": 0.08},
            "content": "School header and publication banner",
            "crop_asset_ref": "uploads/2/paper.page1.blocks/block0000.text.png",
        },
        {
            "page_no": 2,
            "layout_unit_key": "page:2/block:0",
            "parent_unit_key": "page:2",
            "relation_type": "same_page",
            "block_label": "text",
            "bbox_norm": {"x1": 0.06, "y1": 0.04, "x2": 0.92, "y2": 0.08},
            "content": "School header and publication banner",
            "crop_asset_ref": "uploads/2/paper.page2.blocks/block0000.text.png",
        },
        {
            "page_no": 3,
            "layout_unit_key": "page:3/block:0",
            "parent_unit_key": "page:3",
            "relation_type": "same_page",
            "block_label": "text",
            "bbox_norm": {"x1": 0.06, "y1": 0.04, "x2": 0.92, "y2": 0.08},
            "content": "School header and publication banner",
            "crop_asset_ref": "uploads/2/paper.page3.blocks/block0000.text.png",
        },
        {
            "page_no": 2,
            "layout_unit_key": "page:2/block:1",
            "parent_unit_key": "page:2",
            "relation_type": "same_page",
            "block_label": "text",
            "bbox_norm": {"x1": 0.08, "y1": 0.12, "x2": 0.90, "y2": 0.17},
            "content": "Real document body text begins here",
            "crop_asset_ref": "uploads/2/paper.page2.blocks/block0001.text.png",
        },
    ]

    chunk_rows = build_layout_chunk_rows(layout_blocks)
    filtered_rows = filter_boilerplate_chunk_rows_for_kb(chunk_rows)

    assert len(filtered_rows) == 1
    assert filtered_rows[0].page_no == 2
    assert filtered_rows[0].content == "Real document body text begins here"
