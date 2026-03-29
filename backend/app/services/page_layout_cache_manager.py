from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

from ..models import FilePageLayoutCache


class FilePageLayoutCacheManager:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_completed(
        self,
        *,
        tenant_id: int,
        content_hash: str,
        page_no: int,
        model: str,
        schema_version: str,
        ttl: Optional[timedelta] = None,
    ) -> Optional[FilePageLayoutCache]:
        entry = self._get_identity(
            tenant_id=tenant_id,
            content_hash=content_hash,
            page_no=page_no,
            model=model,
            schema_version=schema_version,
        )
        if entry is None or str(entry.status) != "completed":
            return None
        if ttl is None:
            return entry
        generated_at = self._normalize_dt(entry.generated_at)
        if generated_at is None:
            return None
        if generated_at >= datetime.now(timezone.utc) - ttl:
            return entry
        return None

    def try_acquire(
        self,
        *,
        tenant_id: int,
        file_id: int,
        content_hash: str,
        page_no: int,
        model: str,
        schema_version: str,
        source_asset_ref: str,
        lease_owner: str,
        lease_ttl: timedelta,
        transport_kind: str = "data_url",
    ) -> Optional[FilePageLayoutCache]:
        now = datetime.now(timezone.utc)
        entry = self._get_identity(
            tenant_id=tenant_id,
            content_hash=content_hash,
            page_no=page_no,
            model=model,
            schema_version=schema_version,
        )
        if entry is None:
            entry = FilePageLayoutCache(
                tenant_id=tenant_id,
                file_id=file_id,
                content_hash=content_hash,
                page_no=page_no,
                model=model,
                schema_version=schema_version,
                status="running",
                lease_owner=lease_owner,
                lease_expires_at=now + lease_ttl,
                request_started_at=now,
                generated_at=None,
                error=None,
                source_asset_ref=source_asset_ref,
                transport_kind=transport_kind,
                layout_json=None,
                blocks_json=None,
            )
            self.db.add(entry)
            return entry

        if str(entry.status) == "completed":
            return None

        lease_expires_at = self._normalize_dt(entry.lease_expires_at)
        if str(entry.status) == "running" and lease_expires_at is not None and lease_expires_at > now:
            return None

        entry.file_id = file_id
        entry.status = "running"
        entry.lease_owner = lease_owner
        entry.lease_expires_at = now + lease_ttl
        entry.request_started_at = now
        entry.generated_at = None
        entry.error = None
        entry.source_asset_ref = source_asset_ref
        entry.transport_kind = transport_kind
        self.db.add(entry)
        return entry

    def mark_completed(
        self,
        *,
        entry: FilePageLayoutCache,
        layout_json: str,
        blocks_json: str,
        transport_kind: str,
    ) -> FilePageLayoutCache:
        now = datetime.now(timezone.utc)
        entry.status = "completed"
        entry.layout_json = layout_json
        entry.blocks_json = blocks_json
        entry.transport_kind = transport_kind
        entry.generated_at = now
        entry.lease_owner = None
        entry.lease_expires_at = None
        self.db.add(entry)
        return entry

    def mark_failed(self, *, entry: FilePageLayoutCache, error: str) -> FilePageLayoutCache:
        entry.status = "failed"
        entry.error = error
        entry.lease_owner = None
        entry.lease_expires_at = None
        self.db.add(entry)
        return entry

    def _get_identity(
        self,
        *,
        tenant_id: int,
        content_hash: str,
        page_no: int,
        model: str,
        schema_version: str,
    ) -> Optional[FilePageLayoutCache]:
        return (
            self.db.query(FilePageLayoutCache)
            .filter(
                FilePageLayoutCache.tenant_id == tenant_id,
                FilePageLayoutCache.content_hash == content_hash,
                FilePageLayoutCache.page_no == page_no,
                FilePageLayoutCache.model == model,
                FilePageLayoutCache.schema_version == schema_version,
            )
            .order_by(FilePageLayoutCache.id.desc())
            .first()
        )

    @staticmethod
    def _normalize_dt(value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.tzinfo.utcoffset(value) is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
