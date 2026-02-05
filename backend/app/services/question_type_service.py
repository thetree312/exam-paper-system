"""题型业务服务层"""

import logging
from typing import List, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..models import QuestionType

logger = logging.getLogger("question_types")


class QuestionTypeService:
    """题型业务服务"""

    def __init__(self, db: Session) -> None:
        self.db = db

    def get_types(self, tenant_id: int) -> List[QuestionType]:
        """获取租户的所有题型
        
        Args:
            tenant_id: 租户 ID
            
        Returns:
            List[QuestionType]: 题型列表
        """
        return (
            self.db.query(QuestionType)
            .filter(QuestionType.tenant_id == tenant_id)
            .order_by(QuestionType.created_at.desc())
            .all()
        )

    def get_or_create(self, tenant_id: int, name: str) -> QuestionType:
        """获取或创建题型（防止重复）
        
        Args:
            tenant_id: 租户 ID
            name: 题型名称
            
        Returns:
            QuestionType: 题型对象
        """
        # 检查是否已存在
        existing = (
            self.db.query(QuestionType)
            .filter(
                QuestionType.tenant_id == tenant_id,
                QuestionType.name == name,
            )
            .first()
        )

        if existing:
            logger.info(
                "question_type already exists: tenant=%s name=%s id=%s",
                tenant_id,
                name,
                existing.id,
            )
            return existing

        # 创建新题型
        question_type = QuestionType(tenant_id=tenant_id, name=name)
        self.db.add(question_type)
        self.db.commit()
        self.db.refresh(question_type)

        logger.info(
            "question_type created: tenant=%s name=%s id=%s",
            tenant_id,
            name,
            question_type.id,
        )
        return question_type

    def create_type(self, tenant_id: int, name: str) -> QuestionType:
        """创建新题型
        
        Args:
            tenant_id: 租户 ID
            name: 题型名称
            
        Returns:
            QuestionType: 创建的题型对象
            
        Raises:
            HTTPException: 409 如果题型已存在
        """
        # 检查是否已存在
        existing = (
            self.db.query(QuestionType)
            .filter(
                QuestionType.tenant_id == tenant_id,
                QuestionType.name == name,
            )
            .first()
        )

        if existing:
            raise HTTPException(status_code=409, detail="该题型已存在")

        # 创建新题型
        question_type = QuestionType(tenant_id=tenant_id, name=name)
        self.db.add(question_type)
        self.db.commit()
        self.db.refresh(question_type)

        logger.info(
            "question_type created: tenant=%s name=%s id=%s",
            tenant_id,
            name,
            question_type.id,
        )
        return question_type

    def get_by_id(self, tenant_id: int, question_type_id: int) -> Optional[QuestionType]:
        """根据 ID 获取题型
        
        Args:
            tenant_id: 租户 ID
            question_type_id: 题型 ID
            
        Returns:
            Optional[QuestionType]: 题型对象，不存在返回 None
        """
        return (
            self.db.query(QuestionType)
            .filter(
                QuestionType.tenant_id == tenant_id,
                QuestionType.id == question_type_id,
            )
            .first()
        )
