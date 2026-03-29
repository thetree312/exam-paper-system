from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class KBChunkRow:
    chunk_type: str
    modality: str
    page_no: int | None
    block_index: int | None
    content: str
    embed_input: str | dict[str, str]
    token_count: int
    content_hash: str
    metadata_json: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class KBPageBundle:
    source_id: int | None
    file_id: int | None
    page_no: int | None
    text_chunks: list[dict[str, Any]] = field(default_factory=list)
    primary_image: dict[str, Any] | None = None
    preview_image_path: str | None = None
    source_refs: list[str] = field(default_factory=list)


@dataclass(slots=True)
class KBUnitRow:
    unit_key: str
    unit_type: str
    page_no_start: int | None
    page_no_end: int | None
    title: str | None
    text_content: str | None
    primary_image_path: str | None
    token_count: int
    metadata_json: dict[str, Any] = field(default_factory=dict)
    content_hash: str = ""


@dataclass(slots=True)
class KBSemanticGroupRow:
    group_key: str
    group_type: str
    page_no_start: int | None
    page_no_end: int | None
    title: str | None
    text_content: str | None
    primary_image_path: str | None
    token_count: int
    metadata_json: dict[str, Any] = field(default_factory=dict)
    content_hash: str = ""


@dataclass(slots=True)
class KBSemanticGroupMemberRow:
    group_key: str
    chunk_content_hash: str
    member_role: str
    member_order: int
