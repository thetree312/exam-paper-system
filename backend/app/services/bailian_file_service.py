from __future__ import annotations

import hashlib
from datetime import datetime, timedelta
from pathlib import Path

from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import BailianFileRegistry, File
from .qwen_client import QwenClient


class BailianFileService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self._client: QwenClient | None = None
        self._backend_root = Path(__file__).resolve().parents[2]

    @property
    def client(self) -> QwenClient:
        if self._client is None:
            self._client = QwenClient()
        return self._client

    def get_active_mapping(
        self,
        *,
        tenant_id: int,
        local_file_id: int,
        purpose: str = "file-extract",
    ) -> BailianFileRegistry | None:
        return (
            self.db.query(BailianFileRegistry)
            .filter(
                BailianFileRegistry.tenant_id == tenant_id,
                BailianFileRegistry.local_file_id == local_file_id,
                BailianFileRegistry.provider == "dashscope",
                BailianFileRegistry.purpose == purpose,
                BailianFileRegistry.status == "active",
                BailianFileRegistry.deleted_at.is_(None),
            )
            .order_by(BailianFileRegistry.id.desc())
            .first()
        )

    def get_mapping_by_scope_hash(
        self,
        *,
        tenant_id: int,
        local_file_id: int,
        content_hash: str,
        purpose: str = "file-extract",
    ) -> BailianFileRegistry | None:
        return (
            self.db.query(BailianFileRegistry)
            .filter(
                BailianFileRegistry.tenant_id == tenant_id,
                BailianFileRegistry.local_file_id == local_file_id,
                BailianFileRegistry.provider == "dashscope",
                BailianFileRegistry.purpose == purpose,
                BailianFileRegistry.content_hash == content_hash,
            )
            .order_by(BailianFileRegistry.id.desc())
            .first()
        )

    def ensure_uploaded(
        self,
        *,
        tenant_id: int,
        local_file_id: int,
        purpose: str = "file-extract",
    ) -> BailianFileRegistry:
        local_file = self._get_local_file(tenant_id=tenant_id, local_file_id=local_file_id)
        if local_file is None:
            raise ValueError(f"File {local_file_id} not found for tenant {tenant_id}")

        content_hash = self._resolve_content_hash(local_file)
        existing = self.get_active_mapping(
            tenant_id=tenant_id,
            local_file_id=local_file_id,
            purpose=purpose,
        )
        if existing is not None and existing.content_hash == content_hash:
            existing.last_used_at = datetime.utcnow()
            self.db.add(existing)
            self.db.flush()
            return existing
        reusable = self.get_mapping_by_scope_hash(
            tenant_id=tenant_id,
            local_file_id=local_file_id,
            content_hash=content_hash,
            purpose=purpose,
        )
        if reusable is not None:
            if existing is not None and existing.id != reusable.id:
                self.cleanup_file_mappings(
                    tenant_id=tenant_id,
                    local_file_id=local_file_id,
                    purpose=purpose,
                    remote_delete=True,
                    only_active=True,
                )
            abs_path = self.resolve_absolute_path(local_file)
            response = self.client.upload_file(abs_path, purpose=purpose)
            now = datetime.utcnow()
            reusable.bailian_file_id = str(response.get("id") or "")
            reusable.status = "active"
            reusable.uploaded_at = now
            reusable.last_used_at = now
            reusable.deleted_at = None
            reusable.error_message = None
            reusable.updated_at = now
            self.db.add(reusable)
            self.db.flush()
            return reusable
        if existing is not None:
            self.cleanup_file_mappings(
                tenant_id=tenant_id,
                local_file_id=local_file_id,
                purpose=purpose,
                remote_delete=True,
                only_active=True,
            )

        abs_path = self.resolve_absolute_path(local_file)
        response = self.client.upload_file(abs_path, purpose=purpose)
        record = BailianFileRegistry(
            tenant_id=tenant_id,
            local_file_id=local_file_id,
            provider="dashscope",
            purpose=purpose,
            content_hash=content_hash,
            bailian_file_id=str(response.get("id") or ""),
            status="active",
            uploaded_at=datetime.utcnow(),
            last_used_at=datetime.utcnow(),
        )
        self.db.add(record)
        self.db.flush()
        return record

    def reupload_mapping(self, *, record: BailianFileRegistry) -> BailianFileRegistry:
        local_file = self._get_local_file(tenant_id=int(record.tenant_id), local_file_id=int(record.local_file_id))
        if local_file is None:
            raise ValueError(f"File {record.local_file_id} not found for tenant {record.tenant_id}")

        content_hash = self._resolve_content_hash(local_file)
        abs_path = self.resolve_absolute_path(local_file)
        response = self.client.upload_file(abs_path, purpose=str(record.purpose or "file-extract"))
        now = datetime.utcnow()

        record.content_hash = content_hash
        record.bailian_file_id = str(response.get("id") or "")
        record.status = "active"
        record.uploaded_at = now
        record.last_used_at = now
        record.deleted_at = None
        record.error_message = None
        record.updated_at = now
        self.db.add(record)
        self.db.flush()
        return record

    def cleanup_file_mappings(
        self,
        *,
        tenant_id: int,
        local_file_id: int,
        purpose: str = "file-extract",
        remote_delete: bool = True,
        only_active: bool = False,
    ) -> int:
        query = (
            self.db.query(BailianFileRegistry)
            .filter(
                BailianFileRegistry.tenant_id == tenant_id,
                BailianFileRegistry.local_file_id == local_file_id,
                BailianFileRegistry.provider == "dashscope",
                BailianFileRegistry.purpose == purpose,
                BailianFileRegistry.deleted_at.is_(None),
            )
            .order_by(BailianFileRegistry.id.asc())
        )
        if only_active:
            query = query.filter(BailianFileRegistry.status == "active")
        records = query.all()
        cleaned = 0
        for record in records:
            self.mark_deleted(record, remote_delete=remote_delete)
            cleaned += 1
        return cleaned

    def cleanup_stale_mappings(
        self,
        *,
        older_than_days: int | None = None,
        limit: int | None = None,
        remote_delete: bool = True,
    ) -> int:
        settings = get_settings()
        retention_days = older_than_days if older_than_days is not None else settings.bailian_file_retention_days
        batch_limit = limit if limit is not None else settings.bailian_file_cleanup_batch_size
        cutoff = datetime.utcnow() - timedelta(days=max(1, int(retention_days)))
        records = (
            self.db.query(BailianFileRegistry)
            .filter(
                BailianFileRegistry.provider == "dashscope",
                BailianFileRegistry.status == "active",
                BailianFileRegistry.deleted_at.is_(None),
                BailianFileRegistry.last_used_at < cutoff,
            )
            .order_by(BailianFileRegistry.last_used_at.asc(), BailianFileRegistry.id.asc())
            .limit(max(1, int(batch_limit)))
            .all()
        )
        cleaned = 0
        for record in records:
            self.mark_deleted(record, remote_delete=remote_delete)
            cleaned += 1
        return cleaned

    def resolve_absolute_path(self, local_file: File) -> Path:
        path = (self._backend_root / str(local_file.storage_path)).resolve()
        if not path.exists() or not path.is_file():
            raise FileNotFoundError(f"Stored local file not found: {path}")
        return path

    def mark_deleted(self, record: BailianFileRegistry, *, remote_delete: bool = False) -> BailianFileRegistry:
        if remote_delete and record.bailian_file_id:
            try:
                self.client.delete_file(record.bailian_file_id)
            except Exception:
                # Keep local state cleanup independent from remote availability.
                pass
        record.status = "deleted"
        record.deleted_at = datetime.utcnow()
        record.updated_at = datetime.utcnow()
        self.db.add(record)
        self.db.flush()
        return record

    def release_mapping(
        self,
        *,
        record: BailianFileRegistry | None,
        remote_delete: bool = True,
    ) -> None:
        if record is None or record.deleted_at is not None or record.status == "deleted":
            return
        self.mark_deleted(record, remote_delete=remote_delete)

    def _resolve_content_hash(self, local_file: File) -> str:
        if local_file.content_hash:
            return str(local_file.content_hash)
        abs_path = self.resolve_absolute_path(local_file)
        digest = hashlib.sha256(abs_path.read_bytes()).hexdigest()
        local_file.content_hash = digest
        self.db.add(local_file)
        self.db.flush()
        return digest

    def _get_local_file(self, *, tenant_id: int, local_file_id: int) -> File | None:
        return (
            self.db.query(File)
            .filter(File.id == local_file_id, File.tenant_id == tenant_id)
            .first()
        )
