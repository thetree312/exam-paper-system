from __future__ import annotations

from typing import Any


def normalize_bbox_norm(value: Any) -> dict[str, float] | None:
    if not isinstance(value, dict):
        return None
    if {"x", "y", "w", "h"}.issubset(value.keys()):
        try:
            return {
                "x": float(value["x"]),
                "y": float(value["y"]),
                "w": float(value["w"]),
                "h": float(value["h"]),
            }
        except (TypeError, ValueError):
            return None
    if {"x1", "y1", "x2", "y2"}.issubset(value.keys()):
        try:
            x1 = float(value["x1"])
            y1 = float(value["y1"])
            x2 = float(value["x2"])
            y2 = float(value["y2"])
        except (TypeError, ValueError):
            return None
        return {
            "x": round(x1, 6),
            "y": round(y1, 6),
            "w": round(max(0.0, x2 - x1), 6),
            "h": round(max(0.0, y2 - y1), 6),
        }
    return None


def _safe_int(value: Any) -> int | None:
    try:
        if value is None:
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def _anchor_type_from_unit(unit: dict[str, Any]) -> str:
    unit_type = str(unit.get("unit_type") or "").strip().lower()
    unit_key = str(unit.get("unit_key") or "").strip().lower()
    if unit_type.startswith("layout_") or "/block:" in unit_key:
        return "layout_block"
    if unit_type == "page":
        return "page"
    return "unit"


def build_citation_anchor_from_unit(
    unit: dict[str, Any],
    *,
    citation_id: str,
    citation_index: int,
    source_ref: str,
) -> dict[str, Any]:
    metadata = unit.get("metadata_json") if isinstance(unit.get("metadata_json"), dict) else {}
    file_id = _safe_int(unit.get("file_id")) or 0
    page_no = _safe_int(unit.get("page_no_start")) or _safe_int(unit.get("page_no_end")) or 1
    asset_ref = str(
        metadata.get("asset_ref")
        or metadata.get("asset_rel_path")
        or unit.get("primary_image_path")
        or ""
    ).strip() or None
    return {
        "citation_id": str(citation_id or "").strip(),
        "citation_index": int(citation_index),
        "source_ref": str(source_ref or "").strip(),
        "anchor_type": _anchor_type_from_unit(unit),
        "file_id": file_id,
        "page_no": page_no,
        "unit_key": str(unit.get("unit_key") or "").strip() or None,
        "chunk_id": None,
        "chunk_type": str(unit.get("unit_type") or "").strip() or None,
        "title": str(unit.get("title") or "").strip() or None,
        "excerpt": str(unit.get("text_content") or "").strip() or None,
        "asset_kind": str(metadata.get("asset_kind") or "").strip() or None,
        "asset_ref": asset_ref,
        "preview_url": f"/api/files/preview/{file_id}?page={page_no}" if file_id > 0 else None,
        "bbox_norm": normalize_bbox_norm(metadata.get("bbox_norm")),
        "bbox_abs": metadata.get("bbox_abs") if isinstance(metadata.get("bbox_abs"), dict) else None,
    }


def build_citation_anchor_from_chunk(
    chunk: dict[str, Any],
    *,
    citation_id: str,
    citation_index: int,
    source_ref: str,
) -> dict[str, Any]:
    metadata = chunk.get("metadata_json") if isinstance(chunk.get("metadata_json"), dict) else {}
    file_id = _safe_int(chunk.get("file_id")) or 0
    page_no = _safe_int(metadata.get("page_no")) or _safe_int(chunk.get("page_no")) or _safe_int(chunk.get("page_start")) or 1
    return {
        "citation_id": str(citation_id or "").strip(),
        "citation_index": int(citation_index),
        "source_ref": str(source_ref or "").strip(),
        "anchor_type": "layout_block" if str(chunk.get("chunk_type") or "").startswith("layout_") else "chunk",
        "file_id": file_id,
        "page_no": page_no,
        "unit_key": str(metadata.get("layout_unit_key") or metadata.get("unit_key") or "").strip() or None,
        "chunk_id": _safe_int(chunk.get("chunk_id")) or _safe_int(chunk.get("id")),
        "chunk_type": str(chunk.get("chunk_type") or "").strip() or None,
        "title": str(chunk.get("title") or "").strip() or None,
        "excerpt": str(chunk.get("content") or "").strip() or None,
        "asset_kind": str(metadata.get("asset_kind") or "").strip() or None,
        "asset_ref": str(metadata.get("asset_ref") or metadata.get("asset_rel_path") or "").strip() or None,
        "preview_url": f"/api/files/preview/{file_id}?page={page_no}" if file_id > 0 else None,
        "bbox_norm": normalize_bbox_norm(metadata.get("bbox_norm")),
        "bbox_abs": metadata.get("bbox_abs") if isinstance(metadata.get("bbox_abs"), dict) else None,
    }


def dedupe_citation_anchors(anchors: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    seen: set[tuple[Any, ...]] = set()
    out: list[dict[str, Any]] = []
    for item in anchors or []:
        if not isinstance(item, dict):
            continue
        key = (
            str(item.get("source_ref") or "").strip(),
            _safe_int(item.get("file_id")),
            _safe_int(item.get("page_no")),
            str(item.get("unit_key") or "").strip(),
            _safe_int(item.get("chunk_id")),
            str(item.get("asset_ref") or "").strip(),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


__all__ = [
    "build_citation_anchor_from_chunk",
    "build_citation_anchor_from_unit",
    "dedupe_citation_anchors",
    "normalize_bbox_norm",
]
