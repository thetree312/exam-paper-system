from __future__ import annotations

from types import SimpleNamespace
from typing import Any


class _FakeRow:
    def __init__(self, mapping: dict[str, Any]) -> None:
        self._mapping = mapping


class _FakeConn:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = [_FakeRow(row) for row in rows]

    def __enter__(self) -> "_FakeConn":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        return False

    def execute(self, _sql: Any, _params: dict[str, Any]) -> list[_FakeRow]:
        return self._rows


class _FakeEngine:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows

    def connect(self) -> _FakeConn:
        return _FakeConn(self._rows)


def test_search_chunks_keeps_image_lane_when_text_hits_dominate(monkeypatch: Any) -> None:
    from app.services.kb.rag_service import RAGService

    svc = RAGService()
    monkeypatch.setattr(svc, "_embedding", SimpleNamespace(model="fake-embedding", embed=lambda _q: [[0.1, 0.2]]))

    fake_rows: list[dict[str, Any]] = []
    for idx in range(8):
        fake_rows.append(
            {
                "chunk_id": 100 + idx,
                "distance": 0.10 + idx * 0.01,
                "chunk_type": "fulltext",
                "content": f"text hit {idx}",
                "content_hash": f"text-{idx}",
                "metadata_json": {"modality": "text"},
                "file_id": 1054,
                "document_id": None,
                "page_start": idx + 1,
                "page_end": idx + 1,
                "source_id": 700,
                "source_type": "kb",
                "title": "paper.pdf",
                "file_preview_path": None,
                "file_storage_path": None,
            }
        )
    fake_rows.append(
        {
            "chunk_id": 999,
            "distance": 0.50,
            "chunk_type": "page_image",
            "content": "[image page 2]",
            "content_hash": "image-2",
            "metadata_json": {"modality": "image", "asset_rel_path": "uploads/2/paper.page2.png"},
            "file_id": 1054,
            "document_id": None,
            "page_start": 2,
            "page_end": 2,
            "source_id": 700,
            "source_type": "kb",
            "title": "paper.pdf",
            "file_preview_path": None,
            "file_storage_path": None,
        }
    )
    monkeypatch.setattr(svc, "_engine", _FakeEngine(fake_rows))

    rows = svc.search_chunks(
        tenant_id=2,
        user_id=2,
        workroom_id=12,
        query_text="第六题 图例 视风风速 坐标",
        limit=8,
        source_file_ids=[1054],
        top_text_k=7,
        top_image_k=1,
    )

    assert len(rows) == 8
    assert any(str(item.get("chunk_type") or "") == "page_image" for item in rows)


def test_search_chunks_prefers_images_from_text_supported_pages(monkeypatch: Any) -> None:
    from app.services.kb.rag_service import RAGService

    svc = RAGService()
    monkeypatch.setattr(svc, "_embedding", SimpleNamespace(model="fake-embedding", embed=lambda _q: [[0.1, 0.2]]))

    fake_rows = [
        {
            "chunk_id": 101,
            "distance": 0.10,
            "chunk_type": "fulltext",
            "content": "relevant text on page 3",
            "content_hash": "text-101",
            "metadata_json": {"modality": "text"},
            "file_id": 1056,
            "document_id": None,
            "page_start": 3,
            "page_end": 3,
            "source_id": 700,
            "source_type": "kb",
            "title": "paper-a.pdf",
            "file_preview_path": "uploads/2/paper-a.page1.png",
            "file_storage_path": "uploads/2/paper-a.pdf",
        },
        {
            "chunk_id": 201,
            "distance": 0.11,
            "chunk_type": "page_image",
            "content": "[image page 9]",
            "content_hash": "image-201",
            "metadata_json": {"modality": "image", "asset_rel_path": "uploads/2/paper-b.page9.png"},
            "file_id": 2055,
            "document_id": None,
            "page_start": 9,
            "page_end": 9,
            "source_id": 701,
            "source_type": "kb",
            "title": "paper-b.pdf",
            "file_preview_path": "uploads/2/paper-b.page1.png",
            "file_storage_path": "uploads/2/paper-b.pdf",
        },
        {
            "chunk_id": 202,
            "distance": 0.12,
            "chunk_type": "page_image",
            "content": "[image page 3]",
            "content_hash": "image-202",
            "metadata_json": {"modality": "image", "asset_rel_path": "uploads/2/paper-a.page3.png"},
            "file_id": 1056,
            "document_id": None,
            "page_start": 3,
            "page_end": 3,
            "source_id": 700,
            "source_type": "kb",
            "title": "paper-a.pdf",
            "file_preview_path": "uploads/2/paper-a.page1.png",
            "file_storage_path": "uploads/2/paper-a.pdf",
        },
    ]
    monkeypatch.setattr(svc, "_engine", _FakeEngine(fake_rows))

    rows = svc.search_chunks(
        tenant_id=2,
        user_id=2,
        workroom_id=12,
        query_text="第六题图例视风风速的坐标",
        limit=2,
        source_file_ids=[1056, 2055],
        top_text_k=1,
        top_image_k=1,
    )

    assert len(rows) == 2
    assert rows[0]["chunk_type"] == "fulltext"
    assert rows[1]["chunk_id"] == 202


