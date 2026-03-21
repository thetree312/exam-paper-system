from __future__ import annotations

import logging

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db import get_db
from ..services.workroom_scope_service import assert_studio_document_scope, assert_workroom_scope
from ..services.mindmap import MindMapService
from ..services.mindmap.schemas import (
    MindMapCurrentQuery,
    MindMapDocument,
    MindMapGenerateRequest,
    MindMapSaveRequest,
)


router = APIRouter(prefix="/api/mindmaps", tags=["mindmaps"])
logger = logging.getLogger("mindmap.router")


@router.post("/generate", response_model=MindMapDocument)
def generate_mindmap(payload: MindMapGenerateRequest, db: Session = Depends(get_db)) -> MindMapDocument:
    assert_workroom_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
    )
    if payload.source_type == "exam_document":
        assert_studio_document_scope(
            db=db,
            tenant_id=payload.tenant_id,
            user_id=payload.user_id,
            workroom_id=payload.workroom_id,
            studio_document_id=payload.source_id,
        )
    logger.info(
        "mindmap.route.generate tenant_id=%s user_id=%s workroom_id=%s source_type=%s source_id=%s kind=%s force=%s",
        payload.tenant_id,
        payload.user_id,
        payload.workroom_id,
        payload.source_type,
        payload.source_id,
        payload.kind,
        payload.force,
    )
    return MindMapService(db).generate(
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        source_type=payload.source_type,
        source_id=payload.source_id,
        kind=payload.kind,
        force=payload.force,
    )


@router.get("/current", response_model=MindMapDocument)
def get_current_mindmap(
    tenant_id: int,
    user_id: int,
    workroom_id: int,
    source_type: str,
    source_id: int,
    kind: str = "knowledge",
    db: Session = Depends(get_db),
) -> MindMapDocument:
    assert_workroom_scope(
        db=db,
        tenant_id=tenant_id,
        user_id=user_id,
        workroom_id=workroom_id,
    )
    if source_type == "exam_document":
        assert_studio_document_scope(
            db=db,
            tenant_id=tenant_id,
            user_id=user_id,
            workroom_id=workroom_id,
            studio_document_id=source_id,
        )
    logger.info(
        "mindmap.route.current tenant_id=%s user_id=%s workroom_id=%s source_type=%s source_id=%s kind=%s",
        tenant_id,
        user_id,
        workroom_id,
        source_type,
        source_id,
        kind,
    )
    query = MindMapCurrentQuery(
        tenant_id=tenant_id,
        user_id=user_id,
        workroom_id=workroom_id,
        source_type=source_type,
        source_id=source_id,
        kind=kind,
    )
    return MindMapService(db).get_current(
        tenant_id=query.tenant_id,
        workroom_id=query.workroom_id,
        source_type=query.source_type,
        source_id=query.source_id,
        kind=query.kind,
    )


@router.put("/{mindmap_id}", response_model=MindMapDocument)
def save_mindmap(
    mindmap_id: int,
    payload: MindMapSaveRequest,
    db: Session = Depends(get_db),
) -> MindMapDocument:
    assert_workroom_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
    )
    if payload.document.source.type == "exam_document":
        assert_studio_document_scope(
            db=db,
            tenant_id=payload.tenant_id,
            user_id=payload.user_id,
            workroom_id=payload.workroom_id,
            studio_document_id=payload.document.source.id,
        )
    logger.info(
        "mindmap.route.save tenant_id=%s user_id=%s workroom_id=%s mindmap_id=%s source_type=%s source_id=%s",
        payload.tenant_id,
        payload.user_id,
        payload.workroom_id,
        mindmap_id,
        payload.document.source.type,
        payload.document.source.id,
    )
    return MindMapService(db).save(
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        mindmap_id=mindmap_id,
        document=payload.document,
    )
