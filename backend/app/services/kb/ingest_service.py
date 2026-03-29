from __future__ import annotations

import json
from typing import Any

from sqlalchemy.orm import Session

from ...config import get_settings
from ...models import File, FilePageLayoutCache
from .chunk_builders import (
    build_layout_chunk_rows,
    build_semantic_group_rows,
    build_layout_unit_rows,
    build_page_unit_rows,
    build_text_chunk_rows,
    filter_boilerplate_chunk_rows_for_kb,
)
from .embedding_service import KBEmbeddingService
from .extractors import ImageKBExtractor, PdfKBExtractor, WordKBExtractor
from .repository import KBRepository


class KBIngestService:
    def __init__(self, db: Session) -> None:
        self._db = db
        self._repo = KBRepository(db)
        self._embedding = KBEmbeddingService()
        self._extractors = {
            "pdf": PdfKBExtractor(db),
            "word": WordKBExtractor(db),
            "image": ImageKBExtractor(db),
        }
        self._settings = get_settings()

    def ingest_file(
        self,
        *,
        tenant_id: int,
        user_id: int,
        workroom_id: int | None,
        file_id: int,
    ) -> dict[str, Any]:
        file = self._repo.get_file(file_id)
        if file is None:
            raise ValueError(f"file not found: {file_id}")

        source = self._repo.upsert_source(
            tenant_id=tenant_id,
            user_id=user_id,
            workroom_id=workroom_id,
            file=file,
            status="processing",
        )
        job_id = self._repo.create_ingest_job(source_id=int(source["id"]), stage="ingest", status="running")
        try:
            extractor = self._extractors.get(str(file.source_type))
            if extractor is None:
                raise RuntimeError(f"unsupported source type: {file.source_type}")
            extracted = extractor.extract(file)
            blocks = list(extracted.get("blocks") or [])
            pages = list(extracted.get("pages") or [])
            layout_blocks = self._load_layout_blocks(tenant_id=tenant_id, file=file, pages=pages)
            text_rows = build_text_chunk_rows(blocks)
            layout_rows = filter_boilerplate_chunk_rows_for_kb(build_layout_chunk_rows(layout_blocks))
            retained_layout_keys = {
                str((row.metadata_json or {}).get("layout_unit_key") or "").strip()
                for row in layout_rows
                if isinstance(row.metadata_json, dict)
            }
            cleaned_layout_blocks = [
                block
                for block in layout_blocks
                if str(block.get("layout_unit_key") or "").strip() in retained_layout_keys
            ]
            # Page preview images remain available in source page metadata / page units,
            # but they should not consume vector capacity or outrank layout-level evidence.
            all_rows = text_rows + layout_rows
            vectors = self._embedding.embed_rows(all_rows) if all_rows else []
            semantic_group_rows, semantic_group_memberships = build_semantic_group_rows(
                all_rows,
                title=str(file.original_name or ""),
            )
            unit_rows = build_page_unit_rows(blocks, pages, title=str(file.original_name or ""))
            unit_rows.extend(build_layout_unit_rows(cleaned_layout_blocks, title=str(file.original_name or "")))
            text_unit_rows = [row for row in unit_rows if row.text_content]
            image_unit_rows = [row for row in unit_rows if row.primary_image_path and row.unit_type != "page"]
            text_group_rows = [row for row in semantic_group_rows if row.text_content]
            image_group_rows = [row for row in semantic_group_rows if row.primary_image_path]
            text_unit_vectors = (
                self._embedding.embed_rows(
                    [
                        type(
                            "UnitEmbedRow",
                            (),
                            {"embed_input": {"text": row.text_content}, "token_count": row.token_count},
                        )()
                        for row in text_unit_rows
                    ]
                )
                if text_unit_rows
                else []
            )
            image_unit_vectors = (
                self._embedding.embed_rows(
                    [
                        type(
                            "UnitEmbedRow",
                            (),
                            {"embed_input": {"image": row.primary_image_path}, "token_count": 1},
                        )()
                        for row in image_unit_rows
                    ]
                )
                if image_unit_rows
                else []
            )
            text_group_vectors = (
                self._embedding.embed_rows(
                    [
                        type(
                            "SemanticGroupTextEmbedRow",
                            (),
                            {"embed_input": {"text": row.text_content}, "token_count": row.token_count},
                        )()
                        for row in text_group_rows
                    ]
                )
                if text_group_rows
                else []
            )
            image_group_vectors = (
                self._embedding.embed_rows(
                    [
                        type(
                            "SemanticGroupImageEmbedRow",
                            (),
                            {"embed_input": {"image": row.primary_image_path}, "token_count": 1},
                        )()
                        for row in image_group_rows
                    ]
                )
                if image_group_rows
                else []
            )
            self._repo.replace_source_pages(source_id=int(source["id"]), pages=pages)
            self._repo.replace_source_chunks_and_embeddings(
                source=source,
                chunk_rows=all_rows,
                vectors=vectors,
                model_name=self._embedding.model_name,
            )
            self._repo.replace_source_units_and_embeddings(
                source=source,
                unit_rows=unit_rows,
                text_vectors=text_unit_vectors,
                image_vectors=image_unit_vectors,
                model_name=self._embedding.model_name,
            )
            self._repo.replace_source_semantic_groups_and_embeddings(
                source=source,
                group_rows=semantic_group_rows,
                memberships=semantic_group_memberships,
                text_vectors=text_group_vectors,
                image_vectors=image_group_vectors,
                model_name=self._embedding.model_name,
            )
            self._repo.sync_binding_source_ids(
                tenant_id=int(source["tenant_id"]),
                user_id=int(source["user_id"]),
                file_id=int(file.id),
                source_id=int(source["id"]),
            )
            self._repo.mark_source_status(source_id=int(source["id"]), status="ready")
            self._repo.finish_ingest_job(job_id=job_id, status="completed")
            self._db.commit()
            return {
                "source_id": int(source["id"]),
                "page_count": len(pages),
                "chunk_count": len(all_rows),
                "unit_count": len(unit_rows),
                "semantic_group_count": len(semantic_group_rows),
            }
        except Exception as exc:
            self._db.rollback()
            self._repo.finish_ingest_job(job_id=job_id, status="failed", error=str(exc))
            self._repo.mark_source_status(source_id=int(source["id"]), status="failed")
            self._db.commit()
            raise

    def _load_layout_blocks(
        self,
        *,
        tenant_id: int,
        file: File,
        pages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        content_hash = str(getattr(file, "content_hash", "") or "").strip()
        if not content_hash:
            return []

        page_nos = sorted(
            {
                int(page.get("page_no") or 0)
                for page in pages
                if int(page.get("page_no") or 0) > 0
            }
        )
        if not page_nos:
            return []

        rows = (
            self._db.query(FilePageLayoutCache)
            .filter(
                FilePageLayoutCache.tenant_id == int(tenant_id),
                FilePageLayoutCache.content_hash == content_hash,
                FilePageLayoutCache.page_no.in_(page_nos),
                FilePageLayoutCache.model == self._settings.zhipu_model_glm_ocr,
                FilePageLayoutCache.schema_version == self._settings.page_layout_schema_version,
                FilePageLayoutCache.status == "completed",
            )
            .order_by(FilePageLayoutCache.page_no.asc(), FilePageLayoutCache.id.asc())
            .all()
        )

        layout_blocks: list[dict[str, Any]] = []
        for row in rows:
            if not row.blocks_json:
                continue
            try:
                blocks = json.loads(row.blocks_json)
            except json.JSONDecodeError:
                continue
            if not isinstance(blocks, list):
                continue
            for block in blocks:
                if not isinstance(block, dict):
                    continue
                normalized = dict(block)
                normalized.setdefault("page_no", int(row.page_no))
                normalized.setdefault("layout_page_cache_id", int(row.id))
                normalized.setdefault("transport_version", str(row.transport_kind or ""))
                layout_blocks.append(normalized)
        return layout_blocks
