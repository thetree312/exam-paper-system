"""题目 API 路由"""

import time
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..services.question_service import QuestionService

router = APIRouter(prefix="/api/questions", tags=["questions"])


# ===== Request/Response Schemas =====


class QuestionDetailResponse(BaseModel):
    """题目详情响应"""

    id: int
    content: str
    legend_images: List[str] = Field(default_factory=list)
    page: Optional[int] = None
    document_id: int
    created_at: str
    updated_at: str


# ===== API Endpoints =====


@router.get("/{question_id}", response_model=QuestionDetailResponse)
def get_question(
    question_id: int,
    tenant_id: int = Query(..., description="租户 ID"),
    include_legend: bool = Query(True, description="是否包含图例"),
    db: Session = Depends(get_db),
):
    """获取题目详情
    
    Args:
        question_id: 题目 ID
        tenant_id: 租户 ID
        include_legend: 是否包含图例（默认 true）
        
    Returns:
        QuestionDetailResponse: 题目详情
        
    Errors:
        - 404: 题目不存在
        - 403: 无权访问题目
    """
    start_time = time.time()
    
    try:
        service = QuestionService(db)
        question_data = service.get_question(
            tenant_id=tenant_id,
            question_id=question_id,
            include_legend=include_legend,
        )
        
        duration = time.time() - start_time
        
        # 记录性能指标
        if duration > 0.2:  # 超过 200ms 记录警告
            import logging
            logger = logging.getLogger("questions")
            logger.warning(
                "get_question: slow query",
                extra={
                    "question_id": question_id,
                    "tenant_id": tenant_id,
                    "duration_ms": duration * 1000,
                }
            )
        
        return QuestionDetailResponse(**question_data)
    
    except Exception as e:
        duration = time.time() - start_time
        import logging
        logger = logging.getLogger("questions")
        logger.error(
            f"get_question: error - {e}",
            extra={
                "question_id": question_id,
                "tenant_id": tenant_id,
                "duration_ms": duration * 1000,
            }
        )
        raise
