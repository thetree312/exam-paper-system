from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from ..models import Document, FileOcrCache


class FileOcrCacheManager:
    """Encapsulate FileOcrCache read/write with versioning semantics."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def get_latest(
        self,
        *,
        tenant_id: int,
        content_hash: str,
        model: str,
        ttl: Optional[timedelta] = None,
    ) -> Optional[FileOcrCache]:
        entry = (
            self.db.query(FileOcrCache)
            .filter(
                FileOcrCache.tenant_id == tenant_id,
                FileOcrCache.content_hash == content_hash,
                FileOcrCache.model == model,
                FileOcrCache.is_active.is_(True),
            )
            .order_by(FileOcrCache.id.desc())
            .first()
        )
        if entry is None:
            return None
        if ttl is None:
            return entry
        if entry.generated_at is None:
            return None
        generated_at = entry.generated_at
        if generated_at.tzinfo is not None and generated_at.tzinfo.utcoffset(generated_at) is not None:
            generated_at = generated_at.replace(tzinfo=None)
        if generated_at >= datetime.utcnow() - ttl:
            return entry
        return None

    def upsert(
        self,
        *,
        tenant_id: int,
        content_hash: str,
        model: str,
        file_id: int,
        document: Optional[Document],
        md_payload,
        layout_payload,
    ) -> FileOcrCache:
        now = datetime.utcnow()
        previous = (
            self.db.query(FileOcrCache)
            .filter(
                FileOcrCache.tenant_id == tenant_id,
                FileOcrCache.content_hash == content_hash,
                FileOcrCache.model == model,
                FileOcrCache.is_active.is_(True),
            )
            .order_by(FileOcrCache.id.desc())
            .first()
        )

        next_version = 1
        if previous is not None:
            next_version = (previous.version or 1) + 1
            previous.is_active = False
            self.db.add(previous)

        cache_entry = FileOcrCache(
            tenant_id=tenant_id,
            content_hash=content_hash,
            model=model,
            version=next_version,
            is_active=True,
            file_id=file_id,
            md_cache=self._dump_json(md_payload),
            layout_cache=self._dump_json(layout_payload),
            generated_at=now,
            source_document_id=document.id if document is not None else None,
        )
        self.db.add(cache_entry)
        return cache_entry

    def attach_document(self, cache_entry: FileOcrCache, document: Document) -> None:
        if cache_entry.source_document_id != document.id:
            cache_entry.source_document_id = document.id
            self.db.add(cache_entry)

    def touch(self, cache_entry: FileOcrCache) -> None:
        cache_entry.updated_at = datetime.utcnow()
        self.db.add(cache_entry)

    def _dump_json(self, payload) -> Optional[str]:
        if payload is None:
            return None
        try:
            return json.dumps(payload, ensure_ascii=False)
        except Exception:
            return None
