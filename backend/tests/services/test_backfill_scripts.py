from __future__ import annotations

from types import SimpleNamespace


def test_backfill_page_layout_cache_skips_completed_pages_and_uses_preview_assets() -> None:
    from scripts.backfill_page_layout_cache import backfill_page_layout_for_files

    file_obj = SimpleNamespace(
        id=88,
        tenant_id=2,
        uploader_id=3,
        source_type="pdf",
        preview_path="uploads/2/paper.page1.png",
        content_hash="abc123",
    )
    seen_assets: list[str] = []
    completed_marks: list[tuple[int, str]] = []

    class _FakeCacheManager:
        def get_completed(self, **kwargs):
            if int(kwargs["page_no"]) == 1:
                return SimpleNamespace(id=501, status="completed")
            return None

        def try_acquire(self, **kwargs):
            return SimpleNamespace(id=502, page_no=kwargs["page_no"])

        def mark_completed(self, *, entry, layout_json, blocks_json, transport_kind):
            completed_marks.append((int(entry.page_no), transport_kind))
            return entry

    class _FakeLayoutService:
        def parse_page(self, *, asset_ref, page_no):
            seen_assets.append(asset_ref)
            return SimpleNamespace(
                raw_payload={"page_no": page_no},
                blocks=[{"page_no": page_no, "layout_unit_key": f"page:{page_no}/block:0"}],
                transport_kind="data_url",
            )

    summary = backfill_page_layout_for_files(
        db=SimpleNamespace(),
        files=[file_obj],
        detect_page_count=lambda _file: 2,
        page_asset_resolver=lambda *, file, page_no: f"uploads/2/paper.page{page_no}.png",
        cache_manager=_FakeCacheManager(),
        page_layout_service=_FakeLayoutService(),
    )

    assert summary == {
        "files_seen": 1,
        "pages_total": 2,
        "pages_skipped": 1,
        "pages_completed": 1,
    }
    assert seen_assets == ["uploads/2/paper.page2.png"]
    assert completed_marks == [(2, "data_url")]


def test_backfill_kb_layout_blocks_skips_ready_sources() -> None:
    from scripts.backfill_kb_layout_blocks import backfill_kb_layout_blocks_for_files

    file_obj = SimpleNamespace(id=88, tenant_id=2, uploader_id=3)
    ingested: list[int] = []

    class _FakeDB:
        def execute(self, *_args, **_kwargs):
            return SimpleNamespace(mappings=lambda: SimpleNamespace(first=lambda: {"status": "ready"}))

    summary = backfill_kb_layout_blocks_for_files(
        db=_FakeDB(),
        files=[file_obj],
        ingest_callback=lambda **kwargs: ingested.append(int(kwargs["file_id"])),
    )

    assert summary == {"files_seen": 1, "files_skipped": 1, "files_materialized": 0}
    assert ingested == []


def test_backfill_kb_layout_blocks_runs_ingest_for_unmaterialized_files() -> None:
    from scripts.backfill_kb_layout_blocks import backfill_kb_layout_blocks_for_files

    file_obj = SimpleNamespace(id=88, tenant_id=2, uploader_id=3)
    ingested: list[tuple[int, int, int | None, int]] = []

    class _FakeDB:
        def execute(self, *_args, **_kwargs):
            return SimpleNamespace(mappings=lambda: SimpleNamespace(first=lambda: None))

    summary = backfill_kb_layout_blocks_for_files(
        db=_FakeDB(),
        files=[file_obj],
        ingest_callback=lambda **kwargs: ingested.append(
            (
                int(kwargs["tenant_id"]),
                int(kwargs["user_id"]),
                kwargs["workroom_id"],
                int(kwargs["file_id"]),
            )
        ),
    )

    assert summary == {"files_seen": 1, "files_skipped": 0, "files_materialized": 1}
    assert ingested == [(2, 3, None, 88)]
