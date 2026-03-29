from __future__ import annotations

from types import SimpleNamespace
from typing import Any


def test_ingest_file_writes_pages_chunks_and_embeddings(monkeypatch: Any) -> None:
    from app.services.kb.chunk_builders import (
        build_layout_chunk_rows,
        build_layout_unit_rows,
        build_semantic_group_rows,
        build_text_chunk_rows,
    )
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
            "block_label": "text",
            "bbox_norm": {"x1": 0.1, "y1": 0.2, "x2": 0.4, "y2": 0.3},
            "bbox_abs": {"x1": 100, "y1": 200, "x2": 400, "y2": 300},
            "content": "layout stem",
            "crop_asset_ref": "uploads/2/paper.page1.blocks/block0000.text.png",
        }
    ]

    repo_calls: dict[str, Any] = {}

    class _FakeRepo:
        def __init__(self, _db: Any) -> None:
            pass

        def get_file(self, file_id: int) -> Any:
            assert file_id == 88
            return file_obj

        def upsert_source(self, **kwargs: Any) -> dict[str, Any]:
            repo_calls["upsert_source"] = kwargs
            return {"id": 7, "tenant_id": kwargs["tenant_id"], "user_id": kwargs["user_id"]}

        def create_ingest_job(self, **kwargs: Any) -> int:
            repo_calls["create_ingest_job"] = kwargs
            return 19

        def replace_source_pages(self, **kwargs: Any) -> None:
            repo_calls["replace_source_pages"] = kwargs

        def replace_source_chunks_and_embeddings(self, **kwargs: Any) -> None:
            repo_calls["replace_source_chunks_and_embeddings"] = kwargs

        def replace_source_units_and_embeddings(self, **kwargs: Any) -> None:
            repo_calls["replace_source_units_and_embeddings"] = kwargs

        def replace_source_semantic_groups_and_embeddings(self, **kwargs: Any) -> None:
            repo_calls["replace_source_semantic_groups_and_embeddings"] = kwargs

        def mark_source_status(self, **kwargs: Any) -> None:
            repo_calls.setdefault("mark_source_status", []).append(kwargs)

        def finish_ingest_job(self, **kwargs: Any) -> None:
            repo_calls["finish_ingest_job"] = kwargs

        def sync_binding_source_ids(self, **kwargs: Any) -> None:
            repo_calls["sync_binding_source_ids"] = kwargs

    class _FakeEmbedding:
        model_name = "fake-embedding"

        def embed_rows(self, rows: list[Any]) -> list[list[float]]:
            return [[float(idx + 1), 0.5] for idx, _row in enumerate(rows)]

    class _FakeDB:
        def commit(self) -> None:
            repo_calls["committed"] = True

        def rollback(self) -> None:
            repo_calls["rolled_back"] = True

    monkeypatch.setattr("app.services.kb.ingest_service.KBRepository", _FakeRepo)
    monkeypatch.setattr("app.services.kb.ingest_service.KBEmbeddingService", lambda: _FakeEmbedding())

    svc = KBIngestService(_FakeDB())  # type: ignore[arg-type]
    svc._extractors = {"pdf": SimpleNamespace(extract=lambda _file: extracted)}  # type: ignore[attr-defined]
    monkeypatch.setattr(
        svc,
        "_load_layout_blocks",
        lambda *, tenant_id, file, pages: layout_blocks,
    )
    result = svc.ingest_file(tenant_id=2, user_id=3, workroom_id=4, file_id=88)

    chunk_rows = repo_calls["replace_source_chunks_and_embeddings"]["chunk_rows"]
    expected_chunk_count = len(build_text_chunk_rows(extracted["blocks"])) + len(build_layout_chunk_rows(layout_blocks))
    expected_group_rows, expected_memberships = build_semantic_group_rows(chunk_rows, title="paper.pdf")
    assert result == {
        "source_id": 7,
        "page_count": 1,
        "chunk_count": expected_chunk_count,
        "unit_count": 2,
        "semantic_group_count": len(expected_group_rows),
    }
    assert len(chunk_rows) == expected_chunk_count
    unit_rows = repo_calls["replace_source_units_and_embeddings"]["unit_rows"]
    assert len(unit_rows) == 2
    assert [row.unit_type for row in unit_rows] == ["page", "layout_text"]
    assert unit_rows[1].metadata_json["parent_unit_key"] == "page:1"
    assert unit_rows[1].primary_image_path == "uploads/2/paper.page1.blocks/block0000.text.png"
    assert len(repo_calls["replace_source_units_and_embeddings"]["image_vectors"]) == 1
    semantic_group_call = repo_calls["replace_source_semantic_groups_and_embeddings"]
    assert len(semantic_group_call["group_rows"]) == len(expected_group_rows)
    assert len(semantic_group_call["memberships"]) == len(expected_memberships)
    assert semantic_group_call["group_rows"][0].group_type == "text_flow"
    assert repo_calls["sync_binding_source_ids"]["source_id"] == 7
    assert repo_calls["finish_ingest_job"]["status"] == "completed"
    assert repo_calls["committed"] is True
