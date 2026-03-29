from __future__ import annotations

from typing import Any

from PIL import Image


class _FakeResolver:
    def __init__(self, value: str) -> None:
        self.value = value
        self.seen: list[str] = []

    def resolve_for_model(self, asset_ref: str) -> str:
        self.seen.append(asset_ref)
        return self.value


class _FakeTransport:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload
        self.calls: list[dict[str, str]] = []

    def parse_layout(self, *, model: str, file: str) -> dict[str, Any]:
        self.calls.append({"model": model, "file": file})
        return self.payload


def test_page_layout_service_parses_page_image_asset_ref_and_normalizes_blocks() -> None:
    from app.services.page_layout_service import PageLayoutService

    resolver = _FakeResolver("data:image/jpeg;base64,abc123")
    transport = _FakeTransport(
        {
            "layout_details": [
                [
                    {
                        "label": "image",
                        "bbox_2d": [0.1, 0.2, 0.6, 0.5],
                        "content": "chart",
                    }
                ]
            ],
            "data_info": {"pages": [{"width": 1000, "height": 2000}]},
        }
    )
    service = PageLayoutService(asset_resolver=resolver, transport=transport, model="glm-ocr")

    result = service.parse_page(asset_ref="uploads/2/paper.page1.glm.jpg", page_no=1)

    assert resolver.seen == ["uploads/2/paper.page1.glm.jpg"]
    assert transport.calls == [{"model": "glm-ocr", "file": "data:image/jpeg;base64,abc123"}]
    assert result.transport_kind == "data_url"
    assert len(result.blocks) == 1
    assert result.blocks[0]["layout_unit_key"] == "page:1/block:0"
    assert result.blocks[0]["parent_unit_key"] == "page:1"
    assert result.blocks[0]["block_label"] == "image"
    assert result.blocks[0]["bbox_abs"] == {"x1": 100, "y1": 400, "x2": 600, "y2": 1000}
    assert result.blocks[0]["bbox_norm"] == {"x1": 0.1, "y1": 0.2, "x2": 0.6, "y2": 0.5}
    assert result.blocks[0]["crop_asset_ref"].endswith("paper.page1.glm.blocks/block0000.image.png")


def test_page_layout_service_preserves_http_transport_without_storage_rewrite() -> None:
    from app.services.page_layout_service import PageLayoutService

    resolver = _FakeResolver("https://cdn.example.com/uploads/2/paper.page2.jpg")
    transport = _FakeTransport({"layout_details": [[]], "data_info": {"pages": [{"width": 800, "height": 1200}]}})
    service = PageLayoutService(asset_resolver=resolver, transport=transport, model="glm-ocr")

    result = service.parse_page(asset_ref="uploads/2/paper.page2.jpg", page_no=2)

    assert result.transport_kind == "http_url"
    assert transport.calls == [
        {"model": "glm-ocr", "file": "https://cdn.example.com/uploads/2/paper.page2.jpg"}
    ]


def test_page_layout_service_persists_crop_asset_refs_to_disk(tmp_path) -> None:
    from app.services.assets import AssetResolver
    from app.services.page_layout_service import PageLayoutService

    uploads_dir = tmp_path / "uploads" / "2"
    uploads_dir.mkdir(parents=True, exist_ok=True)
    source_path = uploads_dir / "paper.page1.png"
    Image.new("RGB", (1000, 2000), color="white").save(source_path)

    transport = _FakeTransport(
        {
            "layout_details": [
                [
                    {
                        "label": "image",
                        "bbox_2d": [0.1, 0.2, 0.6, 0.5],
                        "content": "chart",
                    }
                ]
            ],
            "data_info": {"pages": [{"width": 1000, "height": 2000}]},
        }
    )
    resolver = AssetResolver(backend_root=tmp_path, transport_mode="base64")
    service = PageLayoutService(asset_resolver=resolver, transport=transport, model="glm-ocr")

    result = service.parse_page(asset_ref="uploads/2/paper.page1.png", page_no=1)

    crop_rel = result.blocks[0]["crop_asset_ref"]
    crop_path = tmp_path / crop_rel
    assert crop_path.exists()
    with Image.open(crop_path) as cropped:
        assert cropped.size == (500, 600)
