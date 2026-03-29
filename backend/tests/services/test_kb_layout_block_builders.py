from __future__ import annotations


def test_layout_block_builders_emit_block_rows_without_breaking_page_units() -> None:
    from app.services.kb.chunk_builders import (
        build_layout_chunk_rows,
        build_layout_unit_rows,
        build_page_unit_rows,
    )

    pages = [
        {
            "page_no": 1,
            "preview_image_path": "uploads/2/paper.page1.png",
            "preview_text": "intro text",
        }
    ]
    layout_blocks = [
        {
            "page_no": 1,
            "layout_unit_key": "page:1/block:0",
            "parent_unit_key": "page:1",
            "relation_type": "same_page",
            "block_label": "text",
            "bbox_norm": {"x1": 0.1, "y1": 0.2, "x2": 0.4, "y2": 0.3},
            "bbox_abs": {"x1": 100, "y1": 200, "x2": 400, "y2": 300},
            "content": "question stem",
            "crop_asset_ref": "uploads/2/paper.page1.blocks/block0000.text.png",
        },
        {
            "page_no": 1,
            "layout_unit_key": "page:1/block:1",
            "parent_unit_key": "page:1",
            "relation_type": "same_page",
            "block_label": "image",
            "bbox_norm": {"x1": 0.5, "y1": 0.2, "x2": 0.9, "y2": 0.7},
            "bbox_abs": {"x1": 500, "y1": 200, "x2": 900, "y2": 700},
            "content": "diagram",
            "crop_asset_ref": "uploads/2/paper.page1.blocks/block0001.image.png",
        },
    ]

    page_units = build_page_unit_rows([], pages, title="paper.pdf")
    layout_units = build_layout_unit_rows(layout_blocks, title="paper.pdf")
    layout_chunks = build_layout_chunk_rows(layout_blocks)

    assert len(page_units) == 1
    assert page_units[0].unit_key == "page:1"
    assert page_units[0].unit_type == "page"

    assert [row.unit_type for row in layout_units] == ["layout_text", "layout_image"]
    assert layout_units[0].metadata_json["parent_unit_key"] == "page:1"
    assert layout_units[1].primary_image_path == "uploads/2/paper.page1.blocks/block0001.image.png"
    assert layout_units[1].metadata_json["asset_ref"] == "uploads/2/paper.page1.blocks/block0001.image.png"

    assert [row.chunk_type for row in layout_chunks] == ["layout_text", "layout_image"]
    assert layout_chunks[0].content == "question stem"
    assert layout_chunks[1].metadata_json["parent_unit_key"] == "page:1"
    assert layout_chunks[1].metadata_json["asset_ref"] == "uploads/2/paper.page1.blocks/block0001.image.png"
