"""标签业务服务层"""

import logging
from typing import List, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..models import Tag

logger = logging.getLogger("tags")


class TagService:
    """标签业务服务"""

    def __init__(self, db: Session) -> None:
        self.db = db

    def get_tags(self, tenant_id: int) -> List[Tag]:
        """获取租户的所有标签
        
        Args:
            tenant_id: 租户 ID
            
        Returns:
            List[Tag]: 标签列表
        """
        return (
            self.db.query(Tag)
            .filter(Tag.tenant_id == tenant_id)
            .order_by(Tag.created_at.desc())
            .all()
        )

    def get_or_create(self, tenant_id: int, name: str) -> Tag:
        """获取或创建标签（防止重复）
        
        Args:
            tenant_id: 租户 ID
            name: 标签名称
            
        Returns:
            Tag: 标签对象
        """
        # 检查是否已存在
        existing = (
            self.db.query(Tag)
            .filter(
                Tag.tenant_id == tenant_id,
                Tag.name == name,
            )
            .first()
        )

        if existing:
            logger.info(
                "tag already exists: tenant=%s name=%s id=%s",
                tenant_id,
                name,
                existing.id,
            )
            return existing

        # 创建新标签
        tag = Tag(tenant_id=tenant_id, name=name)
        self.db.add(tag)
        self.db.commit()
        self.db.refresh(tag)

        logger.info(
            "tag created: tenant=%s name=%s id=%s",
            tenant_id,
            name,
            tag.id,
        )
        return tag

    def create_tag(self, tenant_id: int, name: str) -> Tag:
        """创建新标签
        
        Args:
            tenant_id: 租户 ID
            name: 标签名称
            
        Returns:
            Tag: 创建的标签对象
            
        Raises:
            HTTPException: 409 如果标签已存在
        """
        # 检查是否已存在
        existing = (
            self.db.query(Tag)
            .filter(
                Tag.tenant_id == tenant_id,
                Tag.name == name,
            )
            .first()
        )

        if existing:
            raise HTTPException(status_code=409, detail="该标签已存在")

        # 创建新标签
        tag = Tag(tenant_id=tenant_id, name=name)
        self.db.add(tag)
        self.db.commit()
        self.db.refresh(tag)

        logger.info(
            "tag created: tenant=%s name=%s id=%s",
            tenant_id,
            name,
            tag.id,
        )
        return tag

    def get_by_id(self, tenant_id: int, tag_id: int) -> Optional[Tag]:
        """根据 ID 获取标签
        
        Args:
            tenant_id: 租户 ID
            tag_id: 标签 ID
            
        Returns:
            Optional[Tag]: 标签对象，不存在返回 None
        """
        return (
            self.db.query(Tag)
            .filter(
                Tag.tenant_id == tenant_id,
                Tag.id == tag_id,
            )
            .first()
        )

    def get_by_ids(self, tenant_id: int, tag_ids: List[int]) -> List[Tag]:
        """根据 ID 列表获取标签
        
        Args:
            tenant_id: 租户 ID
            tag_ids: 标签 ID 列表
            
        Returns:
            List[Tag]: 标签列表
        """
        if not tag_ids:
            return []

        return (
            self.db.query(Tag)
            .filter(
                Tag.tenant_id == tenant_id,
                Tag.id.in_(tag_ids),
            )
            .all()
        )
