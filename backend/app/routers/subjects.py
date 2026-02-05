"""科目 API 路由"""

from datetime import datetime
from typing import List

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..services.subject_service import SubjectService


router = APIRouter(prefix="/api/subjects", tags=["subjects"])


# ===== Request/Response Schemas =====


class SubjectOut(BaseModel):
    """科目响应"""

    id: int
    name: str
    created_at: datetime


class SubjectListResponse(BaseModel):
    """科目列表响应"""

    items: List[SubjectOut] = Field(default_factory=list)


class CreateSubjectRequest(BaseModel):
    """创建科目请求"""

    tenant_id: int
    name: str = Field(..., min_length=1, max_length=100)


# ===== API Endpoints =====


@router.get("", response_model=SubjectListResponse)
def get_subjects(
    tenant_id: int = Query(..., description="租户 ID"),
    db: Session = Depends(get_db),
):
    """获取租户的所有科目
    
    Args:
        tenant_id: 租户 ID
        
    Returns:
        SubjectListResponse: 科目列表
    """
    service = SubjectService(db)
    subjects = service.get_subjects(tenant_id=tenant_id)
    return SubjectListResponse(
        items=[
            SubjectOut(
                id=s.id,
                name=s.name,
                created_at=s.created_at,
            )
            for s in subjects
        ]
    )


@router.post("", response_model=SubjectOut)
def create_subject(
    payload: CreateSubjectRequest,
    db: Session = Depends(get_db),
):
    """创建新科目
    
    如果科目已存在，返回已存在的科目（get_or_create 模式）
    
    Args:
        payload: 创建请求
        
    Returns:
        SubjectOut: 创建的科目
        
    Errors:
        - 409: 科目已存在（仅在 create_subject 时返回）
    """
    service = SubjectService(db)
    # 使用 get_or_create 防止重复创建
    subject = service.get_or_create(
        tenant_id=payload.tenant_id,
        name=payload.name,
    )
    return SubjectOut(
        id=subject.id,
        name=subject.name,
        created_at=subject.created_at,
    )
