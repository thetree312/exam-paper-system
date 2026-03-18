from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..models import Document, Workroom


def assert_workroom_scope(
    *,
    db: Session,
    tenant_id: int,
    user_id: int,
    workroom_id: int,
) -> Workroom:
    workroom = (
        db.query(Workroom)
        .filter(
            Workroom.id == workroom_id,
            Workroom.tenant_id == tenant_id,
            Workroom.user_id == user_id,
        )
        .first()
    )
    if workroom is None:
        raise HTTPException(status_code=404, detail="workroom_not_found")
    return workroom


def assert_studio_document_scope(
    *,
    db: Session,
    tenant_id: int,
    user_id: int,
    workroom_id: int,
    studio_document_id: int | None,
) -> Document | None:
    if studio_document_id is None:
        return None

    document = (
        db.query(Document)
        .filter(
            Document.id == studio_document_id,
            Document.tenant_id == tenant_id,
        )
        .first()
    )
    if document is None:
        raise HTTPException(status_code=404, detail="studio_document_not_found")

    if document.owner_user_id is not None and int(document.owner_user_id) != int(user_id):
        raise HTTPException(status_code=403, detail="studio_document_forbidden")

    # Tolerate legacy documents that were created before workroom binding existed.
    if document.workroom_id is not None and int(document.workroom_id) != int(workroom_id):
        raise HTTPException(status_code=403, detail="studio_document_out_of_scope")

    return document


__all__ = ["assert_workroom_scope", "assert_studio_document_scope"]

