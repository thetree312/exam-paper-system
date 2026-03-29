"""Backfill KB layout-aware materialization for files with preview/layout assets.

Usage:
    python scripts/backfill_kb_layout_blocks.py --tenant 2
    python scripts/backfill_kb_layout_blocks.py --file-ids 88,89
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from typing import Callable, Iterable, Optional

BASE_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from sqlalchemy import text  # type: ignore  # pylint: disable=wrong-import-position

from app.db import SessionLocal  # type: ignore  # pylint: disable=wrong-import-position
from app.models import File  # type: ignore  # pylint: disable=wrong-import-position
from app.services.kb.ingest_service import KBIngestService  # type: ignore  # pylint: disable=wrong-import-position


def _latest_source_status(db, *, tenant_id: int, user_id: int, file_id: int) -> str | None:
    row = db.execute(
        text(
            """
            SELECT status
            FROM kb_sources
            WHERE tenant_id = :tenant_id
              AND user_id = :user_id
              AND file_id = :file_id
              AND workroom_id IS NULL
            ORDER BY id DESC
            LIMIT 1
            """
        ),
        {
            "tenant_id": int(tenant_id),
            "user_id": int(user_id),
            "file_id": int(file_id),
        },
    ).mappings().first()
    if not row:
        return None
    return str(row.get("status") or "").strip().lower() or None


def backfill_kb_layout_blocks_for_files(
    *,
    db,
    files: Iterable[File],
    ingest_callback: Callable[..., object],
) -> dict[str, int]:
    summary = {
        "files_seen": 0,
        "files_skipped": 0,
        "files_materialized": 0,
    }
    for file in files:
        summary["files_seen"] += 1
        tenant_id = int(file.tenant_id)
        user_id = int(getattr(file, "uploader_id", 0) or 0)
        latest_status = _latest_source_status(
            db,
            tenant_id=tenant_id,
            user_id=user_id,
            file_id=int(file.id),
        )
        if latest_status == "ready":
            summary["files_skipped"] += 1
            continue
        ingest_callback(
            tenant_id=tenant_id,
            user_id=user_id,
            workroom_id=None,
            file_id=int(file.id),
        )
        summary["files_materialized"] += 1
    return summary


def backfill_kb_layout_blocks(
    *,
    tenant_id: Optional[int] = None,
    file_ids: Optional[list[int]] = None,
) -> dict[str, int]:
    db = SessionLocal()
    try:
        query = db.query(File).order_by(File.id.asc())
        if tenant_id is not None:
            query = query.filter(File.tenant_id == tenant_id)
        if file_ids:
            query = query.filter(File.id.in_(file_ids))
        files = query.all()
        ingest_service = KBIngestService(db)
        return backfill_kb_layout_blocks_for_files(
            db=db,
            files=files,
            ingest_callback=lambda **kwargs: ingest_service.ingest_file(**kwargs),
        )
    finally:
        db.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill KB layout blocks from page layout cache")
    parser.add_argument("--tenant", type=int, default=None, help="Filter by tenant id")
    parser.add_argument(
        "--file-ids",
        type=str,
        default="",
        help="Comma-separated file IDs",
    )
    args = parser.parse_args()
    file_ids = [int(part) for part in str(args.file_ids or "").split(",") if str(part).strip()]
    summary = backfill_kb_layout_blocks(tenant_id=args.tenant, file_ids=file_ids or None)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
