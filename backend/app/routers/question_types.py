"""题型 API 路由"""

from datetime import datetime
from typing import List

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..services.question_type_service import QuestionTypeService


router = APIRouter(prefix="/api/question-types", tags=["question-types"])


# ===== Request/Response Schemas =====


class QuestionTypeOut(BaseModel):
    """题型响应"""

    id: int
    name: str
    created_at: datetime


class QuestionTypeListResponse(BaseModel):
    """题型列表响应"""

    items: List[QuestionTypeOut] = Field(default_factory=list)


class CreateQuestionTypeRequest(BaseModel):
    """创建题型请求"""

    tenant_id: int
    name: str = Field(..., min_length=1, max_length=100)


# ===== API Endpoints =====


@router.get("", response_model=QuestionTypeListResponse)
def get_question_types(
    tenant_id: int = Query(..., description="租户 ID"),
    db: Session = Depends(get_db),
):
    """获取租户的所有题型
    
    Args:
        tenant_id: 租户 ID
        
    Returns:
        QuestionTypeListResponse: 题型列表
    """
    service = QuestionTypeService(db)
    types = service.get_types(tenant_id=tenant_id)
    return QuestionTypeListResponse(
        items=[
            QuestionTypeOut(
                id=t.id,
                name=t.name,
                created_at=t.created_at,
            )
            for t in types
        ]
    )


@router.post("", response_model=QuestionTypeOut)
def create_question_type(
    payload: CreateQuestionTypeRequest,
    db: Session = Depends(get_db),
):
    """创建新题型
    
    如果题型已存在，返回已存在的题型（get_or_create 模式）
    
    Args:
        payload: 创建请求
        
    Returns:
        QuestionTypeOut: 创建的题型
        
    Errors:
        - 409: 题型已存在（仅在 create_type 时返回）
    """
    service = QuestionTypeService(db)
    # 使用 get_or_create 防止重复创建
    question_type = service.get_or_create(
        tenant_id=payload.tenant_id,
        name=payload.name,
    )
    return QuestionTypeOut(
        id=question_type.id,
        name=question_type.name,
        created_at=question_type.created_at,
    )
