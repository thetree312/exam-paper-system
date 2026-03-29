from __future__ import annotations

from types import SimpleNamespace


def test_get_file_kb_manifest_returns_layout_blocks_and_jobs() -> None:
    from app.routers import files as files_router

    file_obj = SimpleNamespace(id=1077)

    class _FakeQuery:
        def filter(self, *_args, **_kwargs):
            return self

        def first(self):
            return file_obj

    class _FakeExecuteResult:
        def __init__(self, rows):
            self._rows = rows

        def mappings(self):
            return self

        def first(self):
            return self._rows[0] if self._rows else None

        def all(self):
            return self._rows

    class _FakeDB:
        def query(self, *_args, **_kwargs):
            return _FakeQuery()

        def execute(self, sql, *_args, **_kwargs):
            text_sql = str(getattr(sql, "text", sql))
            if "FROM kb_sources" in text_sql:
                return _FakeExecuteResult(
                    [{"id": 44, "status": "ready", "title": "2025年高考全国一卷数学真题.pdf"}]
                )
            if "FROM kb_ingest_jobs" in text_sql:
                return _FakeExecuteResult(
                    [
                        {"stage": "layout_schedule", "status": "completed"},
                        {"stage": "layout_parse", "status": "completed"},
                        {"stage": "embed", "status": "completed"},
                    ]
                )
            if "FROM file_page_layout_cache" in text_sql:
                return _FakeExecuteResult(
                    [
                        {
                            "page_no": 7,
                            "status": "completed",
                            "blocks_json": [
                                {
                                    "page_no": 7,
                                    "layout_unit_key": "page:7/block:6",
                                    "block_label": "text",
                                    "bbox_norm": {"x1": 0.11, "y1": 0.32, "x2": 0.55, "y2": 0.40},
                                }
                            ],
                        }
                    ]
                )
            if "FROM kb_units" in text_sql:
                return _FakeExecuteResult(
                    [
                        {
                            "id": 251,
                            "unit_key": "page:7/block:6",
                            "unit_type": "layout_text",
                            "page_no_start": 7,
                            "title": "2025年高考全国一卷数学真题.pdf",
                            "text_content": "图例显示不同颜色对应不同风速等级。",
                            "primary_image_path": None,
                            "metadata_json": {"bbox_norm": {"x1": 0.11, "y1": 0.32, "x2": 0.55, "y2": 0.40}},
                        }
                    ]
                )
            if "FROM kb_chunks" in text_sql:
                return _FakeExecuteResult(
                    [
                        {
                            "id": 889,
                            "chunk_type": "layout_text",
                            "page_no": 7,
                            "content": "图例显示不同颜色对应不同风速等级。",
                            "metadata_json": {"bbox_norm": {"x1": 0.11, "y1": 0.32, "x2": 0.55, "y2": 0.40}},
                        }
                    ]
                )
            raise AssertionError(f"unexpected sql: {text_sql}")

    manifest = files_router.get_file_kb_manifest(1077, db=_FakeDB())

    assert manifest.file_id == 1077
    assert manifest.source is not None
    assert manifest.source.status == "ready"
    assert manifest.jobs[0].stage == "layout_schedule"
    assert manifest.layout_pages[0].page_no == 7
    assert manifest.layout_pages[0].blocks[0].layout_unit_key == "page:7/block:6"
    assert manifest.units[0].unit_key == "page:7/block:6"
    assert manifest.chunks[0].chunk_type == "layout_text"
