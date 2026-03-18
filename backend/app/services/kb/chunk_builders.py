from __future__ import annotations

import hashlib
from typing import Any, Iterable

from .types import KBChunkRow


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
