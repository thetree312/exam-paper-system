from __future__ import annotations

import json
from datetime import datetime, timedelta
import logging
import os
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.orm import Session

from .celery_app import celery_app
from .config import get_settings
from .db import SessionLocal
from .models import ExtractionSession, File, FilePageLayoutCache
from .routers.files import _detect_page_count, _render_pdf_previews, _render_word_previews
from .services.bailian_file_service import BailianFileService
from .services.glm_rate_limiter import GlmConcurrencyLimiter
from .services.kb.ingest_service import KBIngestService
from .services.kb.repository import KBRepository
from .services.page_layout_cache_manager import FilePageLayoutCacheManager
from .services.page_layout_service import PageLayoutService


logger = logging.getLogger(__name__)
settings = get_settings()


def _get_backend_root() -> Path:
    # backend/app/tasks.py -> backend
    return Path(__file__).resolve().parents[1]


def _ensure_posix(path: Path) -> str:
    return str(path).replace("\\", "/")


def _resolve_preview_asset_ref(*, file: File, page_no: int) -> str:
    if page_no < 1:
        raise ValueError("page_no must be >= 1")
    if file.source_type == "image":
        if not file.preview_path and not file.storage_path:
            raise ValueError(f"file {file.id} has no preview_path or storage_path")
        return str(file.preview_path or file.storage_path).replace("\\", "/")

    preview_path = str(file.preview_path or "").replace("\\", "/").strip()
    if not preview_path:
        raise ValueError(f"file {file.id} has no preview_path")
    if ".page" not in preview_path:
        if page_no != 1:
            raise ValueError(f"preview_path does not encode page number for file {file.id}")
        return preview_path

    prefix, suffix = preview_path.rsplit(".page", 1)
    page_str, ext = suffix.split(".", 1)
    int(page_str)
    return f"{prefix}.page{page_no}.{ext}"


@celery_app.task(name="ingest_kb_for_file")
def ingest_kb_for_file(
    tenant_id: int,
    user_id: int,
    file_id: int,
    workroom_id: int | None = None,
) -> None:
    db: Session = SessionLocal()
    try:
        logger.info(
            "[celery] start kb ingest tenant=%s user=%s workroom=%s file_id=%s",
            tenant_id,
            user_id,
            workroom_id,
            file_id,
        )
        result = KBIngestService(db).ingest_file(
            tenant_id=int(tenant_id),
            user_id=int(user_id),
            workroom_id=int(workroom_id) if workroom_id is not None else None,
            file_id=int(file_id),
        )
        logger.info("[celery] kb ingest done file_id=%s result=%s", file_id, result)
    except Exception:
        logger.exception("[celery] ingest_kb_for_file failed file_id=%s", file_id)
    finally:
        db.close()


@celery_app.task(name="generate_previews_for_session")
def generate_previews_for_session(session_id: int) -> None:
    """Generate preview PNGs for the given extraction session.

    This task runs in a Celery worker process and is safe to be CPU / IO intensive.
    """

    db: Session = SessionLocal()
    try:
        session: ExtractionSession | None = (
            db.query(ExtractionSession).filter(ExtractionSession.id == session_id).first()
        )
        if session is None:
            logger.warning("[celery] session %s not found", session_id)
            return

        file: File = session.file
        backend_root = _get_backend_root()
        storage_path = backend_root / file.storage_path

        logger.info(
            "[celery] start generate previews session=%s file_id=%s source_type=%s",
            session.id,
            file.id,
            file.source_type,
        )

        session.status = "processing"
        db.add(session)
        db.commit()

        preview_paths: list[Path] = []
        if file.source_type == "image":
            # 直接使用原图作为预览
            preview_paths = [storage_path]
        elif file.source_type == "pdf":
            preview_paths = _render_pdf_previews(storage_path)
        elif file.source_type == "word":
            preview_paths = _render_word_previews(storage_path)
        else:
            logger.warning("[celery] unsupported source_type=%s", file.source_type)

        if preview_paths:
            first = preview_paths[0]
            rel_first = os.path.relpath(first, backend_root)
            file.preview_path = _ensure_posix(Path(rel_first))
            db.add(file)

        session.status = "done"
        db.add(session)
        db.commit()

        try:
            schedule_layout_for_file.delay(
                int(session.tenant_id),
                int(session.user_id),
                int(file.id),
                int(session.workroom_id) if session.workroom_id is not None else None,
            )
        except Exception:
            logger.exception("[celery] failed to enqueue layout scheduler file_id=%s", file.id)

        logger.info(
            "[celery] generate previews done session=%s file_id=%s pages=%s",
            session.id,
            file.id,
            len(preview_paths),
        )
    except Exception:
        logger.exception("[celery] generate_previews_for_session failed session=%s", session_id)
        try:
            session = db.query(ExtractionSession).filter(ExtractionSession.id == session_id).first()
            if session is not None:
                session.status = "failed"
                db.add(session)
                db.commit()
        except Exception:
            logger.exception("[celery] failed to mark session failed session=%s", session_id)
    finally:
        db.close()


