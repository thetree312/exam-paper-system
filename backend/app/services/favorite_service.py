"""收藏题目业务服务层"""

import logging
from datetime import datetime
from typing import List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from ..models import (
    Plan,
    Question,
    QuestionFavorite,
    QuestionType,
    Subject,
    Tag,
    Subscription,
    User,
)

logger = logging.getLogger("favorites")


class FavoriteService:
    """收藏题目业务服务"""

    def __init__(self, db: Session) -> None:
        self.db = db

    def _get_user_plan(self, tenant_id: int, user_id: int) -> Optional[Plan]:
        """获取用户当前有效订阅的计划"""
        now = datetime.utcnow()
        subscription = (
            self.db.query(Subscription)
            .filter(
                Subscription.tenant_id == tenant_id,
                Subscription.status.in_(("trialing", "active")),
                Subscription.current_period_start <= now,
                Subscription.current_period_end >= now,
            )
            .first()
        )
        if subscription is None:
            return None
        return subscription.plan

    def _get_favorite_count(self, tenant_id: int, user_id: int) -> int:
        """获取用户当前收藏数量"""
        return (
            self.db.query(func.count(QuestionFavorite.id))
            .filter(
                QuestionFavorite.tenant_id == tenant_id,
                QuestionFavorite.user_id == user_id,
            )
            .scalar()
            or 0
        )

    def get_quota(self, tenant_id: int, user_id: int) -> dict:
        """获取用户收藏配额信息
        
        Returns:
            dict: {
                "max_favorites": int,  # 最大收藏数，-1 表示无限
                "current_count": int,  # 当前收藏数
                "remaining": int,      # 剩余可收藏数，-1 表示无限
            }
        """
        plan = self._get_user_plan(tenant_id, user_id)
        if plan is None:
            # 无有效订阅，使用默认免费配额
            max_favorites = 1000
        else:
            max_favorites = plan.max_favorite_questions

        current_count = self._get_favorite_count(tenant_id, user_id)

        # max_favorites = -1 表示无限
        if max_favorites == -1:
            remaining = -1
        else:
            remaining = max(0, max_favorites - current_count)

        return {
            "max_favorites": max_favorites,
            "current_count": current_count,
            "remaining": remaining,
        }

    def check_quota(self, tenant_id: int, user_id: int) -> bool:
        """检查用户是否还有收藏配额
        
        Returns:
            bool: True 表示还有配额，False 表示已达上限
        """
        quota = self.get_quota(tenant_id, user_id)
        # -1 表示无限
        if quota["remaining"] == -1:
            return True
        return quota["remaining"] > 0

    def is_favorited(self, tenant_id: int, user_id: int, question_id: int) -> bool:
        """检查题目是否已被收藏"""
        exists = (
            self.db.query(QuestionFavorite.id)
            .filter(
                QuestionFavorite.tenant_id == tenant_id,
                QuestionFavorite.user_id == user_id,
                QuestionFavorite.question_id == question_id,
            )
            .first()
        )
        return exists is not None

    def add_favorite(
        self,
        tenant_id: int,
        user_id: int,
        question_id: int,
        question_type_id: Optional[int] = None,
        subject_id: Optional[int] = None,
        tag_ids: Optional[List[int]] = None,
    ) -> QuestionFavorite:
        """收藏题目并关联元数据
        
        Args:
            tenant_id: 租户 ID
            user_id: 用户 ID
            question_id: 题目 ID
            question_type_id: 题型 ID（可选）
            subject_id: 科目 ID（可选）
            tag_ids: 标签 ID 列表（可选）
            
        Returns:
            QuestionFavorite: 收藏记录
            
        Raises:
            HTTPException: 409 已收藏, 402 超过配额, 404 题目不存在, 403 无权访问
        """
        # 检查题目是否存在且属于该租户
        question = (
            self.db.query(Question)
            .filter(
                Question.id == question_id,
                Question.tenant_id == tenant_id,
            )
            .first()
        )
        if question is None:
            raise HTTPException(status_code=404, detail="题目不存在或不属于该租户")

        # 检查是否已收藏
        if self.is_favorited(tenant_id, user_id, question_id):
            raise HTTPException(status_code=409, detail="该题目已收藏")

        # 检查配额
        if not self.check_quota(tenant_id, user_id):
            raise HTTPException(status_code=402, detail="收藏数量已达上限，请升级订阅")

        # 验证题型属于该租户
        if question_type_id is not None:
            question_type = (
                self.db.query(QuestionType)
                .filter(
                    QuestionType.id == question_type_id,
                    QuestionType.tenant_id == tenant_id,
                )
                .first()
            )
            if question_type is None:
                raise HTTPException(status_code=403, detail="无权使用该题型")

        # 验证科目属于该租户
        if subject_id is not None:
            subject = (
                self.db.query(Subject)
                .filter(
                    Subject.id == subject_id,
                    Subject.tenant_id == tenant_id,
                )
                .first()
            )
            if subject is None:
                raise HTTPException(status_code=403, detail="无权使用该科目")

        # 验证标签属于该租户
        if tag_ids:
            tags = (
                self.db.query(Tag)
                .filter(
                    Tag.tenant_id == tenant_id,
                    Tag.id.in_(tag_ids),
                )
                .all()
            )
            if len(tags) != len(tag_ids):
                raise HTTPException(status_code=403, detail="无权使用某些标签")

        # 创建收藏记录
        favorite = QuestionFavorite(
            tenant_id=tenant_id,
            user_id=user_id,
            question_id=question_id,
            question_type_id=question_type_id,
            subject_id=subject_id,
        )
        self.db.add(favorite)
        self.db.flush()  # 获取 favorite.id

        # 关联标签
        if tag_ids:
            for tag_id in tag_ids:
                # 创建关联记录
                from ..models import FavoriteTag

                favorite_tag = FavoriteTag(favorite_id=favorite.id, tag_id=tag_id)
                self.db.add(favorite_tag)

        self.db.commit()
        self.db.refresh(favorite)

        logger.info(
            "add_favorite: tenant=%s user=%s question=%s favorite_id=%s question_type=%s subject=%s tags=%s",
            tenant_id,
            user_id,
            question_id,
            favorite.id,
            question_type_id,
            subject_id,
            tag_ids,
        )
        return favorite

    def remove_favorite(self, tenant_id: int, user_id: int, question_id: int) -> bool:
        """取消收藏
        
        Args:
            tenant_id: 租户 ID
            user_id: 用户 ID
            question_id: 题目 ID
            
        Returns:
            bool: True 表示成功删除
            
        Raises:
            HTTPException: 404 收藏记录不存在
        """
        favorite = (
            self.db.query(QuestionFavorite)
            .filter(
                QuestionFavorite.tenant_id == tenant_id,
                QuestionFavorite.user_id == user_id,
                QuestionFavorite.question_id == question_id,
            )
            .first()
        )
        if favorite is None:
            raise HTTPException(status_code=404, detail="收藏记录不存在")

        self.db.delete(favorite)
        self.db.commit()

        logger.info(
            "remove_favorite: tenant=%s user=%s question=%s",
            tenant_id,
            user_id,
            question_id,
        )
        return True

    def get_favorites(
        self,
        tenant_id: int,
        user_id: int,
        page: int = 1,
        page_size: int = 20,
    ) -> Tuple[int, List[QuestionFavorite]]:
        """获取收藏列表（分页）
        
        Args:
            tenant_id: 租户 ID
            user_id: 用户 ID
            page: 页码，从 1 开始
            page_size: 每页数量
            
        Returns:
            Tuple[int, List[QuestionFavorite]]: (总数, 收藏列表)
        """
        # 基础查询
        base_query = self.db.query(QuestionFavorite).filter(
            QuestionFavorite.tenant_id == tenant_id,
            QuestionFavorite.user_id == user_id,
        )

        # 获取总数
        total = base_query.count()

        # 分页查询，按收藏时间倒序
        offset = (page - 1) * page_size
        favorites = (
            base_query
            .options(
                joinedload(QuestionFavorite.question),
                joinedload(QuestionFavorite.question_type),
                joinedload(QuestionFavorite.subject),
                joinedload(QuestionFavorite.tags),
            )
            .order_by(QuestionFavorite.created_at.desc())
            .offset(offset)
            .limit(page_size)
            .all()
        )

        return total, favorites
