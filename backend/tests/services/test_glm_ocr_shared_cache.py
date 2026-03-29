from __future__ import annotations

import json
from types import SimpleNamespace

import pytest


@pytest.mark.anyio
async def test_call_layout_parsing_reuses_completed_page_layout_cache(monkeypatch) -> None:
    from app.glm_ocr import service as glm_service_module
    from app.glm_ocr.service import GlmOcrService

    file_obj = SimpleNamespace(id=88, content_hash="abc123", preview_path="uploads/2/paper.page1.png")
    document_obj = SimpleNamespace(
        id=501,
        ocr_md_cache=None,
        ocr_layout_cache=None,
        ocr_cache_generated_at=None,
        ocr_cache_model=None,
    )
    upsert_calls: list[dict] = []

    class _FakeLegacyCacheManager:
        def __init__(self, _db) -> None:
            return None

        def get_latest(self, **_kwargs):
            return None

        def upsert(self, **kwargs):
            upsert_calls.append(kwargs)
            return SimpleNamespace(id=701)

    class _FakePageCacheManager:
        def __init__(self, _db) -> None:
            return None

        def get_completed(self, **kwargs):
            page_no = int(kwargs["page_no"])
            return SimpleNamespace(
                id=900 + page_no,
                page_no=page_no,
                blocks_json=json.dumps(
                    [
                        {
                            "page_no": page_no,
                            "layout_unit_key": f"page:{page_no}/block:0",
                            "block_label": "text",
                            "content": f"page {page_no} text",
                            "bbox_abs": {"x1": 1, "y1": 2, "x2": 3, "y2": 4},
                            "bbox_norm": {"x1": 0.1, "y1": 0.2, "x2": 0.3, "y2": 0.4},
                        }
                    ],
                    ensure_ascii=False,
                ),
                transport_kind="data_url",
            )

        def try_acquire(self, **_kwargs):
            raise AssertionError("should not try to acquire when completed cache exists")

        def mark_completed(self, **_kwargs):
            raise AssertionError("should not mark completed when completed cache exists")

    monkeypatch.setattr(glm_service_module, "FileOcrCacheManager", _FakeLegacyCacheManager)
    monkeypatch.setattr(glm_service_module, "FilePageLayoutCacheManager", _FakePageCacheManager)

    service = GlmOcrService()
    monkeypatch.setattr(service, "_discover_page_asset_refs", lambda file: [(1, "uploads/2/paper.page1.png"), (2, "uploads/2/paper.page2.png")])
    monkeypatch.setattr(service, "_load_page_dimensions_from_asset_ref", lambda asset_ref: {"width": 1000, "height": 2000})

    result, cache_entry = await service.call_layout_parsing(
        db=SimpleNamespace(add=lambda _item: None, flush=lambda: None),
        file=file_obj,
        tenant_id=2,
        document=document_obj,
        force_refresh=False,
    )

    assert cache_entry.id == 701
    assert len(result["layout_details"]) == 2
    assert result["layout_details"][0][0]["content"] == "page 1 text"
    assert result["layout_details"][1][0]["content"] == "page 2 text"
    assert "page 1 text" in (result.get("md_results") or "")
    assert upsert_calls[0]["content_hash"] == "abc123"


@pytest.mark.anyio
async def test_call_layout_parsing_parses_missing_page_and_populates_shared_cache(monkeypatch) -> None:
    from app.glm_ocr import service as glm_service_module
    from app.glm_ocr.service import GlmOcrService

    file_obj = SimpleNamespace(id=88, content_hash="abc123", preview_path="uploads/2/paper.page1.png")
    completed_marks: list[int] = []

    class _FakeLegacyCacheManager:
        def __init__(self, _db) -> None:
            return None

        def get_latest(self, **_kwargs):
            return None

        def upsert(self, **kwargs):
            return SimpleNamespace(id=702, payload=kwargs["layout_payload"])

    class _FakePageCacheManager:
        def __init__(self, _db) -> None:
            return None

        def get_completed(self, **kwargs):
            if int(kwargs["page_no"]) == 1:
                return SimpleNamespace(
                    id=901,
                    page_no=1,
                    blocks_json=json.dumps([{"page_no": 1, "layout_unit_key": "page:1/block:0", "block_label": "text", "content": "cached page"}], ensure_ascii=False),
                    transport_kind="data_url",
                )
            return None

        def try_acquire(self, **kwargs):
            return SimpleNamespace(id=902, page_no=int(kwargs["page_no"]))

        def mark_completed(self, *, entry, layout_json, blocks_json, transport_kind):
            completed_marks.append(int(entry.page_no))
            entry.blocks_json = blocks_json
            entry.transport_kind = transport_kind
            return entry

    class _FakePageLayoutService:
        def __init__(self, **_kwargs) -> None:
            return None

        def parse_page(self, *, asset_ref, page_no):
            return SimpleNamespace(
                raw_payload={"asset_ref": asset_ref, "page_no": page_no},
                blocks=[{"page_no": page_no, "layout_unit_key": f"page:{page_no}/block:0", "block_label": "text", "content": f"parsed page {page_no}"}],
                transport_kind="data_url",
            )

    class _FakeLimiter:
        def acquire(self, *, owner: str):
            return SimpleNamespace(key=owner)

        def release(self, *, lease, owner: str):
            return None

    monkeypatch.setattr(glm_service_module, "FileOcrCacheManager", _FakeLegacyCacheManager)
    monkeypatch.setattr(glm_service_module, "FilePageLayoutCacheManager", _FakePageCacheManager)
    monkeypatch.setattr(glm_service_module, "PageLayoutService", _FakePageLayoutService)
    monkeypatch.setattr(glm_service_module, "GlmConcurrencyLimiter", lambda **_kwargs: _FakeLimiter())

    service = GlmOcrService()
    monkeypatch.setattr(service, "_discover_page_asset_refs", lambda file: [(1, "uploads/2/paper.page1.png"), (2, "uploads/2/paper.page2.png")])
    monkeypatch.setattr(service, "_load_page_dimensions_from_asset_ref", lambda asset_ref: {"width": 800, "height": 1200})

    result, cache_entry = await service.call_layout_parsing(
        db=SimpleNamespace(add=lambda _item: None, flush=lambda: None),
        file=file_obj,
        tenant_id=2,
        document=None,
        force_refresh=False,
    )

    assert cache_entry.id == 702
    assert completed_marks == [2]
    assert result["layout_details"][0][0]["content"] == "cached page"
    assert result["layout_details"][1][0]["content"] == "parsed page 2"