@celery_app.task(name="schedule_layout_for_file")
def schedule_layout_for_file(
    tenant_id: int,
    user_id: int,
    file_id: int,
    workroom_id: int | None = None,
) -> None:
    db: Session = SessionLocal()
    repo = KBRepository(db)
    source_id: int | None = None
    job_id: int | None = None
    try:
        file = db.query(File).filter(File.id == file_id).first()
        if file is None:
            logger.warning("[celery] file %s not found for layout schedule", file_id)
            return

        source = repo.upsert_source(
            tenant_id=int(tenant_id),
            user_id=int(user_id),
            workroom_id=int(workroom_id) if workroom_id is not None else None,
            file=file,
            status="layout_scheduling",
        )
        source_id = int(source["id"])
        job_id = repo.create_ingest_job(source_id=source_id, stage="layout_schedule")

        page_count = _detect_page_count(file, _get_backend_root())
        if page_count <= 0:
            raise RuntimeError(f"no preview pages found for file_id={file_id}")

        for page_no in range(1, page_count + 1):
            parse_layout_for_page.delay(
                int(tenant_id),
                int(user_id),
                int(file_id),
                int(source_id),
                page_no,
            )

        repo.mark_source_status(source_id=source_id, status="layout_queued")
        repo.finish_ingest_job(job_id=job_id, status="completed")
        db.commit()
        logger.info(
            "[celery] layout schedule done file_id=%s source_id=%s pages=%s",
            file_id,
            source_id,
            page_count,
        )
    except Exception as exc:
        db.rollback()
        logger.exception("[celery] schedule_layout_for_file failed file_id=%s", file_id)
        if source_id is not None:
            try:
                repo.mark_source_status(source_id=source_id, status="failed")
                if job_id is not None:
                    repo.finish_ingest_job(job_id=job_id, status="failed", error=str(exc))
                db.commit()
            except Exception:
                db.rollback()
                logger.exception("[celery] failed to mark layout schedule failure file_id=%s", file_id)
        raise
    finally:
        db.close()


@celery_app.task(name="finalize_layout_for_file")
def finalize_layout_for_file(
    tenant_id: int,
    user_id: int,
    file_id: int,
    source_id: int,
) -> None:
    db: Session = SessionLocal()
    try:
        file = db.query(File).filter(File.id == file_id).first()
        if file is None:
            logger.warning("[celery] file %s not found for layout finalize", file_id)
            return

        page_count = _detect_page_count(file, _get_backend_root())
        if page_count <= 0:
            logger.warning("[celery] no preview pages found during layout finalize file_id=%s", file_id)
            return

        completed_count = (
            db.query(FilePageLayoutCache)
            .filter(
                FilePageLayoutCache.tenant_id == int(tenant_id),
                FilePageLayoutCache.content_hash == str(file.content_hash or ""),
                FilePageLayoutCache.model == settings.zhipu_model_glm_ocr,
                FilePageLayoutCache.schema_version == settings.page_layout_schema_version,
                FilePageLayoutCache.status == "completed",
            )
            .count()
        )
        if completed_count != page_count:
            logger.info(
                "[celery] layout finalize waiting file_id=%s source_id=%s completed=%s/%s",
                file_id,
                source_id,
                completed_count,
                page_count,
            )
            return

        existing_embed_job = db.execute(
            text(
                """
                SELECT COUNT(*)
                FROM kb_ingest_jobs
                WHERE source_id = :source_id
                  AND stage = 'embed'
                  AND status IN ('running', 'completed')
                """
            ),
            {"source_id": int(source_id)},
        ).scalar_one()
        if int(existing_embed_job or 0) > 0:
            logger.info(
                "[celery] layout finalize skip existing embed job file_id=%s source_id=%s",
                file_id,
                source_id,
            )
            return

        source_row = db.execute(
            text(
                """
                UPDATE kb_sources
                SET status = 'embedding_queued',
                    updated_at = :updated_at
                WHERE id = :source_id
                  AND status IN ('layout_scheduling', 'layout_queued', 'layout_running', 'layout_completed', 'embedding_queued')
                RETURNING workroom_id, status
                """
            ),
            {
                "source_id": int(source_id),
                "updated_at": datetime.utcnow(),
            },
        ).mappings().first()
        if source_row is None:
            logger.info(
                "[celery] layout finalize skip source already advanced file_id=%s source_id=%s",
                file_id,
                source_id,
            )
            db.rollback()
            return

        db.commit()
        workroom_id = source_row.get("workroom_id")
        materialize_kb_for_file.delay(
            int(tenant_id),
            int(user_id),
            int(file.id),
            int(workroom_id) if workroom_id is not None else None,
        )
        logger.info(
            "[celery] all layout pages committed, enqueue materialize source_id=%s file_id=%s pages=%s",
            source_id,
            file.id,
            page_count,
        )
    except Exception:
        db.rollback()
        logger.exception("[celery] finalize_layout_for_file failed file_id=%s source_id=%s", file_id, source_id)
        raise
    finally:
        db.close()


