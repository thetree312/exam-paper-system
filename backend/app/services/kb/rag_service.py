from __future__ import annotations

import json
from typing import Any

from sqlalchemy import text

from ...db import engine
from ..qwen_client import QwenEmbeddingClient

_DEFAULT_IMAGE_SLOTS = 1
_MAX_DEFAULT_IMAGE_SLOTS = 2


def _row_to_dict(row: Any) -> dict[str, Any]:
    mapping = getattr(row, "_mapping", None)
    if mapping is not None:
        return dict(mapping)
    if isinstance(row, dict):
        return dict(row)
    raise TypeError(f"Unsupported row type: {type(row)!r}")


def _row_modality(row: dict[str, Any]) -> str:
    metadata = row.get("metadata_json") if isinstance(row.get("metadata_json"), dict) else {}
    modality = str(metadata.get("modality") or "").strip().lower()
    chunk_type = str(row.get("chunk_type") or "").strip().lower()
    if modality:
        return "image" if modality == "image" else "text"
    return "image" if "image" in chunk_type else "text"


def _vector_literal(vector: list[float]) -> str:
    return "[" + ",".join(f"{value:.8f}" for value in vector) + "]"


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


class RAGService:
    def __init__(self) -> None:
        self._engine = engine
        self._embedding: QwenEmbeddingClient | None = None

    def _get_embedding_client(self) -> QwenEmbeddingClient:
        if self._embedding is None:
            self._embedding = QwenEmbeddingClient()
        return self._embedding

    def _embed_query(self, query_text: str) -> list[float]:
        vectors = self._get_embedding_client().embed([query_text])
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
        chunk_type_filter: str | None = None,
    ) -> list[dict[str, Any]]:
        query_vector = self._embed_query(query_text)
        if not query_vector:
            return []

        chunk_type_sql = ""
        if chunk_type_filter == "page_image":
            chunk_type_sql = " AND c.chunk_type = 'page_image' "
        elif chunk_type_filter == "non_image":
            chunk_type_sql = " AND c.chunk_type <> 'page_image' "

        sql = text(
            f"""
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
              {chunk_type_sql}
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
            items = [_row_to_dict(row) for row in rows]
        if chunk_type_filter == "page_image":
            return [
                row
                for row in items
                if _row_modality(row) == "image"
            ]
        if chunk_type_filter == "non_image":
            return [
                row
                for row in items
                if _row_modality(row) != "image"
            ]
        return items

    def _fetch_unit_candidates(
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
                u.id AS unit_id,
                u.unit_key,
                u.unit_type,
                u.page_no_start,
                u.page_no_end,
                u.title,
                u.text_content,
                u.primary_image_path,
                u.metadata_json,
                e.embed_kind,
                (e.embedding <=> CAST(:query_embedding AS vector))::float AS distance,
                s.id AS source_id,
                s.file_id,
                s.document_id,
                s.source_kind AS source_type
            FROM kb_unit_embeddings AS e
            JOIN kb_units AS u ON u.id = e.unit_id
            JOIN kb_sources AS s ON s.id = u.source_id
            WHERE s.tenant_id = :tenant_id
              AND s.user_id = :user_id
              AND e.tenant_id = :tenant_id
              AND e.user_id = :user_id
              AND (:workroom_id IS NULL OR s.workroom_id IS NULL OR s.workroom_id = :workroom_id)
              AND (:source_file_ids_empty OR s.file_id = ANY(:source_file_ids))
            ORDER BY e.embedding <=> CAST(:query_embedding AS vector), u.id DESC
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

    def _fetch_semantic_group_candidates(
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
                g.id AS group_id,
                g.group_key,
                g.group_type,
                g.page_no_start,
                g.page_no_end,
                g.title,
                g.text_content,
                g.primary_image_path,
                g.metadata_json,
                e.embed_kind,
                (e.embedding <=> CAST(:query_embedding AS vector))::float AS distance,
                s.id AS source_id,
                s.file_id,
                s.document_id,
                s.source_kind AS source_type
            FROM kb_semantic_group_embeddings AS e
            JOIN kb_semantic_groups AS g ON g.id = e.group_id
            JOIN kb_sources AS s ON s.id = g.source_id
            WHERE s.tenant_id = :tenant_id
              AND s.user_id = :user_id
              AND e.tenant_id = :tenant_id
              AND e.user_id = :user_id
              AND (:workroom_id IS NULL OR s.workroom_id IS NULL OR s.workroom_id = :workroom_id)
              AND (:source_file_ids_empty OR s.file_id = ANY(:source_file_ids))
            ORDER BY e.embedding <=> CAST(:query_embedding AS vector), g.id DESC
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

    def _fetch_semantic_group_members(
        self,
        *,
        tenant_id: int,
        user_id: int,
        group_ids: list[int],
    ) -> list[dict[str, Any]]:
        normalized_ids = [int(group_id) for group_id in group_ids if int(group_id) > 0]
        if not normalized_ids:
            return []
        sql = text(
            """
            SELECT
                gm.group_id,
                gm.member_role,
                gm.member_order,
                c.id AS chunk_id,
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
                s.title
            FROM kb_semantic_group_members AS gm
            JOIN kb_chunks AS c ON c.id = gm.chunk_id
            JOIN kb_semantic_groups AS g ON g.id = gm.group_id
            JOIN kb_sources AS s ON s.id = g.source_id
            WHERE gm.group_id = ANY(:group_ids)
              AND s.tenant_id = :tenant_id
              AND s.user_id = :user_id
            ORDER BY array_position(CAST(:group_ids AS bigint[]), gm.group_id), gm.member_order ASC, c.id ASC
            """
        )
        params = {"group_ids": normalized_ids, "tenant_id": tenant_id, "user_id": user_id}
        with self._engine.connect() as conn:
            rows = conn.execute(sql, params)
            return [_row_to_dict(row) for row in rows]

    def _fetch_page_images_for_pages(
        self,
        *,
        tenant_id: int,
        user_id: int,
        workroom_id: int | None,
        source_file_ids: list[int] | None,
        page_pairs: list[tuple[int, int]],
    ) -> list[dict[str, Any]]:
        normalized_pairs = [
            {"file_id": int(file_id), "page_no": int(page_no)}
            for file_id, page_no in page_pairs
            if int(file_id) > 0 and int(page_no) > 0
        ]
        if not normalized_pairs:
            return []

        sql = text(
            """
            WITH target_pages AS (
                SELECT
                    CAST(item->>'file_id' AS bigint) AS file_id,
                    CAST(item->>'page_no' AS integer) AS page_no
                FROM jsonb_array_elements(CAST(:page_pairs AS jsonb)) AS item
            )
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
            JOIN target_pages AS tp
              ON tp.file_id = s.file_id
             AND tp.page_no = c.page_no
            WHERE c.chunk_type = 'page_image'
              AND s.tenant_id = :tenant_id
              AND s.user_id = :user_id
              AND (:workroom_id IS NULL OR s.workroom_id IS NULL OR s.workroom_id = :workroom_id)
              AND (:source_file_ids_empty OR s.file_id = ANY(:source_file_ids))
            ORDER BY c.id DESC
            """
        )
        params = {
            "page_pairs": json.dumps(normalized_pairs, ensure_ascii=False),
            "tenant_id": tenant_id,
            "user_id": user_id,
            "workroom_id": workroom_id,
            "source_file_ids": list(source_file_ids or []),
            "source_file_ids_empty": not bool(source_file_ids),
        }
        with self._engine.connect() as conn:
            rows = conn.execute(sql, params)
            return [
                item
                for item in (_row_to_dict(row) for row in rows)
                if str(item.get("chunk_type") or "") == "page_image"
            ]

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
        if limit <= 0:
            return []

        text_rows = self._fetch_candidates(
            tenant_id=tenant_id,
            user_id=user_id,
            workroom_id=workroom_id,
            query_text=query_text,
            source_file_ids=source_file_ids,
            fetch_limit=max(limit * 4, 20),
            chunk_type_filter="non_image",
        )
        image_rows = self._fetch_candidates(
            tenant_id=tenant_id,
            user_id=user_id,
            workroom_id=workroom_id,
            query_text=query_text,
            source_file_ids=source_file_ids,
            fetch_limit=max(limit * 6, 24),
            chunk_type_filter="page_image",
        )

        text_limit = max(0, top_text_k if top_text_k is not None else limit)
        if top_image_k is not None:
            image_limit = max(0, top_image_k)
        else:
            image_limit = 0
            if limit >= 2:
                image_limit = min(_DEFAULT_IMAGE_SLOTS, _MAX_DEFAULT_IMAGE_SLOTS, limit - 1)

        selected_text = text_rows[:text_limit]
        preferred_pages = {
            (int(row.get("file_id")), int(row.get("page_start")))
            for row in selected_text
            if row.get("file_id") is not None and row.get("page_start") is not None
        }

        page_linked_images = self._fetch_page_images_for_pages(
            tenant_id=tenant_id,
            user_id=user_id,
            workroom_id=workroom_id,
            source_file_ids=source_file_ids,
            page_pairs=list(preferred_pages),
        )

        image_by_chunk: dict[int, dict[str, Any]] = {}
        for row in page_linked_images:
            chunk_id = int(row.get("chunk_id") or 0)
            if chunk_id > 0:
                image_by_chunk[chunk_id] = row
        for row in image_rows:
            chunk_id = int(row.get("chunk_id") or 0)
            if chunk_id > 0:
                image_by_chunk.setdefault(chunk_id, row)

        merged_images = list(image_by_chunk.values())
        supported_images = [
            row
            for row in merged_images
            if row.get("file_id") is not None
            and row.get("page_start") is not None
            and (int(row.get("file_id")), int(row.get("page_start"))) in preferred_pages
        ]
        fallback_images = [row for row in merged_images if row not in supported_images]

        chosen_images = supported_images[:image_limit]
        if len(chosen_images) < image_limit:
            chosen_images.extend(fallback_images[: max(0, image_limit - len(chosen_images))])

        # Keep image slots reserved; do not drop image evidence by distance post-truncation.
        image_budget = min(limit, len(chosen_images))
        text_budget = max(0, limit - image_budget)
        selected_text = selected_text[:text_budget]
        if len(selected_text) < text_budget:
            seen_text_chunk_ids = {int(item.get("chunk_id") or 0) for item in selected_text}
            for row in text_rows:
                chunk_id = int(row.get("chunk_id") or 0)
                if chunk_id in seen_text_chunk_ids:
                    continue
                selected_text.append(row)
                seen_text_chunk_ids.add(chunk_id)
                if len(selected_text) >= text_budget:
                    break

        combined = selected_text + chosen_images[:image_budget]
        combined.sort(key=lambda item: float(item.get("distance") or 0.0))
        return combined

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
        rows = self._expand_page_bundle_context(
            tenant_id=tenant_id,
            user_id=user_id,
            workroom_id=workroom_id,
            source_file_ids=source_file_ids,
            rows=rows,
        )

        grouped: dict[tuple[Any, Any], dict[str, Any]] = {}
        seen_chunk_ids: set[int] = set()
        for row in rows:
            chunk_id = int(row.get("chunk_id") or 0)
            if chunk_id > 0 and chunk_id in seen_chunk_ids:
                continue
            if chunk_id > 0:
                seen_chunk_ids.add(chunk_id)
            key = (row.get("file_id"), row.get("page_start"))
            bundle = grouped.setdefault(
                key,
                {
                    "source_id": row.get("source_id"),
                    "file_id": row.get("file_id"),
                    "page_no": row.get("page_start"),
                    "text_chunks": [],
                    "primary_image": None,
                    "related_images": [],
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
            elif _row_modality(row) == "image":
                bundle["related_images"].append(row)
            else:
                bundle["text_chunks"].append(row)

        ordered = sorted(grouped.values(), key=lambda item: item["_score"])
        result: list[dict[str, Any]] = []
        for item in ordered[:limit]:
            item.pop("_score", None)
            result.append(item)
        return result

    def _expand_page_bundle_context(
        self,
        *,
        tenant_id: int,
        user_id: int,
        workroom_id: int | None,
        source_file_ids: list[int] | None,
        rows: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        page_pairs = [
            (int(row.get("file_id")), int(row.get("page_start")))
            for row in rows
            if row.get("file_id") is not None and row.get("page_start") is not None
        ]
        if not page_pairs:
            return rows
        expanded = list(rows)
        expanded.extend(
            self._fetch_page_context_rows(
                tenant_id=tenant_id,
                user_id=user_id,
                workroom_id=workroom_id,
                source_file_ids=source_file_ids,
                page_pairs=page_pairs,
            )
        )
        return expanded

    def _fetch_page_context_rows(
        self,
        *,
        tenant_id: int,
        user_id: int,
        workroom_id: int | None,
        source_file_ids: list[int] | None,
        page_pairs: list[tuple[int, int]],
    ) -> list[dict[str, Any]]:
        normalized_pairs = [
            {"file_id": int(file_id), "page_no": int(page_no)}
            for file_id, page_no in page_pairs
            if int(file_id) > 0 and int(page_no) > 0
        ]
        if not normalized_pairs:
            return []

        sql = text(
            """
            WITH target_pages AS (
                SELECT
                    CAST(item->>'file_id' AS bigint) AS file_id,
                    CAST(item->>'page_no' AS integer) AS page_no
                FROM jsonb_array_elements(CAST(:page_pairs AS jsonb)) AS item
            )
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
            JOIN target_pages AS tp
              ON tp.file_id = s.file_id
             AND tp.page_no = c.page_no
            WHERE s.tenant_id = :tenant_id
              AND s.user_id = :user_id
              AND (:workroom_id IS NULL OR s.workroom_id IS NULL OR s.workroom_id = :workroom_id)
              AND (:source_file_ids_empty OR s.file_id = ANY(:source_file_ids))
            ORDER BY c.id DESC
            """
        )
        params = {
            "page_pairs": json.dumps(normalized_pairs, ensure_ascii=False),
            "tenant_id": tenant_id,
            "user_id": user_id,
            "workroom_id": workroom_id,
            "source_file_ids": list(source_file_ids or []),
            "source_file_ids_empty": not bool(source_file_ids),
        }
        with self._engine.connect() as conn:
            rows = conn.execute(sql, params)
            return [_row_to_dict(row) for row in rows]

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

    def search_semantic_groups(
        self,
        *,
        tenant_id: int,
        user_id: int,
        workroom_id: int | None,
        query_text: str,
        limit: int = 6,
        source_file_ids: list[int] | None = None,
    ) -> list[dict[str, Any]]:
        if limit <= 0:
            return []
        rows = self._fetch_semantic_group_candidates(
            tenant_id=tenant_id,
            user_id=user_id,
            workroom_id=workroom_id,
            query_text=query_text,
            source_file_ids=source_file_ids,
            fetch_limit=max(24, limit * 6),
        )
        if not rows:
            return []

        merged_by_group: dict[int, dict[str, Any]] = {}
        for row in rows:
            group_id = int(row.get("group_id") or 0)
            if group_id <= 0:
                continue
            current = merged_by_group.get(group_id)
            distance = float(row.get("distance") or 0.0)
            current_distance = float(current.get("distance") or 9999.0) if current is not None else 9999.0
            if current is None or distance < current_distance:
                merged_by_group[group_id] = {
                    **row,
                    "distance": distance,
                    "matched_embed_kind": str(row.get("embed_kind") or ""),
                }
        selected = sorted(merged_by_group.values(), key=lambda item: float(item.get("distance") or 0.0))[
            : max(limit * 3, limit)
        ]
        members = self._fetch_semantic_group_members(
            tenant_id=tenant_id,
            user_id=user_id,
            group_ids=[int(item.get("group_id") or 0) for item in selected],
        )
        members_by_group: dict[int, list[dict[str, Any]]] = {}
        for member in members:
            members_by_group.setdefault(int(member.get("group_id") or 0), []).append(member)
        for item in selected:
            item["members"] = members_by_group.get(int(item.get("group_id") or 0), [])
        return selected[:limit]

    def get_semantic_groups_by_ids(
        self,
        *,
        tenant_id: int,
        user_id: int,
        group_ids: list[int],
    ) -> list[dict[str, Any]]:
        normalized_ids = [int(group_id) for group_id in group_ids if int(group_id) > 0]
        if not normalized_ids:
            return []
        sql = text(
            """
            SELECT
                g.id AS group_id,
                g.group_key,
                g.group_type,
                g.page_no_start,
                g.page_no_end,
                g.title,
                g.text_content,
                g.primary_image_path,
                g.metadata_json,
                s.id AS source_id,
                s.file_id,
                s.document_id,
                s.source_kind AS source_type,
                0.0::float AS distance
            FROM kb_semantic_groups AS g
            JOIN kb_sources AS s ON s.id = g.source_id
            WHERE g.id = ANY(:group_ids)
              AND s.tenant_id = :tenant_id
              AND s.user_id = :user_id
            ORDER BY array_position(CAST(:group_ids AS bigint[]), g.id)
            """
        )
        params = {"group_ids": normalized_ids, "tenant_id": tenant_id, "user_id": user_id}
        with self._engine.connect() as conn:
            rows = conn.execute(sql, params)
            groups = [_row_to_dict(row) for row in rows]
        members = self._fetch_semantic_group_members(
            tenant_id=tenant_id,
            user_id=user_id,
            group_ids=normalized_ids,
        )
        members_by_group: dict[int, list[dict[str, Any]]] = {}
        for member in members:
            members_by_group.setdefault(int(member.get("group_id") or 0), []).append(member)
        for item in groups:
            item["members"] = members_by_group.get(int(item.get("group_id") or 0), [])
        return groups

    def search_units(
        self,
        *,
        tenant_id: int,
        user_id: int,
        workroom_id: int | None,
        query_text: str,
        limit: int = 6,
        source_file_ids: list[int] | None = None,
    ) -> list[dict[str, Any]]:
        if limit <= 0:
            return []
        try:
            candidate_rows = self._fetch_unit_candidates(
                tenant_id=tenant_id,
                user_id=user_id,
                workroom_id=workroom_id,
                query_text=query_text,
                source_file_ids=source_file_ids,
                fetch_limit=max(24, limit * 8),
            )
        except Exception:
            legacy = self.search_chunks(
                tenant_id=tenant_id,
                user_id=user_id,
                workroom_id=workroom_id,
                query_text=query_text,
                limit=limit,
                source_file_ids=source_file_ids,
            )
            unit_like: list[dict[str, Any]] = []
            for row in legacy:
                unit_like.append(
                    {
                        "unit_id": int(row.get("chunk_id") or 0),
                        "unit_key": f"legacy:{row.get('chunk_id')}",
                        "unit_type": "legacy_chunk",
                        "page_no_start": row.get("page_start"),
                        "page_no_end": row.get("page_end"),
                        "title": row.get("title"),
                        "text_content": row.get("content") if str(row.get("chunk_type") or "") != "page_image" else None,
                        "primary_image_path": (
                            (row.get("metadata_json") or {}).get("asset_rel_path")
                            if isinstance(row.get("metadata_json"), dict)
                            else None
                        ),
                        "metadata_json": row.get("metadata_json") if isinstance(row.get("metadata_json"), dict) else {},
                        "distance": row.get("distance"),
                        "source_id": row.get("source_id"),
                        "file_id": row.get("file_id"),
                        "document_id": row.get("document_id"),
                        "source_type": row.get("source_type"),
                        "embed_kind": "image" if str(row.get("chunk_type") or "") == "page_image" else "text",
                    }
                )
            return unit_like
        if not candidate_rows:
            return []

        merged_by_unit: dict[int, dict[str, Any]] = {}
        for row in candidate_rows:
            unit_id = int(row.get("unit_id") or 0)
            if unit_id <= 0:
                continue
            current = merged_by_unit.get(unit_id)
            distance = float(row.get("distance") or 0.0)
            current_distance = (
                float(current.get("distance"))
                if current is not None and current.get("distance") is not None
                else 9999.0
            )
            if current is None or distance < current_distance:
                merged_by_unit[unit_id] = {
                    **row,
                    "distance": distance,
                    "matched_embed_kind": str(row.get("embed_kind") or ""),
                }
            elif current is not None:
                seen = set(current.get("matched_embed_kinds") or [])
                kind = str(row.get("embed_kind") or "")
                if kind:
                    seen.add(kind)
                current["matched_embed_kinds"] = sorted(seen)

        units = list(merged_by_unit.values())
        units.sort(key=lambda item: float(item.get("distance") or 0.0))
        non_page_units = [item for item in units if str(item.get("unit_type") or "") != "page"]
        if not non_page_units:
            return units[:limit]

        supported_pages = {
            (int(item.get("file_id") or 0), int(item.get("page_no_start") or 0))
            for item in non_page_units
            if int(item.get("file_id") or 0) > 0 and int(item.get("page_no_start") or 0) > 0
        }
        page_fallback_units = [
            item
            for item in units
            if str(item.get("unit_type") or "") == "page"
            and (int(item.get("file_id") or 0), int(item.get("page_no_start") or 0)) not in supported_pages
        ]
        return (non_page_units + page_fallback_units)[:limit]

    def search_unit_refs(
        self,
        *,
        tenant_id: int,
        user_id: int,
        workroom_id: int | None,
        query_text: str,
        limit: int = 6,
        source_file_ids: list[int] | None = None,
    ) -> list[dict[str, Any]]:
        units = self.search_units(
            tenant_id=tenant_id,
            user_id=user_id,
            workroom_id=workroom_id,
            query_text=query_text,
            limit=limit,
            source_file_ids=source_file_ids,
        )
        lightweight: list[dict[str, Any]] = []
        for unit in units:
            lightweight.append(
                {
                    "unit_id": unit.get("unit_id"),
                    "unit_key": unit.get("unit_key"),
                    "unit_type": unit.get("unit_type"),
                    "page_no_start": unit.get("page_no_start"),
                    "page_no_end": unit.get("page_no_end"),
                    "title": unit.get("title"),
                    "distance": unit.get("distance"),
                    "source_id": unit.get("source_id"),
                    "file_id": unit.get("file_id"),
                    "document_id": unit.get("document_id"),
                    "source_type": unit.get("source_type"),
                    "matched_embed_kind": unit.get("matched_embed_kind"),
                    "matched_embed_kinds": unit.get("matched_embed_kinds") or [],
                }
            )
        return lightweight

    def get_units_by_ids(
        self,
        *,
        tenant_id: int,
        user_id: int,
        unit_ids: list[int],
    ) -> list[dict[str, Any]]:
        normalized_ids = [int(unit_id) for unit_id in unit_ids if int(unit_id) > 0]
        if not normalized_ids:
            return []
        sql = text(
            """
            SELECT
                u.id AS unit_id,
                u.unit_key,
                u.unit_type,
                u.page_no_start,
                u.page_no_end,
                u.title,
                u.text_content,
                u.primary_image_path,
                u.metadata_json,
                s.id AS source_id,
                s.file_id,
                s.document_id,
                s.source_kind AS source_type,
                0.0::float AS distance
            FROM kb_units AS u
            JOIN kb_sources AS s ON s.id = u.source_id
            WHERE u.id = ANY(:unit_ids)
              AND s.tenant_id = :tenant_id
              AND s.user_id = :user_id
            ORDER BY array_position(CAST(:unit_ids AS bigint[]), u.id)
            """
        )
        params = {"unit_ids": normalized_ids, "tenant_id": tenant_id, "user_id": user_id}
        try:
            with self._engine.connect() as conn:
                rows = conn.execute(sql, params)
                return [_row_to_dict(row) for row in rows]
        except Exception:
            rows = self.get_chunks_by_ids(
                tenant_id=tenant_id,
                user_id=user_id,
                chunk_ids=normalized_ids,
            )
            converted: list[dict[str, Any]] = []
            for row in rows:
                metadata = row.get("metadata_json") if isinstance(row.get("metadata_json"), dict) else {}
                converted.append(
                    {
                        "unit_id": row.get("chunk_id"),
                        "unit_key": f"legacy:{row.get('chunk_id')}",
                        "unit_type": "legacy_chunk",
                        "page_no_start": row.get("page_start"),
                        "page_no_end": row.get("page_end"),
                        "title": row.get("title"),
                        "text_content": row.get("content") if str(row.get("chunk_type") or "") != "page_image" else None,
                        "primary_image_path": metadata.get("asset_rel_path"),
                        "metadata_json": metadata,
                        "source_id": row.get("source_id"),
                        "file_id": row.get("file_id"),
                        "document_id": row.get("document_id"),
                        "source_type": row.get("source_type"),
                        "distance": 0.0,
                    }
                )
            return converted
