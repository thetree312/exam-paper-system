from __future__ import annotations

import hashlib
from collections.abc import Mapping
from typing import Any, Iterable

from .types import KBChunkRow, KBSemanticGroupMemberRow, KBSemanticGroupRow, KBUnitRow


def _estimate_tokens(text: str) -> int:
    stripped = str(text or "").strip()
    if not stripped:
        return 0
    return max(1, len(stripped) // 4)


def _hash_payload(*parts: Any) -> str:
    joined = "\x1f".join(str(part or "") for part in parts)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()


def _split_text(text: str, *, chunk_chars: int, overlap_chars: int) -> list[str]:
    value = str(text or "").strip()
    if not value:
        return []
    if chunk_chars <= 0:
        return [value]
    overlap_chars = max(0, min(overlap_chars, max(chunk_chars - 1, 0)))
    if len(value) <= chunk_chars:
        return [value]

    chunks: list[str] = []
    start = 0
    step = max(1, chunk_chars - overlap_chars)
    while start < len(value):
        end = start + chunk_chars
        piece = value[start:end].strip()
        if piece:
            chunks.append(piece)
        if end >= len(value):
            break
        start += step
    return chunks


def build_text_chunk_rows(
    blocks: Iterable[Any],
    *,
    chunk_chars: int = 1000,
    overlap_chars: int = 120,
) -> list[KBChunkRow]:
    rows: list[KBChunkRow] = []
    for raw_block in blocks:
        page_no = getattr(raw_block, "page_num", None)
        content = str(getattr(raw_block, "content", "") or "").strip()
        if not content:
            continue
        for local_idx, chunk in enumerate(
            _split_text(content, chunk_chars=chunk_chars, overlap_chars=overlap_chars)
        ):
            rows.append(
                KBChunkRow(
                    chunk_type="fulltext",
                    modality="text",
                    page_no=int(page_no) if page_no is not None else None,
                    block_index=local_idx,
                    content=chunk,
                    embed_input=chunk,
                    token_count=_estimate_tokens(chunk),
                    content_hash=_hash_payload("fulltext", page_no, local_idx, chunk),
                    metadata_json={"modality": "text"},
                )
            )
    return rows


def build_page_image_chunk_rows(
    pages: Iterable[dict[str, Any]],
) -> list[KBChunkRow]:
    rows: list[KBChunkRow] = []
    for page in pages:
        page_no = page.get("page_no")
        rel_path = str(page.get("preview_image_path") or "").strip()
        if not rel_path:
            continue
        content = f"[image page {page_no}]"
        rows.append(
            KBChunkRow(
                chunk_type="page_image",
                modality="image",
                page_no=int(page_no) if page_no is not None else None,
                block_index=None,
                content=content,
                embed_input={"image": rel_path},
                token_count=1,
                content_hash=_hash_payload("page_image", page_no, rel_path),
                metadata_json={"modality": "image", "asset_rel_path": rel_path},
            )
        )
    return rows


def build_page_unit_rows(
    blocks: Iterable[Any],
    pages: Iterable[dict[str, Any]],
    *,
    title: str | None = None,
) -> list[KBUnitRow]:
    text_by_page: dict[int, list[str]] = {}
    for block in blocks:
        page_no_raw = getattr(block, "page_num", None)
        content = str(getattr(block, "content", "") or "").strip()
        if not content:
            continue
        page_no = int(page_no_raw or 1)
        if page_no <= 0:
            page_no = 1
        text_by_page.setdefault(page_no, []).append(content)

    pages_by_no: dict[int, dict[str, Any]] = {}
    for page in pages:
        page_no = int(page.get("page_no") or 1)
        if page_no <= 0:
            page_no = 1
        pages_by_no[page_no] = dict(page)

    all_page_nos = sorted(set(text_by_page.keys()) | set(pages_by_no.keys()))
    if not all_page_nos:
        return []

    unit_rows: list[KBUnitRow] = []
    for page_no in all_page_nos:
        page = pages_by_no.get(page_no) or {}
        text_content = "\n".join(text_by_page.get(page_no) or []).strip() or None
        primary_image_path = str(page.get("preview_image_path") or "").strip() or None
        preview_text = str(page.get("preview_text") or "").strip() or None
        merged_text = text_content or preview_text
        token_count = _estimate_tokens(merged_text or "")
        content_hash = _hash_payload("unit", page_no, merged_text, primary_image_path, title)
        unit_rows.append(
            KBUnitRow(
                unit_key=f"page:{page_no}",
                unit_type="page",
                page_no_start=page_no,
                page_no_end=page_no,
                title=title,
                text_content=merged_text,
                primary_image_path=primary_image_path,
                token_count=max(1, token_count) if (merged_text or primary_image_path) else 0,
                metadata_json={"page_no": page_no, "unit_type": "page"},
                content_hash=content_hash,
            )
        )
    return unit_rows


def build_layout_chunk_rows(
    layout_blocks: Iterable[dict[str, Any]],
) -> list[KBChunkRow]:
    rows: list[KBChunkRow] = []
    for index, block in enumerate(layout_blocks):
        page_no = int(block.get("page_no") or 1)
        block_label = str(block.get("block_label") or "text").strip().lower()
        layout_unit_key = str(block.get("layout_unit_key") or f"page:{page_no}/block:{index}")
        parent_unit_key = str(block.get("parent_unit_key") or f"page:{page_no}")
        relation_type = str(block.get("relation_type") or "same_page")
        asset_ref = str(block.get("crop_asset_ref") or "").strip() or None
        bbox_norm = block.get("bbox_norm") if isinstance(block.get("bbox_norm"), Mapping) else None
        bbox_abs = block.get("bbox_abs") if isinstance(block.get("bbox_abs"), Mapping) else None
        metadata = {
            "modality": "image" if block_label == "image" else "text",
            "asset_ref": asset_ref,
            "layout_unit_key": layout_unit_key,
            "parent_unit_key": parent_unit_key,
            "relation_type": relation_type,
            "block_label": block_label,
            "bbox_norm": bbox_norm,
            "bbox_abs": bbox_abs,
        }
        chunk_type = f"layout_{block_label}"
        if block_label == "image":
            if not asset_ref:
                continue
            content = str(block.get("content") or "").strip() or f"[layout image page {page_no}]"
            embed_input: str | dict[str, str] = {"image": asset_ref}
            token_count = 1
        else:
            content = str(block.get("content") or "").strip()
            if not content:
                continue
            embed_input = content
            token_count = _estimate_tokens(content)

        rows.append(
            KBChunkRow(
                chunk_type=chunk_type,
                modality="image" if block_label == "image" else "text",
                page_no=page_no,
                block_index=index,
                content=content,
                embed_input=embed_input,
                token_count=max(1, token_count),
                content_hash=_hash_payload("layout_chunk", page_no, layout_unit_key, block_label, content, asset_ref),
                metadata_json=metadata,
            )
        )
    return rows


def build_layout_unit_rows(
    layout_blocks: Iterable[dict[str, Any]],
    *,
    title: str | None = None,
) -> list[KBUnitRow]:
    rows: list[KBUnitRow] = []
    for index, block in enumerate(layout_blocks):
        page_no = int(block.get("page_no") or 1)
        block_label = str(block.get("block_label") or "text").strip().lower()
        unit_key = str(block.get("layout_unit_key") or f"page:{page_no}/block:{index}")
        parent_unit_key = str(block.get("parent_unit_key") or f"page:{page_no}")
        relation_type = str(block.get("relation_type") or "same_page")
        asset_ref = str(block.get("crop_asset_ref") or "").strip() or None
        bbox_norm = block.get("bbox_norm") if isinstance(block.get("bbox_norm"), Mapping) else None
        bbox_abs = block.get("bbox_abs") if isinstance(block.get("bbox_abs"), Mapping) else None
        text_content = None
        primary_image_path = asset_ref
        if block_label == "image":
            if not asset_ref:
                continue
            token_count = 1
        else:
            text_content = str(block.get("content") or "").strip() or None
            if not text_content:
                continue
            token_count = _estimate_tokens(text_content)

        metadata = {
            "page_no": page_no,
            "unit_type": f"layout_{block_label}",
            "layout_unit_key": unit_key,
            "parent_unit_key": parent_unit_key,
            "relation_type": relation_type,
            "block_label": block_label,
            "asset_ref": asset_ref,
            "bbox_norm": bbox_norm,
            "bbox_abs": bbox_abs,
        }
        rows.append(
            KBUnitRow(
                unit_key=unit_key,
                unit_type=f"layout_{block_label}",
                page_no_start=page_no,
                page_no_end=page_no,
                title=title,
                text_content=text_content,
                primary_image_path=primary_image_path,
                token_count=max(1, token_count),
                metadata_json=metadata,
                content_hash=_hash_payload("layout_unit", page_no, unit_key, block_label, text_content, primary_image_path, title),
            )
        )
    return rows


def _bbox_metric(metadata: dict[str, Any], key: str, default: float) -> float:
    bbox = metadata.get("bbox_norm") if isinstance(metadata.get("bbox_norm"), Mapping) else None
    if not isinstance(bbox, Mapping):
        return default
    try:
        if key in bbox:
            return float(bbox.get(key) or default)
        if key == "x1":
            return float(bbox.get("x") or default)
        if key == "y1":
            return float(bbox.get("y") or default)
        if key == "x2":
            return float((bbox.get("x") or 0.0) + (bbox.get("w") or 0.0))
        if key == "y2":
            return float((bbox.get("y") or 0.0) + (bbox.get("h") or 0.0))
    except (TypeError, ValueError):
        return default
    return default


def _is_textual_chunk(row: KBChunkRow) -> bool:
    return row.modality == "text"


def _is_image_chunk(row: KBChunkRow) -> bool:
    return row.modality == "image"


def _boilerplate_band(row: KBChunkRow) -> str | None:
    metadata = row.metadata_json if isinstance(row.metadata_json, dict) else {}
    y1 = _bbox_metric(metadata, "y1", 1.0)
    y2 = _bbox_metric(metadata, "y2", 1.0)
    if y2 <= 0.10:
        return "header"
    if y1 >= 0.90:
        return "footer"
    return None


def _boilerplate_signature(row: KBChunkRow) -> tuple[str, str, float, float, float, float] | None:
    band = _boilerplate_band(row)
    if band is None:
        return None
    metadata = row.metadata_json if isinstance(row.metadata_json, dict) else {}
    return (
        band,
        str(row.chunk_type or "").strip().lower(),
        round(_bbox_metric(metadata, "x1", 0.0), 2),
        round(_bbox_metric(metadata, "x2", 1.0), 2),
        round(_bbox_metric(metadata, "y1", 0.0), 2),
        round(_bbox_metric(metadata, "y2", 1.0), 2),
    )


def filter_boilerplate_chunk_rows_for_kb(chunk_rows: Iterable[KBChunkRow]) -> list[KBChunkRow]:
    rows = list(chunk_rows)
    page_nos = {int(row.page_no or 0) for row in rows if int(row.page_no or 0) > 0}
    if len(page_nos) < 3:
        return rows

    signature_pages: dict[tuple[str, str, float, float, float, float], set[int]] = {}
    for row in rows:
        signature = _boilerplate_signature(row)
        page_no = int(row.page_no or 0)
        if signature is None or page_no <= 0:
            continue
        signature_pages.setdefault(signature, set()).add(page_no)

    min_repeat_pages = max(3, len(page_nos) // 2)
    boilerplate_signatures = {
        signature
        for signature, pages in signature_pages.items()
        if len(pages) >= min_repeat_pages
    }
    if not boilerplate_signatures:
        return rows

    return [row for row in rows if _boilerplate_signature(row) not in boilerplate_signatures]


def _extract_asset_ref(row: KBChunkRow) -> str | None:
    metadata = row.metadata_json if isinstance(row.metadata_json, dict) else {}
    value = str(metadata.get("asset_ref") or metadata.get("asset_rel_path") or "").strip()
    return value or None


def _should_merge_group(current_rows: list[KBChunkRow], candidate: KBChunkRow) -> bool:
    if not current_rows:
        return False
    last = current_rows[-1]
    if (last.page_no or 0) <= 0 or (candidate.page_no or 0) <= 0:
        return False

    last_meta = last.metadata_json if isinstance(last.metadata_json, dict) else {}
    candidate_meta = candidate.metadata_json if isinstance(candidate.metadata_json, dict) else {}
    last_page = int(last.page_no or 0)
    candidate_page = int(candidate.page_no or 0)

    last_x1 = _bbox_metric(last_meta, "x1", 0.0)
    last_x2 = _bbox_metric(last_meta, "x2", 1.0)
    last_y1 = _bbox_metric(last_meta, "y1", 0.0)
    last_y2 = _bbox_metric(last_meta, "y2", 1.0)
    cand_x1 = _bbox_metric(candidate_meta, "x1", 0.0)
    cand_x2 = _bbox_metric(candidate_meta, "x2", 1.0)
    cand_y1 = _bbox_metric(candidate_meta, "y1", 0.0)
    cand_y2 = _bbox_metric(candidate_meta, "y2", 1.0)

    overlap = max(0.0, min(last_x2, cand_x2) - max(last_x1, cand_x1))
    width = max(0.01, min(last_x2 - last_x1, cand_x2 - cand_x1))
    horizontal_alignment = overlap / width

    if candidate_page == last_page:
        vertical_gap = max(0.0, cand_y1 - last_y2)
        if _is_textual_chunk(last) and _is_textual_chunk(candidate):
            return vertical_gap <= 0.12 and horizontal_alignment >= 0.35
        if _is_image_chunk(last) or _is_image_chunk(candidate):
            return vertical_gap <= 0.18 and horizontal_alignment >= 0.20
        return False

    if candidate_page == last_page + 1 and _is_textual_chunk(last) and _is_textual_chunk(candidate):
        return last_y2 >= 0.78 and cand_y1 <= 0.18 and horizontal_alignment >= 0.35
    return False


def _semantic_group_type(rows: list[KBChunkRow]) -> str:
    has_image = any(_is_image_chunk(row) for row in rows)
    has_table = any(str(row.chunk_type or "").strip().lower() == "layout_table" for row in rows)
    has_text = any(_is_textual_chunk(row) for row in rows)
    if has_image and has_text:
        return "mixed_region"
    if has_image:
        return "figure_bundle"
    if has_table and not has_text:
        return "table_bundle"
    return "text_flow"


def build_semantic_group_rows(
    chunk_rows: Iterable[KBChunkRow],
    *,
    title: str | None = None,
) -> tuple[list[KBSemanticGroupRow], list[KBSemanticGroupMemberRow]]:
    non_page_rows = [
        row
        for row in chunk_rows
        if str(row.chunk_type or "").strip().lower() != "page_image"
    ]
    layout_rows = [
        row
        for row in non_page_rows
        if str(row.chunk_type or "").strip().lower().startswith("layout_")
    ]
    # Semantic groups should be assembled from layout-level atoms when available.
    # Mixing full-document OCR chunks into this pass collapses unrelated regions
    # into a few giant groups and destroys structural retrieval quality.
    candidate_rows = layout_rows if layout_rows else non_page_rows
    if not candidate_rows:
        return [], []

    def _sort_key(row: KBChunkRow) -> tuple[int, float, float, int]:
        metadata = row.metadata_json if isinstance(row.metadata_json, dict) else {}
        return (
            int(row.page_no or 0),
            _bbox_metric(metadata, "y1", 0.0),
            _bbox_metric(metadata, "x1", 0.0),
            int(row.block_index or 0),
        )

    ordered_rows = sorted(candidate_rows, key=_sort_key)
    grouped_rows: list[list[KBChunkRow]] = []
    current: list[KBChunkRow] = []
    for row in ordered_rows:
        if not current:
            current = [row]
            continue
        if _should_merge_group(current, row):
            current.append(row)
            continue
        grouped_rows.append(current)
        current = [row]
    if current:
        grouped_rows.append(current)

    groups: list[KBSemanticGroupRow] = []
    memberships: list[KBSemanticGroupMemberRow] = []
    for group_index, rows in enumerate(grouped_rows):
        page_no_start = min(int(row.page_no or 0) for row in rows) or None
        page_no_end = max(int(row.page_no or 0) for row in rows) or None
        text_parts = [
            str(row.content or "").strip()
            for row in rows
            if _is_textual_chunk(row) and str(row.content or "").strip()
        ]
        text_content = "\n".join(text_parts).strip() or None
        primary_image_path = next(
            (_extract_asset_ref(row) for row in rows if _is_image_chunk(row) and _extract_asset_ref(row)),
            None,
        )
        group_type = _semantic_group_type(rows)
        group_key = f"group:{page_no_start or 0}:{group_index}"
        token_count = _estimate_tokens(text_content or "")
        if token_count <= 0 and primary_image_path:
            token_count = 1
        metadata_json = {
            "group_type": group_type,
            "member_count": len(rows),
            "page_nos": sorted({int(row.page_no or 0) for row in rows if int(row.page_no or 0) > 0}),
            "dominant_modality": "mixed" if primary_image_path and text_content else ("image" if primary_image_path else "text"),
            "member_chunk_types": [str(row.chunk_type or "").strip() for row in rows],
            "layout_unit_keys": [
                str((row.metadata_json or {}).get("layout_unit_key") or "").strip()
                for row in rows
                if isinstance(row.metadata_json, dict)
            ],
        }
        groups.append(
            KBSemanticGroupRow(
                group_key=group_key,
                group_type=group_type,
                page_no_start=page_no_start,
                page_no_end=page_no_end,
                title=title,
                text_content=text_content,
                primary_image_path=primary_image_path,
                token_count=token_count,
                metadata_json=metadata_json,
                content_hash=_hash_payload(
                    "semantic_group",
                    group_key,
                    group_type,
                    page_no_start,
                    page_no_end,
                    text_content,
                    primary_image_path,
                    title,
                ),
            )
        )
        for member_index, row in enumerate(rows):
            member_role = "figure" if _is_image_chunk(row) else "body"
            if str(row.chunk_type or "").strip().lower() == "layout_table":
                member_role = "table"
            memberships.append(
                KBSemanticGroupMemberRow(
                    group_key=group_key,
                    chunk_content_hash=row.content_hash,
                    member_role=member_role,
                    member_order=member_index,
                )
            )
    return groups, memberships
