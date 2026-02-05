"""题目业务服务层"""

import json
import logging
from typing import List, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session, selectinload

from ..models import Question, QuestionFavorite

logger = logging.getLogger("questions")


class QuestionService:
    """题目业务服务"""

    def __init__(self, db: Session) -> None:
        self.db = db

    def get_question(
        self,
        tenant_id: int,
        question_id: int,
        include_legend: bool = True,
    ) -> dict:
        """获取题目详情
        
        Args:
            tenant_id: 租户 ID
            question_id: 题目 ID
            include_legend: 是否包含图例
            
        Returns:
            dict: 题目详情
            
        Raises:
            HTTPException: 404 题目不存在, 403 无权访问
        """
        # 使用复合索引快速查询
        question = (
            self.db.query(Question)
            .filter(
                Question.tenant_id == tenant_id,
                Question.id == question_id,
            )
            .options(
                selectinload(Question.document)
            )
            .first()
        )

        if question is None:
            logger.warning(
                "get_question: question not found or access denied",
                extra={
                    "tenant_id": tenant_id,
                    "question_id": question_id,
                }
            )
            raise HTTPException(status_code=404, detail="题目不存在")

        # 解析图例
        legend_images: List[str] = []
        if include_legend:
            try:
                if question.legend_images:
                    legend_data = json.loads(question.legend_images)
                    if isinstance(legend_data, list):
                        legend_images = [str(x) for x in legend_data]
            except (json.JSONDecodeError, TypeError):
                logger.warning(
                    "get_question: failed to parse legend_images",
                    extra={
                        "question_id": question_id,
                        "legend_images": question.legend_images,
                    }
                )

        result = {
            "id": question.id,
            "content": question.content,
            "legend_images": legend_images,
            "page": question.page,
            "document_id": question.document_id,
            "created_at": question.created_at.isoformat(),
            "updated_at": question.updated_at.isoformat(),
        }

        logger.info(
            "get_question: success",
            extra={
                "tenant_id": tenant_id,
                "question_id": question_id,
            }
        )

        return result

    def check_user_access(
        self,
        tenant_id: int,
        user_id: int,
        question_id: int,
    ) -> bool:
        """检查用户是否有权访问题目
        
        当前实现：只要题目属于该租户，用户就有权访问
        可以扩展为检查用户是否收藏或其他权限
        
        Args:
            tenant_id: 租户 ID
            user_id: 用户 ID
            question_id: 题目 ID
            
        Returns:
            bool: True 表示有权访问
        """
        # 检查题目是否属于该租户
        question = (
            self.db.query(Question.id)
            .filter(
                Question.tenant_id == tenant_id,
                Question.id == question_id,
            )
            .first()
        )
        return question is not None
