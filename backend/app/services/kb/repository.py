from __future__ import annotations

from dataclasses import asdict
from datetime import datetime
from typing import Any, Iterable

from sqlalchemy import text
from sqlalchemy.orm import Session

from ...models import File
from .types import KBChunkRow, KBSemanticGroupMemberRow, KBSemanticGroupRow, KBUnitRow


def _vector_literal(vector: list[float]) -> str:
    return "[" + ",".join(f"{value:.8f}" for value in vector) + "]"


class KBRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_file(self, file_id: int) -> File | None:
        return self.db.query(File).filter(File.id == file_id).first()

    def upsert_source(
        self,
        *,
        tenant_id: int,
        user_id: int,
        workroom_id: int | None,
        file: File,
        source_kind: str = "article",
        status: str = "processing",
    ) -> dict[str, Any]:
        existing = self.db.execute(
            text(
                """
                SELECT *
                FROM kb_sources
                WHERE tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND file_id = :file_id
                  AND ((workroom_id IS NULL AND :workroom_id IS NULL) OR workroom_id = :workroom_id)
                ORDER BY id DESC
                LIMIT 1
                """
            ),
            {
                "tenant_id": tenant_id,
                "user_id": user_id,
                "file_id": int(file.id),
                "workroom_id": workroom_id,
            },
        ).mappings().first()
        now = datetime.utcnow()
        params = {
            "tenant_id": tenant_id,
            "user_id": user_id,
            "file_id": int(file.id),
            "document_id": None,
            "title": file.original_name,
            "mime_type": file.mime_type,
            "source_kind": source_kind,
            "status": status,
            "workroom_id": workroom_id,
            "updated_at": now,
        }
        if existing:
            row = self.db.execute(
                text(
                    """
                    UPDATE kb_sources
                    SET title = :title,
                        mime_type = :mime_type,
                        source_kind = :source_kind,
                        status = :status,
                        updated_at = :updated_at
                    WHERE id = :id
                    RETURNING *
                    """
                ),
                {**params, "id": int(existing["id"])},
            ).mappings().one()
        else:
            row = self.db.execute(
                text(
                    """
                    INSERT INTO kb_sources
                        (tenant_id, user_id, file_id, document_id, title, mime_type, source_kind, status, version, created_at, updated_at, workroom_id)
                    VALUES
                        (:tenant_id, :user_id, :file_id, :document_id, :title, :mime_type, :source_kind, :status, 1, :updated_at, :updated_at, :workroom_id)
                    RETURNING *
                    """
                ),
                params,
            ).mappings().one()
        return dict(row)

    def replace_source_pages(self, *, source_id: int, pages: list[dict[str, Any]]) -> None:
        self.db.execute(text("DELETE FROM kb_source_pages WHERE source_id = :source_id"), {"source_id": source_id})
        for page in pages:
            self.db.execute(
                text(
                    """
                    INSERT INTO kb_source_pages
                        (source_id, page_no, preview_text, preview_image_path, created_at)
                    VALUES
                        (:source_id, :page_no, :preview_text, :preview_image_path, :created_at)
                    """
                ),
                {
                    "source_id": source_id,
                    "page_no": page.get("page_no"),
                    "preview_text": page.get("preview_text"),
                    "preview_image_path": page.get("preview_image_path"),
                    "created_at": datetime.utcnow(),
                },
            )

    def replace_source_chunks_and_embeddings(
        self,
        *,
        source: dict[str, Any],
        chunk_rows: list[KBChunkRow],
        vectors: list[list[float]],
        model_name: str,
    ) -> None:
        source_id = int(source["id"])
        tenant_id = int(source["tenant_id"])
        user_id = int(source["user_id"])

        old_chunk_ids = [
            row[0]
            for row in self.db.execute(
                text("SELECT id FROM kb_chunks WHERE source_id = :source_id"),
                {"source_id": source_id},
            ).fetchall()
        ]
        if old_chunk_ids:
            self.db.execute(
                text("DELETE FROM kb_chunk_embeddings WHERE chunk_id = ANY(:chunk_ids)"),
                {"chunk_ids": old_chunk_ids},
            )
        self.db.execute(text("DELETE FROM kb_chunks WHERE source_id = :source_id"), {"source_id": source_id})

        inserted_chunk_ids: list[int] = []
        for chunk in chunk_rows:
            row = self.db.execute(
                text(
                    """
                    INSERT INTO kb_chunks
                        (source_id, chunk_type, page_no, block_index, content, token_count, metadata_json, content_hash, version, created_at)
                    VALUES
                        (:source_id, :chunk_type, :page_no, :block_index, :content, :token_count, CAST(:metadata_json AS jsonb), :content_hash, 1, :created_at)
                    RETURNING id
                    """
                ),
                {
                    "source_id": source_id,
                    "chunk_type": chunk.chunk_type,
                    "page_no": chunk.page_no,
                    "block_index": chunk.block_index,
                    "content": chunk.content,
                    "token_count": chunk.token_count,
                    "metadata_json": __import__("json").dumps(chunk.metadata_json, ensure_ascii=False),
                    "content_hash": chunk.content_hash,
                    "created_at": datetime.utcnow(),
                },
            ).one()
            inserted_chunk_ids.append(int(row[0]))

        for chunk_id, vector in zip(inserted_chunk_ids, vectors, strict=False):
            self.db.execute(
                text(
                    """
                    INSERT INTO kb_chunk_embeddings
                        (chunk_id, tenant_id, user_id, model_name, dim, embedding, created_at)
                    VALUES
                        (:chunk_id, :tenant_id, :user_id, :model_name, :dim, CAST(:embedding AS vector), :created_at)
                    """
                ),
                {
                    "chunk_id": chunk_id,
                    "tenant_id": tenant_id,
                    "user_id": user_id,
                    "model_name": model_name,
                    "dim": len(vector),
                    "embedding": _vector_literal(vector),
                    "created_at": datetime.utcnow(),
                },
            )

    def replace_source_units_and_embeddings(
        self,
        *,
        source: dict[str, Any],
        unit_rows: list[KBUnitRow],
        text_vectors: list[list[float]],
        image_vectors: list[list[float]],
        model_name: str,
    ) -> None:
        source_id = int(source["id"])
        tenant_id = int(source["tenant_id"])
        user_id = int(source["user_id"])

        old_unit_ids = [
            row[0]
            for row in self.db.execute(
                text("SELECT id FROM kb_units WHERE source_id = :source_id"),
                {"source_id": source_id},
            ).fetchall()
        ]
        if old_unit_ids:
            self.db.execute(
                text("DELETE FROM kb_unit_embeddings WHERE unit_id = ANY(:unit_ids)"),
                {"unit_ids": old_unit_ids},
            )
        self.db.execute(text("DELETE FROM kb_units WHERE source_id = :source_id"), {"source_id": source_id})

        inserted_unit_ids: list[int] = []
        for unit in unit_rows:
            row = self.db.execute(
                text(
                    """
                    INSERT INTO kb_units
                        (source_id, unit_key, unit_type, page_no_start, page_no_end, title, text_content, primary_image_path, token_count, metadata_json, content_hash, version, created_at)
                    VALUES
                        (:source_id, :unit_key, :unit_type, :page_no_start, :page_no_end, :title, :text_content, :primary_image_path, :token_count, CAST(:metadata_json AS jsonb), :content_hash, 1, :created_at)
                    RETURNING id
                    """
                ),
                {
                    "source_id": source_id,
                    "unit_key": unit.unit_key,
                    "unit_type": unit.unit_type,
                    "page_no_start": unit.page_no_start,
                    "page_no_end": unit.page_no_end,
                    "title": unit.title,
                    "text_content": unit.text_content,
                    "primary_image_path": unit.primary_image_path,
                    "token_count": unit.token_count,
                    "metadata_json": __import__("json").dumps(unit.metadata_json, ensure_ascii=False),
                    "content_hash": unit.content_hash,
                    "created_at": datetime.utcnow(),
                },
            ).one()
            inserted_unit_ids.append(int(row[0]))

        text_idx = 0
        image_idx = 0
        for unit_id, unit in zip(inserted_unit_ids, unit_rows, strict=False):
            if unit.text_content:
                vector = text_vectors[text_idx] if text_idx < len(text_vectors) else None
                text_idx += 1
                if vector:
                    self.db.execute(
                        text(
                            """
                            INSERT INTO kb_unit_embeddings
                                (unit_id, tenant_id, user_id, model_name, embed_kind, dim, embedding, created_at)
                            VALUES
                                (:unit_id, :tenant_id, :user_id, :model_name, :embed_kind, :dim, CAST(:embedding AS vector), :created_at)
                            """
                        ),
                        {
                            "unit_id": unit_id,
                            "tenant_id": tenant_id,
                            "user_id": user_id,
                            "model_name": model_name,
                            "embed_kind": "text",
                            "dim": len(vector),
                            "embedding": _vector_literal(vector),
                            "created_at": datetime.utcnow(),
                        },
                    )

    def replace_source_semantic_groups_and_embeddings(
        self,
        *,
        source: dict[str, Any],
        group_rows: list[KBSemanticGroupRow],
        memberships: list[KBSemanticGroupMemberRow],
        text_vectors: list[list[float]],
        image_vectors: list[list[float]],
        model_name: str,
    ) -> None:
        source_id = int(source["id"])
        tenant_id = int(source["tenant_id"])
        user_id = int(source["user_id"])

        old_group_ids = [
            row[0]
            for row in self.db.execute(
                text("SELECT id FROM kb_semantic_groups WHERE source_id = :source_id"),
                {"source_id": source_id},
            ).fetchall()
        ]
        if old_group_ids:
            self.db.execute(
                text("DELETE FROM kb_semantic_group_embeddings WHERE group_id = ANY(:group_ids)"),
                {"group_ids": old_group_ids},
            )
            self.db.execute(
                text("DELETE FROM kb_semantic_group_members WHERE group_id = ANY(:group_ids)"),
                {"group_ids": old_group_ids},
            )
        self.db.execute(text("DELETE FROM kb_semantic_groups WHERE source_id = :source_id"), {"source_id": source_id})

        chunk_id_by_hash = {
            str(row[1]): int(row[0])
            for row in self.db.execute(
                text("SELECT id, content_hash FROM kb_chunks WHERE source_id = :source_id"),
                {"source_id": source_id},
            ).fetchall()
            if str(row[1] or "").strip()
        }

        inserted_group_ids: list[int] = []
        group_id_by_key: dict[str, int] = {}
        for group in group_rows:
            row = self.db.execute(
                text(
                    """
                    INSERT INTO kb_semantic_groups
                        (source_id, group_key, group_type, page_no_start, page_no_end, title, text_content, primary_image_path, token_count, metadata_json, content_hash, version, created_at)
                    VALUES
                        (:source_id, :group_key, :group_type, :page_no_start, :page_no_end, :title, :text_content, :primary_image_path, :token_count, CAST(:metadata_json AS jsonb), :content_hash, 1, :created_at)
                    RETURNING id
                    """
                ),
                {
                    "source_id": source_id,
                    "group_key": group.group_key,
                    "group_type": group.group_type,
                    "page_no_start": group.page_no_start,
                    "page_no_end": group.page_no_end,
                    "title": group.title,
                    "text_content": group.text_content,
                    "primary_image_path": group.primary_image_path,
                    "token_count": group.token_count,
                    "metadata_json": __import__("json").dumps(group.metadata_json, ensure_ascii=False),
                    "content_hash": group.content_hash,
                    "created_at": datetime.utcnow(),
                },
            ).one()
            group_id = int(row[0])
            inserted_group_ids.append(group_id)
            group_id_by_key[group.group_key] = group_id

        for member in memberships:
            group_id = group_id_by_key.get(member.group_key)
            chunk_id = chunk_id_by_hash.get(member.chunk_content_hash)
            if group_id is None or chunk_id is None:
                continue
            self.db.execute(
                text(
                    """
                    INSERT INTO kb_semantic_group_members
                        (group_id, chunk_id, member_role, member_order, created_at)
                    VALUES
                        (:group_id, :chunk_id, :member_role, :member_order, :created_at)
                    """
                ),
                {
                    "group_id": group_id,
                    "chunk_id": chunk_id,
                    "member_role": member.member_role,
                    "member_order": member.member_order,
                    "created_at": datetime.utcnow(),
                },
            )

        text_idx = 0
        image_idx = 0
        for group_id, group in zip(inserted_group_ids, group_rows, strict=False):
            if group.text_content:
                vector = text_vectors[text_idx] if text_idx < len(text_vectors) else None
                text_idx += 1
                if vector:
                    self.db.execute(
                        text(
                            """
                            INSERT INTO kb_semantic_group_embeddings
                                (group_id, tenant_id, user_id, model_name, embed_kind, dim, embedding, created_at)
                            VALUES
                                (:group_id, :tenant_id, :user_id, :model_name, :embed_kind, :dim, CAST(:embedding AS vector), :created_at)
                            """
                        ),
                        {
                            "group_id": group_id,
                            "tenant_id": tenant_id,
                            "user_id": user_id,
                            "model_name": model_name,
                            "embed_kind": "text",
                            "dim": len(vector),
                            "embedding": _vector_literal(vector),
                            "created_at": datetime.utcnow(),
                        },
                    )
            if group.primary_image_path:
                vector = image_vectors[image_idx] if image_idx < len(image_vectors) else None
                image_idx += 1
                if vector:
                    self.db.execute(
                        text(
                            """
                            INSERT INTO kb_semantic_group_embeddings
                                (group_id, tenant_id, user_id, model_name, embed_kind, dim, embedding, created_at)
                            VALUES
                                (:group_id, :tenant_id, :user_id, :model_name, :embed_kind, :dim, CAST(:embedding AS vector), :created_at)
                            """
                        ),
                        {
                            "group_id": group_id,
                            "tenant_id": tenant_id,
                            "user_id": user_id,
                            "model_name": model_name,
                            "embed_kind": "image",
                            "dim": len(vector),
                            "embedding": _vector_literal(vector),
                            "created_at": datetime.utcnow(),
                        },
                    )

    def create_ingest_job(self, *, source_id: int, stage: str, status: str = "running") -> int:
        row = self.db.execute(
            text(
                """
                INSERT INTO kb_ingest_jobs
                    (source_id, stage, status, error, retry_count, started_at, finished_at)
                VALUES
                    (:source_id, :stage, :status, NULL, 0, :started_at, NULL)
                RETURNING id
                """
            ),
            {
                "source_id": source_id,
                "stage": stage,
                "status": status,
                "started_at": datetime.utcnow(),
            },
        ).one()
        return int(row[0])

    def finish_ingest_job(self, *, job_id: int, status: str, error: str | None = None) -> None:
        self.db.execute(
            text(
                """
                UPDATE kb_ingest_jobs
                SET status = :status,
                    error = :error,
                    finished_at = :finished_at
                WHERE id = :job_id
                """
            ),
            {"job_id": job_id, "status": status, "error": error, "finished_at": datetime.utcnow()},
        )

    def mark_source_status(self, *, source_id: int, status: str) -> None:
        self.db.execute(
            text(
                """
                UPDATE kb_sources
                SET status = :status,
                    updated_at = :updated_at
                WHERE id = :source_id
                """
            ),
            {"source_id": source_id, "status": status, "updated_at": datetime.utcnow()},
        )

    def sync_binding_source_ids(
        self,
        *,
        tenant_id: int,
        user_id: int,
        file_id: int,
        source_id: int,
    ) -> None:
        self.db.execute(
            text(
                """
                UPDATE workroom_source_bindings
                SET source_id = :source_id,
                    updated_at = :updated_at
                WHERE tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND file_id = :file_id
                  AND is_active = TRUE
                """
            ),
            {
                "tenant_id": tenant_id,
                "user_id": user_id,
                "file_id": file_id,
                "source_id": source_id,
                "updated_at": datetime.utcnow(),
            },
        )
