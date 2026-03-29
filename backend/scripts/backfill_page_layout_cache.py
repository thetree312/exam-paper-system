"""Backfill page-level GLM layout cache from existing preview assets.

Usage:
    python scripts/backfill_page_layout_cache.py --tenant 2
    python scripts/backfill_page_layout_cache.py --file-ids 88,89
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from datetime import timedelta
from typing import Iterable, Optional

BASE_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from app.config import get_settings  # type: ignore  # pylint: disable=wrong-import-position
from app.db import SessionLocal  # type: ignore  # pylint: disable=wrong-import-position
from app.models import File  # type: ignore  # pylint: disable=wrong-import-position
from app.routers.files import _detect_page_count  # type: ignore  # pylint: disable=wrong-import-position
from app.services.page_layout_cache_manager import (  # type: ignore  # pylint: disable=wrong-import-position
    FilePageLayoutCacheManager,
)
from app.services.page_layout_service import PageLayoutService  # type: ignore  # pylint: disable=wrong-import-position
from app.tasks import _get_backend_root, _resolve_preview_asset_ref  # type: ignore  # pylint: disable=wrong-import-position


def backfill_page_layout_for_files(
    *,
    db,
    files: Iterable[File],
    detect_page_count,
    page_asset_resolver,
    cache_manager,
    page_layout_service,
) -> dict[str, int]:
    settings = get_settings()
    summary = {
        "files_seen": 0,
        "pages_total": 0,
        "pages_skipped": 0,
        "pages_completed": 0,
    }
    lease_ttl = timedelta(seconds=settings.glm_layout_lease_seconds)
    transport_kind = "data_url" if settings.asset_transport_mode == "base64" else "http_url"

    for file in files:
        content_hash = str(getattr(file, "content_hash", "") or "").strip()
        if not content_hash:
            continue
        summary["files_seen"] += 1
        page_count = int(detect_page_count(file) or 0)
        for page_no in range(1, page_count + 1):
            summary["pages_total"] += 1
            completed = cache_manager.get_completed(
                tenant_id=int(file.tenant_id),
                content_hash=content_hash,
                page_no=page_no,
                model=settings.zhipu_model_glm_ocr,
                schema_version=settings.page_layout_schema_version,
            )
            if completed is not None:
                summary["pages_skipped"] += 1
                continue

            asset_ref = page_asset_resolver(file=file, page_no=page_no)
            entry = cache_manager.try_acquire(
                tenant_id=int(file.tenant_id),
                file_id=int(file.id),
                content_hash=content_hash,
                page_no=page_no,
                model=settings.zhipu_model_glm_ocr,
                schema_version=settings.page_layout_schema_version,
                source_asset_ref=asset_ref,
                lease_owner=f"backfill:file:{file.id}:page:{page_no}",
                lease_ttl=lease_ttl,
                transport_kind=transport_kind,
            )
            if entry is None:
                summary["pages_skipped"] += 1
                continue

            result = page_layout_service.parse_page(asset_ref=asset_ref, page_no=page_no)
            cache_manager.mark_completed(
                entry=entry,
                layout_json=json.dumps(result.raw_payload, ensure_ascii=False),
                blocks_json=json.dumps(result.blocks, ensure_ascii=False),
                transport_kind=result.transport_kind,
            )
            if hasattr(db, "commit"):
                db.commit()
            summary["pages_completed"] += 1
    return summary


def backfill_page_layout_cache(
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
        backend_root = _get_backend_root()
        return backfill_page_layout_for_files(
            db=db,
            files=files,
            detect_page_count=lambda file: _detect_page_count(file, backend_root),
            page_asset_resolver=lambda *, file, page_no: _resolve_preview_asset_ref(file=file, page_no=page_no),
            cache_manager=FilePageLayoutCacheManager(db),
            page_layout_service=PageLayoutService(),
        )
    finally:
        db.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill page-level GLM layout cache")
    parser.add_argument("--tenant", type=int, default=None, help="Filter by tenant id")
    parser.add_argument(
        "--file-ids",
        type=str,
        default="",
        help="Comma-separated file IDs",
    )
    args = parser.parse_args()
    file_ids = [int(part) for part in str(args.file_ids or "").split(",") if str(part).strip()]
    summary = backfill_page_layout_cache(tenant_id=args.tenant, file_ids=file_ids or None)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
