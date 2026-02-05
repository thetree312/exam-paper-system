import json
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import MindMap
from .agent_v2 import (
    MindMapNode,
    MindMapEdge,
    MindMapResponse,
    MindMapRequest,
    _generate_mindmap_core,
    ensure_question_flag,
)

router = APIRouter(prefix="/api/mindmaps", tags=["mindmaps"])


class MindMapSource(BaseModel):
    tenant_id: int
    user_id: Optional[int] = None
    source_type: str  # e.g. exam_document, uploaded_file
    source_id: int
    kind: str = "knowledge"


class MindMapGenerateRequest(MindMapSource):
    force: bool = False


def _find_active_mindmap(
    db: Session, tenant_id: int, source_type: str, source_id: int, kind: str
) -> Optional[MindMap]:
    return (
        db.query(MindMap)
        .filter(
            MindMap.tenant_id == tenant_id,
            MindMap.source_type == source_type,
            MindMap.source_id == source_id,
            MindMap.kind == kind,
            MindMap.is_active == 1,
        )
        .order_by(MindMap.version.desc())
        .first()
    )


@router.post("/generate", response_model=MindMapResponse)
def generate_mindmap_generic(
    payload: MindMapGenerateRequest, db: Session = Depends(get_db)
) -> MindMapResponse:
    """通用思维导图生成接口。

    目前支持的 source_type：
    - exam_document: 基于试卷 Document（document_id == source_id）
    - uploaded_file: 基于原始文件 File（file_id == source_id）
    """

    existing = None if payload.force else _find_active_mindmap(
        db,
        tenant_id=payload.tenant_id,
        source_type=payload.source_type,
        source_id=payload.source_id,
        kind=payload.kind,
    )
    if existing is not None:
        data = ensure_question_flag(existing.graph_json or {})
        # 标记为缓存命中
        return MindMapResponse(**data, cached=True)

    # 映射到旧的 MindMapRequest，复用核心生成逻辑
    if payload.source_type == "exam_document":
        core_req = MindMapRequest(mode="document", document_id=payload.source_id)
    elif payload.source_type == "uploaded_file":
        core_req = MindMapRequest(mode="file", file_id=payload.source_id)
    else:
        raise HTTPException(status_code=400, detail="不支持的 source_type")

    resp = _generate_mindmap_core(core_req, db)

    # 写入 mindmaps 版本库
    latest = _find_active_mindmap(
        db,
        tenant_id=payload.tenant_id,
        source_type=payload.source_type,
        source_id=payload.source_id,
        kind=payload.kind,
    )
    next_version = (latest.version + 1) if latest is not None else 1

    # 取消旧版本激活
    if latest is not None:
        latest.is_active = 0
        db.add(latest)

    graph_json = resp.model_dump(exclude={"cached"})

    record = MindMap(
        tenant_id=payload.tenant_id,
        created_by_user_id=payload.user_id,
        source_type=payload.source_type,
        source_id=payload.source_id,
        kind=payload.kind,
        title=None,
        graph_json=graph_json,
        version=next_version,
        is_active=1,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(record)
    db.commit()

    return resp


class MindMapSaveRequest(MindMapSource):
    map_id: Optional[int] = None
    root_id: Optional[str] = None
    nodes: List[MindMapNode]
    edges: List[MindMapEdge]


@router.post("/save", response_model=MindMapResponse)
def save_mindmap_generic(
    payload: MindMapSaveRequest, db: Session = Depends(get_db)
) -> MindMapResponse:
    """通用思维导图保存接口，用于前端编辑后的整图持久化。"""

    existing = _find_active_mindmap(
        db,
        tenant_id=payload.tenant_id,
        source_type=payload.source_type,
        source_id=payload.source_id,
        kind=payload.kind,
    )

    next_version = 1
    if existing is not None:
        next_version = existing.version + 1
        existing.is_active = 0
        db.add(existing)

    graph_json = ensure_question_flag({
        "root_id": payload.root_id,
        "nodes": [n.model_dump() for n in payload.nodes],
        "edges": [e.model_dump() for e in payload.edges],
    })

    record = MindMap(
        tenant_id=payload.tenant_id,
        created_by_user_id=payload.user_id,
        source_type=payload.source_type,
        source_id=payload.source_id,
        kind=payload.kind,
        title=None,
        graph_json=graph_json,
        version=next_version,
        is_active=1,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(record)
    db.commit()

    return MindMapResponse(**graph_json, cached=True)
