"""标签 API 路由"""

from datetime import datetime
from typing import List

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..services.tag_service import TagService


router = APIRouter(prefix="/api/tags", tags=["tags"])


# ===== Request/Response Schemas =====


class TagOut(BaseModel):
    """标签响应"""

    id: int
    name: str
    created_at: datetime


class TagListResponse(BaseModel):
    """标签列表响应"""

    items: List[TagOut] = Field(default_factory=list)


class CreateTagRequest(BaseModel):
    """创建标签请求"""

    tenant_id: int
    name: str = Field(..., min_length=1, max_length=100)


# ===== API Endpoints =====


@router.get("", response_model=TagListResponse)
def get_tags(
    tenant_id: int = Query(..., description="租户 ID"),
    db: Session = Depends(get_db),
):
    """获取租户的所有标签
    
    Args:
        tenant_id: 租户 ID
        
    Returns:
        TagListResponse: 标签列表
    """
    service = TagService(db)
    tags = service.get_tags(tenant_id=tenant_id)
    return TagListResponse(
        items=[
            TagOut(
                id=t.id,
                name=t.name,
                created_at=t.created_at,
            )
            for t in tags
        ]
    )


@router.post("", response_model=TagOut)
def create_tag(
    payload: CreateTagRequest,
    db: Session = Depends(get_db),
):
    """创建新标签
    
    如果标签已存在，返回已存在的标签（get_or_create 模式）
    
    Args:
        payload: 创建请求
        
    Returns:
        TagOut: 创建的标签
        
    Errors:
        - 409: 标签已存在（仅在 create_tag 时返回）
    """
    service = TagService(db)
    # 使用 get_or_create 防止重复创建
    tag = service.get_or_create(
        tenant_id=payload.tenant_id,
        name=payload.name,
    )
    return TagOut(
        id=tag.id,
        name=tag.name,
        created_at=tag.created_at,
    )