@celery_app.task(name="parse_layout_for_page")
def parse_layout_for_page(
    tenant_id: int,
    user_id: int,
    file_id: int,
    source_id: int,
    page_no: int,
) -> None:
    owner = f"file:{file_id}:page:{page_no}"
    transport_kind = (
        "data_url" if settings.asset_transport_mode == "base64" else "http_url"
    )
    limiter = GlmConcurrencyLimiter(
        max_concurrency=settings.glm_layout_max_concurrency,
        lease_ttl=timedelta(seconds=settings.glm_layout_lease_seconds),
    )
    db: Session = SessionLocal()
    repo = KBRepository(db)
    cache_manager = FilePageLayoutCacheManager(db)
    page_layout_service = PageLayoutService(model=settings.zhipu_model_glm_ocr)
    job_id: int | None = None
    lease = None
    try:
        file = db.query(File).filter(File.id == file_id).first()
        if file is None:
            raise RuntimeError(f"file {file_id} not found for page layout parse")

        asset_ref = _resolve_preview_asset_ref(file=file, page_no=int(page_no))
        completed_entry = cache_manager.get_completed(
            tenant_id=int(tenant_id),
            content_hash=str(file.content_hash or ""),
            page_no=int(page_no),
            model=settings.zhipu_model_glm_ocr,
            schema_version=settings.page_layout_schema_version,
        )
        if completed_entry is not None:
            logger.info(
                "[celery] reuse completed layout cache file_id=%s page_no=%s cache_id=%s",
                file_id,
                page_no,
                completed_entry.id,
            )
            finalize_layout_for_file.delay(
                int(tenant_id),
                int(user_id),
                int(file_id),
                int(source_id),
            )
            return

        cache_entry = cache_manager.try_acquire(
            tenant_id=int(tenant_id),
            file_id=int(file_id),
            content_hash=str(file.content_hash or ""),
            page_no=int(page_no),
            model=settings.zhipu_model_glm_ocr,
            schema_version=settings.page_layout_schema_version,
            source_asset_ref=asset_ref,
            lease_owner=owner,
            lease_ttl=timedelta(seconds=settings.glm_layout_lease_seconds),
            transport_kind=transport_kind,
        )
        if cache_entry is None:
            logger.info(
                "[celery] layout cache is already live or completed file_id=%s page_no=%s",
                file_id,
                page_no,
            )
            return

        lease = limiter.acquire(owner=owner)
        if lease is None:
            raise RuntimeError(
                f"GLM layout concurrency limit reached for file_id={file_id} page_no={page_no}"
            )

        job_id = repo.create_ingest_job(source_id=int(source_id), stage="layout_parse")
        repo.mark_source_status(source_id=int(source_id), status="layout_running")
        result = page_layout_service.parse_page(asset_ref=asset_ref, page_no=int(page_no))
        cache_manager.mark_completed(
            entry=cache_entry,
            layout_json=json.dumps(result.raw_payload, ensure_ascii=False),
            blocks_json=json.dumps(result.blocks, ensure_ascii=False),
            transport_kind=result.transport_kind,
        )
        logger.info(
            "[celery] parse layout completed tenant=%s file_id=%s page_no=%s blocks=%s",
            tenant_id,
            file_id,
            page_no,
            len(result.blocks),
        )
        repo.finish_ingest_job(job_id=job_id, status="completed")
        db.commit()
        finalize_layout_for_file.delay(
            int(tenant_id),
            int(user_id),
            int(file_id),
            int(source_id),
        )
    except Exception as exc:
        db.rollback()
        logger.exception("[celery] parse_layout_for_page failed file_id=%s page_no=%s", file_id, page_no)
        try:
            file = db.query(File).filter(File.id == file_id).first()
            if file is not None:
                cache_entry = (
                    db.query(FilePageLayoutCache)
                    .filter(
                        FilePageLayoutCache.tenant_id == int(tenant_id),
                        FilePageLayoutCache.content_hash == str(file.content_hash or ""),
                        FilePageLayoutCache.page_no == int(page_no),
                        FilePageLayoutCache.model == settings.zhipu_model_glm_ocr,
                        FilePageLayoutCache.schema_version == settings.page_layout_schema_version,
                    )
                    .order_by(FilePageLayoutCache.id.desc())
                    .first()
                )
                if cache_entry is not None and str(cache_entry.lease_owner or "") == owner:
                    cache_manager.mark_failed(entry=cache_entry, error=str(exc))
                    db.commit()
        except Exception:
            db.rollback()
            logger.exception(
                "[celery] failed to persist layout cache failure file_id=%s page_no=%s",
                file_id,
                page_no,
            )
        if job_id is not None:
            try:
                repo.finish_ingest_job(job_id=job_id, status="failed", error=str(exc))
                db.commit()
            except Exception:
                db.rollback()
                logger.exception(
                    "[celery] failed to mark layout parse failure file_id=%s page_no=%s",
                    file_id,
                    page_no,
                )
        raise
    finally:
        db.close()
        if lease is not None:
            limiter.release(lease=lease, owner=owner)


