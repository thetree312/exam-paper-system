"""科目业务服务层"""

import logging
from typing import List, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..models import Subject

logger = logging.getLogger("subjects")


class SubjectService:
    """科目业务服务"""

    def __init__(self, db: Session) -> None:
        self.db = db

    def get_subjects(self, tenant_id: int) -> List[Subject]:
        """获取租户的所有科目
        
        Args:
            tenant_id: 租户 ID
            
        Returns:
            List[Subject]: 科目列表
        """
        return (
            self.db.query(Subject)
            .filter(Subject.tenant_id == tenant_id)
            .order_by(Subject.created_at.desc())
            .all()
        )

    def get_or_create(self, tenant_id: int, name: str) -> Subject:
        """获取或创建科目（防止重复）
        
        Args:
            tenant_id: 租户 ID
            name: 科目名称
            
        Returns:
            Subject: 科目对象
        """
        # 检查是否已存在
        existing = (
            self.db.query(Subject)
            .filter(
                Subject.tenant_id == tenant_id,
                Subject.name == name,
            )
            .first()
        )

        if existing:
            logger.info(
                "subject already exists: tenant=%s name=%s id=%s",
                tenant_id,
                name,
                existing.id,
            )
            return existing

        # 创建新科目
        subject = Subject(tenant_id=tenant_id, name=name)
        self.db.add(subject)
        self.db.commit()
        self.db.refresh(subject)

        logger.info(
            "subject created: tenant=%s name=%s id=%s",
            tenant_id,
            name,
            subject.id,
        )
        return subject

    def create_subject(self, tenant_id: int, name: str) -> Subject:
        """创建新科目
        
        Args:
            tenant_id: 租户 ID
            name: 科目名称
            
        Returns:
            Subject: 创建的科目对象
            
        Raises:
            HTTPException: 409 如果科目已存在
        """
        # 检查是否已存在
        existing = (
            self.db.query(Subject)
            .filter(
                Subject.tenant_id == tenant_id,
                Subject.name == name,
            )
            .first()
        )

        if existing:
            raise HTTPException(status_code=409, detail="该科目已存在")

        # 创建新科目
        subject = Subject(tenant_id=tenant_id, name=name)
        self.db.add(subject)
        self.db.commit()
        self.db.refresh(subject)

        logger.info(
            "subject created: tenant=%s name=%s id=%s",
            tenant_id,
            name,
            subject.id,
        )
        return subject

    def get_by_id(self, tenant_id: int, subject_id: int) -> Optional[Subject]:
        """根据 ID 获取科目
        
        Args:
            tenant_id: 租户 ID
            subject_id: 科目 ID
            
        Returns:
            Optional[Subject]: 科目对象，不存在返回 None
        """
        return (
            self.db.query(Subject)
            .filter(
                Subject.tenant_id == tenant_id,
                Subject.id == subject_id,
            )
            .first()
        )
