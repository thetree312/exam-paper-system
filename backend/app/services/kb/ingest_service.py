from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from ...models import File
from .chunk_builders import build_page_image_chunk_rows, build_text_chunk_rows
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
            text_rows = build_text_chunk_rows(blocks)
            image_rows = build_page_image_chunk_rows(pages)
            all_rows = text_rows + image_rows
            vectors = self._embedding.embed_rows(all_rows) if all_rows else []
            self._repo.replace_source_pages(source_id=int(source["id"]), pages=pages)
            self._repo.replace_source_chunks_and_embeddings(
                source=source,
                chunk_rows=all_rows,
                vectors=vectors,
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
            }
        except Exception as exc:
            self._db.rollback()
            self._repo.finish_ingest_job(job_id=job_id, status="failed", error=str(exc))
            self._repo.mark_source_status(source_id=int(source["id"]), status="failed")
            self._db.commit()
            raise
