from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from ...models import Document, File, FulltextBlock, MindMap, Question


class MindMapRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_active_map(
        self,
        *,
        tenant_id: int,
        workroom_id: int,
        source_type: str,
        source_id: int,
        source_signature: str | None,
        kind: str,
    ) -> Optional[MindMap]:
        query = (
            self.db.query(MindMap)
            .filter(
                MindMap.tenant_id == tenant_id,
                MindMap.workroom_id == workroom_id,
                MindMap.source_type == source_type,
                MindMap.kind == kind,
                MindMap.is_active == 1,
            )
        )
        if source_signature:
            query = query.filter(MindMap.source_signature == source_signature)
        else:
            query = query.filter(MindMap.source_id == source_id, MindMap.source_signature.is_(None))
        return query.order_by(MindMap.version.desc()).first()

    def create_map_version(
        self,
        *,
        tenant_id: int,
        user_id: int | None,
        workroom_id: int,
        source_type: str,
        source_id: int,
        source_signature: str | None,
        kind: str,
        title: str | None,
        graph_json: dict,
    ) -> MindMap:
        existing = self.get_active_map(
            tenant_id=tenant_id,
            workroom_id=workroom_id,
            source_type=source_type,
            source_id=source_id,
            source_signature=source_signature,
            kind=kind,
        )
        next_version = 1
        if existing is not None:
            existing.is_active = 0
            self.db.add(existing)
            next_version = int(existing.version or 0) + 1

        now = datetime.utcnow()
        record = MindMap(
            tenant_id=tenant_id,
            created_by_user_id=user_id,
            workroom_id=workroom_id,
            source_type=source_type,
            source_id=source_id,
            source_signature=source_signature,
            kind=kind,
            title=title,
            graph_json=graph_json,
            version=next_version,
            is_active=1,
            created_at=now,
            updated_at=now,
        )
        self.db.add(record)
        self.db.flush()
        return record

    def update_map_content(
        self,
        *,
        tenant_id: int,
        workroom_id: int,
        mindmap_id: int,
        graph_json: dict,
        title: str | None,
    ) -> MindMap | None:
        record = (
            self.db.query(MindMap)
            .filter(
                MindMap.id == mindmap_id,
                MindMap.tenant_id == tenant_id,
                MindMap.workroom_id == workroom_id,
            )
            .first()
        )
        if record is None:
            return None
        record.graph_json = graph_json
        record.title = title
        record.updated_at = datetime.utcnow()
        self.db.add(record)
        self.db.flush()
        return record

    def get_document(self, *, tenant_id: int, document_id: int) -> Document | None:
        return (
            self.db.query(Document)
            .filter(Document.id == document_id, Document.tenant_id == tenant_id)
            .first()
        )

    def list_document_questions(self, *, tenant_id: int, document_id: int) -> list[Question]:
        return (
            self.db.query(Question)
            .join(Document, Document.id == Question.document_id)
            .filter(Question.document_id == document_id, Document.tenant_id == tenant_id)
            .order_by(Question.sequence_index.asc(), Question.id.asc())
            .all()
        )

    def get_file(self, *, tenant_id: int, file_id: int) -> File | None:
        return self.db.query(File).filter(File.id == file_id, File.tenant_id == tenant_id).first()

    def list_file_blocks(self, *, tenant_id: int, file_id: int, limit: int = 24) -> list[FulltextBlock]:
        return (
            self.db.query(FulltextBlock)
            .join(File, File.id == FulltextBlock.file_id)
            .filter(FulltextBlock.file_id == file_id)
            .filter(File.tenant_id == tenant_id)
            .order_by(FulltextBlock.page_num.asc(), FulltextBlock.block_index.asc())
            .limit(limit)
            .all()
        )
