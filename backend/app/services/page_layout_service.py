from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import httpx
from PIL import Image

from ..config import get_settings
from .assets import AssetResolver


class _LayoutTransport(Protocol):
    def parse_layout(self, *, model: str, file: str) -> dict[str, Any]: ...


class HttpxLayoutTransport:
    def __init__(self, *, base_url: str | None = None, api_key: str | None = None) -> None:
        settings = get_settings()
        self._base_url = str(base_url or settings.zhipu_layout_url).strip()
        self._api_key = api_key or settings.zhipu_api_key

    def parse_layout(self, *, model: str, file: str) -> dict[str, Any]:
        if not self._api_key:
            raise RuntimeError("ZHIPU_API_KEY is not configured")
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": model,
            "file": file,
            "need_layout_visualization": False,
        }
        with httpx.Client(timeout=120.0) as client:
            response = client.post(self._base_url, headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()
        if isinstance(data, dict) and data.get("code") not in (None, 0, 200):
            raise RuntimeError(f"GLM layout parsing failed: {data}")
        return data


@dataclass(slots=True)
class PageLayoutResult:
    asset_ref: str
    transport_kind: str
    raw_payload: dict[str, Any]
    blocks: list[dict[str, Any]]


class PageLayoutService:
    def __init__(
        self,
        *,
        asset_resolver: AssetResolver | None = None,
        transport: _LayoutTransport | None = None,
        model: str | None = None,
    ) -> None:
        settings = get_settings()
        self._asset_resolver = asset_resolver or AssetResolver()
        self._transport = transport or HttpxLayoutTransport()
        self._model = str(model or settings.zhipu_model_glm_ocr).strip() or "glm-ocr"

    def parse_page(self, *, asset_ref: str, page_no: int) -> PageLayoutResult:
        transport_value = self._asset_resolver.resolve_for_model(asset_ref)
        payload = self._transport.parse_layout(model=self._model, file=transport_value)
        transport_kind = self._infer_transport_kind(transport_value)

        page_blocks = []
        layout_details = payload.get("layout_details") or []
        if layout_details:
            page_blocks = list(layout_details[0] or [])
        page_meta = {}
        pages = ((payload.get("data_info") or {}).get("pages") or [])
        if pages:
            page_meta = dict(pages[0] or {})

        width = self._as_float(page_meta.get("width"))
        height = self._as_float(page_meta.get("height"))
        blocks = [
            self.normalize_block(
                page_no=page_no,
                block_index=index,
                block=block,
                width=width,
                height=height,
                source_asset_ref=asset_ref,
            )
            for index, block in enumerate(page_blocks)
        ]
        self._persist_crop_assets(source_asset_ref=asset_ref, blocks=blocks)

        return PageLayoutResult(
            asset_ref=asset_ref,
            transport_kind=transport_kind,
            raw_payload=payload,
            blocks=blocks,
        )

    def normalize_block(
        self,
        *,
        page_no: int,
        block_index: int,
        block: dict[str, Any],
        width: float | None,
        height: float | None,
        source_asset_ref: str,
    ) -> dict[str, Any]:
        block_label = str(block.get("label") or "text").strip().lower()
        bbox_abs, bbox_norm = self._normalize_bbox(
            raw_bbox=block.get("bbox_2d"),
            width=width,
            height=height,
        )
        return {
            "layout_unit_key": f"page:{page_no}/block:{block_index}",
            "parent_unit_key": f"page:{page_no}",
            "relation_type": "same_page",
            "block_label": block_label,
            "bbox_abs": bbox_abs,
            "bbox_norm": bbox_norm,
            "content": str(block.get("content") or ""),
            "crop_asset_ref": self.build_block_asset_ref(
                source_asset_ref=source_asset_ref,
                block_index=block_index,
                block_label=block_label,
            ),
        }

    def build_block_asset_ref(
        self,
        *,
        source_asset_ref: str,
        block_index: int,
        block_label: str,
    ) -> str:
        normalized = str(source_asset_ref or "").replace("\\", "/").strip()
        if not normalized:
            raise ValueError("source_asset_ref is empty")
        if "/" in normalized:
            folder, filename = normalized.rsplit("/", 1)
        else:
            folder, filename = "", normalized
        stem = filename.rsplit(".", 1)[0]
        target = f"{stem}.blocks/block{block_index:04d}.{block_label}.png"
        return f"{folder}/{target}" if folder else target

    def _persist_crop_assets(
        self,
        *,
        source_asset_ref: str,
        blocks: list[dict[str, Any]],
    ) -> None:
        if not hasattr(self._asset_resolver, "resolve_for_storage"):
            return
        source_path = self._asset_resolver.resolve_for_storage(source_asset_ref)
        with Image.open(source_path) as base_image:
            image = base_image.convert("RGB")
            for block in blocks:
                crop_asset_ref = str(block.get("crop_asset_ref") or "").strip()
                bbox_abs = block.get("bbox_abs") if isinstance(block.get("bbox_abs"), dict) else None
                if not crop_asset_ref or not bbox_abs:
                    continue
                crop_box = self._clamp_crop_box(image=image, bbox_abs=bbox_abs)
                if crop_box is None:
                    continue
                target_path = self._asset_resolver._backend_root / Path(crop_asset_ref)
                target_path.parent.mkdir(parents=True, exist_ok=True)
                cropped = image.crop(crop_box)
                cropped.save(target_path, format="PNG")

    @staticmethod
    def _infer_transport_kind(value: str) -> str:
        if value.startswith("data:image/"):
            return "data_url"
        if value.startswith(("http://", "https://")):
            return "http_url"
        return "local_ref"

    @staticmethod
    def _normalize_bbox(
        *,
        raw_bbox: Any,
        width: float | None,
        height: float | None,
    ) -> tuple[dict[str, int] | None, dict[str, float] | None]:
        if not isinstance(raw_bbox, list) or len(raw_bbox) < 4:
            return None, None
        x1, y1, x2, y2 = [float(raw_bbox[i]) for i in range(4)]
        if width and height and max(abs(x1), abs(x2), abs(y1), abs(y2)) <= 1.0:
            bbox_norm = {"x1": x1, "y1": y1, "x2": x2, "y2": y2}
            bbox_abs = {
                "x1": int(round(x1 * width)),
                "y1": int(round(y1 * height)),
                "x2": int(round(x2 * width)),
                "y2": int(round(y2 * height)),
            }
            return bbox_abs, bbox_norm
        bbox_abs = {
            "x1": int(round(x1)),
            "y1": int(round(y1)),
            "x2": int(round(x2)),
            "y2": int(round(y2)),
        }
        if width and height and width > 0 and height > 0:
            bbox_norm = {
                "x1": bbox_abs["x1"] / width,
                "y1": bbox_abs["y1"] / height,
                "x2": bbox_abs["x2"] / width,
                "y2": bbox_abs["y2"] / height,
            }
        else:
            bbox_norm = None
        return bbox_abs, bbox_norm

    @staticmethod
    def _as_float(value: Any) -> float | None:
        if value is None:
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _clamp_crop_box(
        *,
        image: Image.Image,
        bbox_abs: dict[str, Any],
    ) -> tuple[int, int, int, int] | None:
        width, height = image.size
        x1 = max(0, min(width, int(bbox_abs.get("x1") or 0)))
        y1 = max(0, min(height, int(bbox_abs.get("y1") or 0)))
        x2 = max(0, min(width, int(bbox_abs.get("x2") or 0)))
        y2 = max(0, min(height, int(bbox_abs.get("y2") or 0)))
        if x2 <= x1 or y2 <= y1:
            return None
        return (x1, y1, x2, y2)