@celery_app.task(name="materialize_kb_for_file")
def materialize_kb_for_file(
    tenant_id: int,
    user_id: int,
    file_id: int,
    workroom_id: int | None = None,
) -> None:
    db: Session = SessionLocal()
    repo = KBRepository(db)
    job_id: int | None = None
    try:
        file = db.query(File).filter(File.id == file_id).first()
        if file is None:
            raise RuntimeError(f"file {file_id} not found for KB materialization")
        source = repo.upsert_source(
            tenant_id=int(tenant_id),
            user_id=int(user_id),
            workroom_id=int(workroom_id) if workroom_id is not None else None,
            file=file,
            status="embedding",
        )
        job_id = repo.create_ingest_job(source_id=int(source["id"]), stage="embed")
        result = KBIngestService(db).ingest_file(
            tenant_id=int(tenant_id),
            user_id=int(user_id),
            workroom_id=int(workroom_id) if workroom_id is not None else None,
            file_id=int(file_id),
        )
        repo.mark_source_status(source_id=int(source["id"]), status="ready")
        repo.finish_ingest_job(job_id=job_id, status="completed")
        db.commit()
        logger.info("[celery] materialize KB done file_id=%s result=%s", file_id, result)
    except Exception as exc:
        db.rollback()
        logger.exception("[celery] materialize_kb_for_file failed file_id=%s", file_id)
        if job_id is not None:
            try:
                repo.finish_ingest_job(job_id=job_id, status="failed", error=str(exc))
                db.commit()
            except Exception:
                db.rollback()
                logger.exception(
                    "[celery] failed to mark materialize failure file_id=%s",
                    file_id,
                )
        raise
    finally:
        db.close()

@celery_app.task(name="cleanup_bailian_file_registry")
def cleanup_bailian_file_registry(
    older_than_days: int | None = None,
    limit: int | None = None,
) -> int:
    db: Session = SessionLocal()
    try:
        logger.info(
            "[celery] start bailian cleanup older_than_days=%s limit=%s",
            older_than_days,
            limit,
        )
        cleaned = BailianFileService(db).cleanup_stale_mappings(
            older_than_days=older_than_days,
            limit=limit,
            remote_delete=True,
        )
        db.commit()
        logger.info("[celery] bailian cleanup done cleaned=%s", cleaned)
        return cleaned
    except Exception:
        db.rollback()
        logger.exception("[celery] bailian cleanup failed")
        raise
    finally:
        db.close()