def test_search_page_bundles_groups_text_and_image_on_same_page(monkeypatch: Any) -> None:
    from app.services.kb.rag_service import RAGService

    svc = RAGService()
    monkeypatch.setattr(svc, "_embedding", SimpleNamespace(model="fake-embedding", embed=lambda _q: [[0.1, 0.2]]))

    fake_rows = [
        {
            "chunk_id": 101,
            "distance": 0.10,
            "chunk_type": "fulltext",
            "content": "relevant text on page 3",
            "content_hash": "text-101",
            "metadata_json": {"modality": "text"},
            "file_id": 1056,
            "document_id": None,
            "page_start": 3,
            "page_end": 3,
            "source_id": 700,
            "source_type": "kb",
            "title": "paper-a.pdf",
            "file_preview_path": "uploads/2/paper-a.page1.png",
            "file_storage_path": "uploads/2/paper-a.pdf",
        },
        {
            "chunk_id": 102,
            "distance": 0.12,
            "chunk_type": "fulltext",
            "content": "more text on page 3",
            "content_hash": "text-102",
            "metadata_json": {"modality": "text"},
            "file_id": 1056,
            "document_id": None,
            "page_start": 3,
            "page_end": 3,
            "source_id": 700,
            "source_type": "kb",
            "title": "paper-a.pdf",
            "file_preview_path": "uploads/2/paper-a.page1.png",
            "file_storage_path": "uploads/2/paper-a.pdf",
        },
        {
            "chunk_id": 202,
            "distance": 0.13,
            "chunk_type": "page_image",
            "content": "[image page 3]",
            "content_hash": "image-202",
            "metadata_json": {"modality": "image", "asset_rel_path": "uploads/2/paper-a.page3.png"},
            "file_id": 1056,
            "document_id": None,
            "page_start": 3,
            "page_end": 3,
            "source_id": 700,
            "source_type": "kb",
            "title": "paper-a.pdf",
            "file_preview_path": "uploads/2/paper-a.page1.png",
            "file_storage_path": "uploads/2/paper-a.pdf",
        },
        {
            "chunk_id": 301,
            "distance": 0.11,
            "chunk_type": "page_image",
            "content": "[image page 8]",
            "content_hash": "image-301",
            "metadata_json": {"modality": "image", "asset_rel_path": "uploads/2/paper-b.page8.png"},
            "file_id": 2055,
            "document_id": None,
            "page_start": 8,
            "page_end": 8,
            "source_id": 701,
            "source_type": "kb",
            "title": "paper-b.pdf",
            "file_preview_path": "uploads/2/paper-b.page1.png",
            "file_storage_path": "uploads/2/paper-b.pdf",
        },
    ]
    monkeypatch.setattr(svc, "_engine", _FakeEngine(fake_rows))

    bundles = svc.search_page_bundles(
        tenant_id=2,
        user_id=2,
        workroom_id=12,
        query_text="第六题 图例 视风风速 坐标",
        limit=2,
        source_file_ids=[1056, 2055],
    )

    assert len(bundles) == 2
    assert bundles[0]["file_id"] == 1056
    assert bundles[0]["page_no"] == 3
    assert [item["chunk_id"] for item in bundles[0]["text_chunks"]] == [101, 102]
    assert bundles[0]["primary_image"]["chunk_id"] == 202
    assert bundles[0]["source_refs"] == ["chunk:101", "chunk:102", "chunk:202"]
