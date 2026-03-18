from __future__ import annotations

from typing import Any

from sqlalchemy import text

from ...db import engine
from ..qwen_client import QwenEmbeddingClient


def _row_to_dict(row: Any) -> dict[str, Any]:
    mapping = getattr(row, "_mapping", None)
    if mapping is not None:
        return dict(mapping)
    if isinstance(row, dict):
        return dict(row)
    raise TypeError(f"Unsupported row type: {type(row)!r}")


def _vector_literal(vector: list[float]) -> str:
    return "[" + ",".join(f"{value:.8f}" for value in vector) + "]"


def _query_suggests_visual_need(query_text: str) -> bool:
    lowered = str(query_text or "").lower()
    visual_terms = (
        "图",
        "图表",
        "图像",
        "曲线",
        "坐标",
        "示意",
        "截图",
        "第",
        "page",
        "image",
        "diagram",
        "graph",
        "figure",
        "chart",
    )
    return any(term in lowered for term in visual_terms)


class RAGService:
    def __init__(self) -> None:
        self._engine = engine
        self._embedding = QwenEmbeddingClient()

    def _embed_query(self, query_text: str) -> list[float]:
        vectors = self._embedding.embed([query_text])
        return vectors[0] if vectors else []

    def _fetch_candidates(
        self,
        *,
        tenant_id: int,
        user_id: int,
        workroom_id: int | None,
        query_text: str,
        source_file_ids: list[int] | None,
        fetch_limit: int,
    ) -> list[dict[str, Any]]:
        query_vector = self._embed_query(query_text)
        if not query_vector:
            return []
        sql = text(
            """
            SELECT
                c.id AS chunk_id,
                (e.embedding <=> CAST(:query_embedding AS vector))::float AS distance,
                c.chunk_type,
                c.content,
                c.content_hash,
                c.metadata_json,
                s.file_id,
                s.document_id,
                c.page_no AS page_start,
                c.page_no AS page_end,
                s.id AS source_id,
                s.source_kind AS source_type,
                s.title,
                f.preview_path AS file_preview_path,
                f.storage_path AS file_storage_path
            FROM kb_chunk_embeddings AS e
            JOIN kb_chunks AS c ON c.id = e.chunk_id
            JOIN kb_sources AS s ON s.id = c.source_id
            LEFT JOIN files AS f ON f.id = s.file_id
            WHERE s.tenant_id = :tenant_id
              AND s.user_id = :user_id
              AND e.tenant_id = :tenant_id
              AND e.user_id = :user_id
              AND (:workroom_id IS NULL OR s.workroom_id IS NULL OR s.workroom_id = :workroom_id)
              AND (:source_file_ids_empty OR s.file_id = ANY(:source_file_ids))
            ORDER BY e.embedding <=> CAST(:query_embedding AS vector), c.id DESC
            LIMIT :fetch_limit
            """
        )
        params = {
            "tenant_id": tenant_id,
            "user_id": user_id,
            "workroom_id": workroom_id,
            "source_file_ids": list(source_file_ids or []),
            "source_file_ids_empty": not bool(source_file_ids),
            "fetch_limit": fetch_limit,
            "query_embedding": _vector_literal(query_vector),
        }
        with self._engine.connect() as conn:
            rows = conn.execute(sql, params)
            return [_row_to_dict(row) for row in rows]

    def search_chunks(
        self,
        *,
        tenant_id: int,
        user_id: int,
        workroom_id: int | None,
        query_text: str,
        limit: int = 8,
        source_file_ids: list[int] | None = None,
        top_text_k: int | None = None,
        top_image_k: int | None = None,
    ) -> list[dict[str, Any]]:
        rows = self._fetch_candidates(
            tenant_id=tenant_id,
            user_id=user_id,
            workroom_id=workroom_id,
            query_text=query_text,
            source_file_ids=source_file_ids,
            fetch_limit=max(limit * 4, 20),
        )
        text_rows = [row for row in rows if str(row.get("chunk_type") or "") != "page_image"]
        image_rows = [row for row in rows if str(row.get("chunk_type") or "") == "page_image"]

        text_limit = top_text_k if top_text_k is not None else limit
        image_limit = top_image_k if top_image_k is not None else max(1, limit // 3)

        selected_text = text_rows[: max(0, text_limit)]

        preferred_pages = {
            (row.get("file_id"), row.get("page_start"))
            for row in selected_text
            if row.get("file_id") is not None and row.get("page_start") is not None
        }
        supported_images = [
            row for row in image_rows if (row.get("file_id"), row.get("page_start")) in preferred_pages
        ]
        fallback_images = [row for row in image_rows if row not in supported_images]

        chosen_images: list[dict[str, Any]] = []
        if _query_suggests_visual_need(query_text):
            chosen_images.extend(supported_images[: max(0, image_limit)])
        else:
            chosen_images.extend(supported_images[: max(0, min(image_limit, 1))])
        if len(chosen_images) < max(0, image_limit):
            chosen_images.extend(fallback_images[: max(0, image_limit - len(chosen_images))])

        combined = selected_text + chosen_images
        combined.sort(key=lambda item: float(item.get("distance") or 0.0))
        return combined[:limit]

    def search_page_bundles(
        self,
        *,
        tenant_id: int,
        user_id: int,
        workroom_id: int | None,
        query_text: str,
        limit: int = 5,
        source_file_ids: list[int] | None = None,
    ) -> list[dict[str, Any]]:
        rows = self.search_chunks(
            tenant_id=tenant_id,
            user_id=user_id,
            workroom_id=workroom_id,
            query_text=query_text,
            limit=max(limit * 4, 8),
            source_file_ids=source_file_ids,
            top_text_k=max(limit * 2, 4),
            top_image_k=max(limit * 2, 2),
        )

        grouped: dict[tuple[Any, Any], dict[str, Any]] = {}
        for row in rows:
            key = (row.get("file_id"), row.get("page_start"))
            bundle = grouped.setdefault(
                key,
                {
                    "source_id": row.get("source_id"),
                    "file_id": row.get("file_id"),
                    "page_no": row.get("page_start"),
                    "text_chunks": [],
                    "primary_image": None,
                    "preview_image_path": None,
                    "source_refs": [],
                    "_score": float(row.get("distance") or 0.0),
                },
            )
            bundle["_score"] = min(bundle["_score"], float(row.get("distance") or 0.0))
            bundle["source_refs"].append(f"chunk:{row.get('chunk_id')}")
            if row.get("chunk_type") == "page_image":
                if bundle["primary_image"] is None:
                    bundle["primary_image"] = row
                    metadata = row.get("metadata_json") or {}
                    if isinstance(metadata, dict):
                        bundle["preview_image_path"] = metadata.get("asset_rel_path")
            else:
                bundle["text_chunks"].append(row)

        ordered = sorted(grouped.values(), key=lambda item: item["_score"])
        result: list[dict[str, Any]] = []
        for item in ordered[:limit]:
            item.pop("_score", None)
            result.append(item)
        return result

    def get_chunks_by_ids(
        self,
        *,
        tenant_id: int,
        user_id: int,
        chunk_ids: list[int],
    ) -> list[dict[str, Any]]:
        normalized_ids = [int(chunk_id) for chunk_id in chunk_ids if int(chunk_id) > 0]
        if not normalized_ids:
            return []
        sql = text(
            """
            SELECT
                c.id AS chunk_id,
                0.0::float AS distance,
                c.chunk_type,
                c.content,
                c.content_hash,
                c.metadata_json,
                s.file_id,
                s.document_id,
                c.page_no AS page_start,
                c.page_no AS page_end,
                s.id AS source_id,
                s.source_kind AS source_type,
                s.title,
                f.preview_path AS file_preview_path,
                f.storage_path AS file_storage_path
            FROM kb_chunks AS c
            JOIN kb_sources AS s ON s.id = c.source_id
            LEFT JOIN files AS f ON f.id = s.file_id
            WHERE c.id = ANY(:chunk_ids)
              AND s.tenant_id = :tenant_id
              AND s.user_id = :user_id
            ORDER BY array_position(CAST(:chunk_ids AS bigint[]), c.id)
            """
        )
        params = {
            "chunk_ids": normalized_ids,
            "tenant_id": tenant_id,
            "user_id": user_id,
        }
        with self._engine.connect() as conn:
            rows = conn.execute(sql, params)
            return [_row_to_dict(row) for row in rows]
