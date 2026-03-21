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
