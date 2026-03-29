from __future__ import annotations

from types import SimpleNamespace
from typing import Any


def test_ingest_file_does_not_embed_page_preview_images(monkeypatch: Any) -> None:
    from app.services.kb.ingest_service import KBIngestService

    file_obj = SimpleNamespace(
        id=88,
        source_type="pdf",
        original_name="paper.pdf",
        mime_type="application/pdf",
        content_hash="abc123",
    )
    extracted = {
        "blocks": [SimpleNamespace(page_num=1, content="relevant paragraph" * 40)],
        "pages": [{"page_no": 1, "preview_image_path": "uploads/2/paper.page1.png", "preview_text": "relevant"}],
    }
    layout_blocks = [
        {
            "page_no": 1,
            "layout_unit_key": "page:1/block:0",
            "parent_unit_key": "page:1",
            "relation_type": "same_page",
            "block_label": "image",
            "content": "diagram",
            "crop_asset_ref": "uploads/2/paper.page1.blocks/block0000.image.png",
        }
    ]

    repo_calls: dict[str, Any] = {}

    class _FakeRepo:
        def __init__(self, _db: Any) -> None:
            return None

        def get_file(self, file_id: int) -> Any:
            assert file_id == 88
            return file_obj

        def upsert_source(self, **kwargs: Any) -> dict[str, Any]:
            return {"id": 7, "tenant_id": kwargs["tenant_id"], "user_id": kwargs["user_id"]}

        def create_ingest_job(self, **kwargs: Any) -> int:
            return 19

        def replace_source_pages(self, **kwargs: Any) -> None:
            return None

        def replace_source_chunks_and_embeddings(self, **kwargs: Any) -> None:
            repo_calls["chunk_rows"] = kwargs["chunk_rows"]

        def replace_source_units_and_embeddings(self, **kwargs: Any) -> None:
            repo_calls["unit_rows"] = kwargs["unit_rows"]
            repo_calls["image_vectors"] = kwargs["image_vectors"]

        def mark_source_status(self, **kwargs: Any) -> None:
            return None

        def finish_ingest_job(self, **kwargs: Any) -> None:
            return None

        def sync_binding_source_ids(self, **kwargs: Any) -> None:
            return None

    class _FakeEmbedding:
        model_name = "fake-embedding"

        def embed_rows(self, rows: list[Any]) -> list[list[float]]:
            return [[float(idx + 1), 0.5] for idx, _row in enumerate(rows)]

    class _FakeDB:
        def commit(self) -> None:
            return None

        def rollback(self) -> None:
            return None

    monkeypatch.setattr("app.services.kb.ingest_service.KBRepository", _FakeRepo)
    monkeypatch.setattr("app.services.kb.ingest_service.KBEmbeddingService", lambda: _FakeEmbedding())

    svc = KBIngestService(_FakeDB())  # type: ignore[arg-type]
    svc._extractors = {"pdf": SimpleNamespace(extract=lambda _file: extracted)}  # type: ignore[attr-defined]
    monkeypatch.setattr(svc, "_load_layout_blocks", lambda *, tenant_id, file, pages: layout_blocks)

    result = svc.ingest_file(tenant_id=2, user_id=3, workroom_id=4, file_id=88)

    assert result["chunk_count"] == 2
    assert [row.chunk_type for row in repo_calls["chunk_rows"]] == ["fulltext", "layout_image"]
    assert [row.unit_type for row in repo_calls["unit_rows"]] == ["page", "layout_image"]
    assert len(repo_calls["image_vectors"]) == 1


def test_search_units_prefers_layout_units_before_page_units(monkeypatch: Any) -> None:
    from app.services.kb.rag_service import RAGService

    svc = RAGService()
    fake_rows = [
        {
            "unit_id": 901,
            "unit_key": "page:2",
            "unit_type": "page",
            "page_no_start": 2,
            "page_no_end": 2,
            "title": "paper.pdf",
            "text_content": "whole page summary",
            "primary_image_path": "uploads/2/paper.page2.png",
            "metadata_json": {"layout_unit_key": "page:2"},
            "embed_kind": "text",
            "distance": 0.05,
            "source_id": 44,
            "file_id": 1077,
            "document_id": None,
            "source_type": "article",
        },
        {
            "unit_id": 902,
            "unit_key": "page:2/block:1",
            "unit_type": "layout_text",
            "page_no_start": 2,
            "page_no_end": 2,
            "title": "paper.pdf",
            "text_content": "specific figure caption",
            "primary_image_path": None,
            "metadata_json": {"layout_unit_key": "page:2/block:1", "parent_unit_key": "page:2"},
            "embed_kind": "text",
            "distance": 0.08,
            "source_id": 44,
            "file_id": 1077,
            "document_id": None,
            "source_type": "article",
        },
    ]
    monkeypatch.setattr(
        svc,
        "_fetch_unit_candidates",
        lambda **kwargs: fake_rows,
    )

    rows = svc.search_units(
        tenant_id=2,
        user_id=2,
        workroom_id=30,
        query_text="第六题 图例 视风风速 坐标",
        limit=1,
        source_file_ids=[1077],
    )

    assert len(rows) == 1
    assert rows[0]["unit_id"] == 902
