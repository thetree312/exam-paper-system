"""收藏题目 API 路由"""

import json
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..services.favorite_service import FavoriteService


router = APIRouter(prefix="/api/questions/favorites", tags=["favorites"])


# ===== Request/Response Schemas =====


class AddFavoriteRequest(BaseModel):
    tenant_id: int
    user_id: int
    question_id: int
    question_type_id: int | None = None
    subject_id: int | None = None
    tag_ids: list[int] | None = None


class FavoriteQuestionOut(BaseModel):
    """收藏列表中的题目信息"""

    id: int
    document_id: int
    sequence_index: int
    content: str
    legend_images: List[str] = Field(default_factory=list)
    page: Optional[int] = None
    created_at: datetime
    updated_at: datetime


class QuestionTypeOut(BaseModel):
    """题型信息"""

    id: int
    name: str


class SubjectOut(BaseModel):
    """科目信息"""

    id: int
    name: str


class TagOut(BaseModel):
    """标签信息"""

    id: int
    name: str


class FavoriteItemOut(BaseModel):
    """收藏列表项"""

    id: int
    question_id: int
    question: FavoriteQuestionOut
    question_type: Optional[QuestionTypeOut] = None
    subject: Optional[SubjectOut] = None
    tags: List[TagOut] = Field(default_factory=list)
    created_at: datetime


class AddFavoriteResponse(BaseModel):
    id: int
    question_id: int
    created_at: datetime


class RemoveFavoriteResponse(BaseModel):
    success: bool


class CheckFavoriteResponse(BaseModel):
    is_favorited: bool


class FavoriteQuotaResponse(BaseModel):
    max_favorites: int
    current_count: int
    remaining: int


class FavoritesListResponse(BaseModel):
    total: int
    page: int
    page_size: int
    items: List[FavoriteItemOut]


# ===== Helper Functions =====


def _parse_legend_images(legend_json: Optional[str]) -> List[str]:
    """解析 legend_images JSON 字符串"""
    if not legend_json:
        return []
    try:
        val = json.loads(legend_json)
        if isinstance(val, list):
            return [str(x) for x in val]
    except Exception:
        pass
    return []


def _build_favorite_item(favorite) -> FavoriteItemOut:
    """构建收藏列表项响应"""
    question = favorite.question
    
    # 构建题型信息
    question_type = None
    if favorite.question_type:
        question_type = QuestionTypeOut(
            id=favorite.question_type.id,
            name=favorite.question_type.name,
        )
    
    # 构建科目信息
    subject = None
    if favorite.subject:
        subject = SubjectOut(
            id=favorite.subject.id,
            name=favorite.subject.name,
        )
    
    # 构建标签列表
    tags = [
        TagOut(id=tag.id, name=tag.name)
        for tag in favorite.tags
    ]
    
    return FavoriteItemOut(
        id=favorite.id,
        question_id=favorite.question_id,
        question=FavoriteQuestionOut(
            id=question.id,
            document_id=question.document_id,
            sequence_index=question.sequence_index,
            content=question.content,
            legend_images=_parse_legend_images(question.legend_images),
            page=question.page,
            created_at=question.created_at,
            updated_at=question.updated_at,
        ),
        question_type=question_type,
        subject=subject,
        tags=tags,
        created_at=favorite.created_at,
    )


# ===== API Endpoints =====


@router.post("", response_model=AddFavoriteResponse)
def add_favorite(
    payload: AddFavoriteRequest,
    db: Session = Depends(get_db),
):
    """收藏题目
    
    错误码:
    - 404: 题目不存在
    - 409: 已收藏
    - 402: 超过配额
    - 403: 无权访问题型/科目/标签
    """
    service = FavoriteService(db)
    favorite = service.add_favorite(
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        question_id=payload.question_id,
        question_type_id=payload.question_type_id,
        subject_id=payload.subject_id,
        tag_ids=payload.tag_ids,
    )
    return AddFavoriteResponse(
        id=favorite.id,
        question_id=favorite.question_id,
        created_at=favorite.created_at,
    )


@router.get("/quota", response_model=FavoriteQuotaResponse)
def get_favorite_quota(
    tenant_id: int = Query(..., description="租户 ID"),
    user_id: int = Query(..., description="用户 ID"),
    db: Session = Depends(get_db),
):
    """获取收藏配额信息"""
    service = FavoriteService(db)
    quota = service.get_quota(tenant_id=tenant_id, user_id=user_id)
    return FavoriteQuotaResponse(
        max_favorites=quota["max_favorites"],
        current_count=quota["current_count"],
        remaining=quota["remaining"],
    )


@router.get("/{question_id}/check", response_model=CheckFavoriteResponse)
def check_favorite(
    question_id: int,
    tenant_id: int = Query(..., description="租户 ID"),
    user_id: int = Query(..., description="用户 ID"),
    db: Session = Depends(get_db),
):
    """检查题目是否已收藏"""
    service = FavoriteService(db)
    is_favorited = service.is_favorited(
        tenant_id=tenant_id,
        user_id=user_id,
        question_id=question_id,
    )
    return CheckFavoriteResponse(is_favorited=is_favorited)


@router.delete("/{question_id}", response_model=RemoveFavoriteResponse)
def remove_favorite(
    question_id: int,
    tenant_id: int = Query(..., description="租户 ID"),
    user_id: int = Query(..., description="用户 ID"),
    db: Session = Depends(get_db),
):
    """取消收藏
    
    错误码:
    - 404: 收藏记录不存在
    """
    service = FavoriteService(db)
    service.remove_favorite(
        tenant_id=tenant_id,
        user_id=user_id,
        question_id=question_id,
    )
    return RemoveFavoriteResponse(success=True)


@router.get("", response_model=FavoritesListResponse)
def get_favorites(
    tenant_id: int = Query(..., description="租户 ID"),
    user_id: int = Query(..., description="用户 ID"),
    page: int = Query(1, ge=1, description="页码"),
    page_size: int = Query(20, ge=1, le=100, description="每页数量"),
    db: Session = Depends(get_db),
):
    """获取收藏列表（分页）"""
    service = FavoriteService(db)
    total, favorites = service.get_favorites(
        tenant_id=tenant_id,
        user_id=user_id,
        page=page,
        page_size=page_size,
    )
    return FavoritesListResponse(
        total=total,
        page=page,
        page_size=page_size,
        items=[_build_favorite_item(f) for f in favorites],
    )
