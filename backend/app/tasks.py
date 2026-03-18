from __future__ import annotations

import logging
import os
from pathlib import Path

from sqlalchemy.orm import Session

from .celery_app import celery_app
from .db import SessionLocal
from .models import ExtractionSession, File
from .routers.files import _render_pdf_previews, _render_word_previews
from .services.kb.ingest_service import KBIngestService


logger = logging.getLogger(__name__)


def _get_backend_root() -> Path:
    # backend/app/tasks.py -> backend
    return Path(__file__).resolve().parents[1]


def _ensure_posix(path: Path) -> str:
    return str(path).replace("\\", "/")


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
            ingest_kb_for_file.delay(
                int(session.tenant_id),
                int(session.user_id),
                int(file.id),
                None,
            )
        except Exception:
            logger.exception("[celery] failed to enqueue kb ingest file_id=%s", file.id)

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
