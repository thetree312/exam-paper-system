"""FlashcardSchedulingService — 间隔重复复习调度。

实现简化版 SM-2 算法：
- score 0 = 没掌握 → bucket 重置为 0，interval = 1 天
- score 1 = 一般    → bucket 不变，interval 按当前 bucket 计算
- score 2 = 熟练    → bucket +1，interval 按新 bucket 计算

Bucket → Interval 映射（Leitner 风格）：
  0 → 1 天, 1 → 2 天, 2 → 4 天, 3 → 7 天, 4 → 14 天, 5 → 30 天, 6+ → 60 天

所有操作以 tenant_id + user_id 做隔离。
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models import FlashcardConcept, FlashcardReview

logger = logging.getLogger("flashcards.scheduling")

# Leitner bucket → interval days
BUCKET_INTERVALS = {
    0: 1,
    1: 2,
    2: 4,
    3: 7,
    4: 14,
    5: 30,
}
MAX_INTERVAL_DAYS = 60


def _interval_for_bucket(bucket: int) -> int:
    if bucket < 0:
        bucket = 0
    return BUCKET_INTERVALS.get(bucket, MAX_INTERVAL_DAYS)


class FlashcardSchedulingService:
    """管理闪卡复习记录与间隔重复调度。"""

    def __init__(self, db: Session) -> None:
        self.db = db

    def record_review(
        self,
        *,
        tenant_id: int,
        user_id: int,
        card_id: int,
        score: int,
        memo: Optional[str] = None,
    ) -> FlashcardReview:
        """记录一次自评并计算下次复习时间。

        score: 0=没掌握, 1=一般, 2=熟练
        返回新创建的 FlashcardReview 记录。
        """

        score = max(0, min(2, score))

        # 获取该用户对此卡的最近一次复习
        last_review: FlashcardReview | None = (
            self.db.query(FlashcardReview)
            .filter(
                FlashcardReview.tenant_id == tenant_id,
                FlashcardReview.card_id == card_id,
                FlashcardReview.user_id == user_id,
            )
            .order_by(FlashcardReview.reviewed_at.desc())
            .first()
        )

        current_bucket = last_review.bucket if last_review and last_review.bucket is not None else 0

        # 计算新 bucket
        if score == 0:
            new_bucket = 0
        elif score == 1:
            new_bucket = current_bucket
        else:  # score == 2
            new_bucket = min(current_bucket + 1, 6)

        interval_days = _interval_for_bucket(new_bucket)
        now = datetime.utcnow()
        next_review_at = now + timedelta(days=interval_days)

        review = FlashcardReview(
            tenant_id=tenant_id,
            card_id=card_id,
            user_id=user_id,
            score=score,
            reviewed_at=now,
            interval_days=interval_days,
            next_review_at=next_review_at,
            bucket=new_bucket,
            memo=memo,
        )
        self.db.add(review)
        self.db.flush()

        logger.info(
            "scheduling.review tenant=%s user=%s card=%s score=%s bucket=%s→%s interval=%sd next=%s",
            tenant_id, user_id, card_id, score,
            current_bucket, new_bucket, interval_days, next_review_at.isoformat(),
        )

        return review

    def get_due_cards(
        self,
        *,
        tenant_id: int,
        user_id: int,
        document_id: Optional[int] = None,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        """获取用户当前需要复习的卡片列表。

        逻辑：
        1. 从未复习过的卡片（无 review 记录）→ 优先展示。
        2. next_review_at <= now 的卡片 → 按 next_review_at 升序。
        """

        now = datetime.utcnow()

        # 子查询：每张卡的最新 review
        latest_review_subq = (
            self.db.query(
                FlashcardReview.card_id,
                func.max(FlashcardReview.reviewed_at).label("latest_at"),
            )
            .filter(
                FlashcardReview.tenant_id == tenant_id,
                FlashcardReview.user_id == user_id,
            )
            .group_by(FlashcardReview.card_id)
            .subquery()
        )

        # 查询所有属于该租户的卡片
        card_query = (
            self.db.query(FlashcardConcept)
            .filter(FlashcardConcept.tenant_id == tenant_id)
        )
        if document_id is not None:
            card_query = card_query.filter(FlashcardConcept.document_id == document_id)

        all_cards = card_query.all()

        # 获取最新 review 记录
        latest_reviews: Dict[int, FlashcardReview] = {}
        if all_cards:
            card_ids = [c.id for c in all_cards]
            reviews = (
                self.db.query(FlashcardReview)
                .filter(
                    FlashcardReview.tenant_id == tenant_id,
                    FlashcardReview.user_id == user_id,
                    FlashcardReview.card_id.in_(card_ids),
                )
                .order_by(FlashcardReview.reviewed_at.desc())
                .all()
            )
            for r in reviews:
                if r.card_id not in latest_reviews:
                    latest_reviews[r.card_id] = r

        # 分类
        never_reviewed: List[FlashcardConcept] = []
        due_cards: List[tuple[FlashcardConcept, FlashcardReview]] = []

        for card in all_cards:
            review = latest_reviews.get(card.id)
            if review is None:
                never_reviewed.append(card)
            elif review.next_review_at is not None and review.next_review_at <= now:
                due_cards.append((card, review))

        # 排序：未复习优先，然后按 next_review_at 升序
        due_cards.sort(key=lambda x: x[1].next_review_at or now)

        result: List[Dict[str, Any]] = []

        for card in never_reviewed[:limit]:
            result.append(self._card_to_dict(card, None))

        remaining = limit - len(result)
        for card, review in due_cards[:remaining]:
            result.append(self._card_to_dict(card, review))

        return result

    def get_card_mastery_stats(
        self,
        *,
        tenant_id: int,
        user_id: int,
        document_id: int,
    ) -> Dict[str, Any]:
        """获取某文档下用户的掌握程度统计。"""

        total_cards = (
            self.db.query(FlashcardConcept)
            .filter(
                FlashcardConcept.tenant_id == tenant_id,
                FlashcardConcept.document_id == document_id,
            )
            .count()
        )

        if total_cards == 0:
            return {
                "total": 0,
                "never_reviewed": 0,
                "mastered": 0,
                "reviewing": 0,
                "struggling": 0,
                "due_today": 0,
            }

        card_ids = [
            c.id for c in
            self.db.query(FlashcardConcept.id)
            .filter(
                FlashcardConcept.tenant_id == tenant_id,
                FlashcardConcept.document_id == document_id,
            )
            .all()
        ]

        # 获取每张卡的最新 review
        reviews = (
            self.db.query(FlashcardReview)
            .filter(
                FlashcardReview.tenant_id == tenant_id,
                FlashcardReview.user_id == user_id,
                FlashcardReview.card_id.in_(card_ids),
            )
            .order_by(FlashcardReview.reviewed_at.desc())
            .all()
        )

        latest_by_card: Dict[int, FlashcardReview] = {}
        for r in reviews:
            if r.card_id not in latest_by_card:
                latest_by_card[r.card_id] = r

        now = datetime.utcnow()
        never_reviewed = 0
        mastered = 0       # bucket >= 4
        reviewing = 0      # bucket 1~3
        struggling = 0     # bucket 0
        due_today = 0

        for cid in card_ids:
            review = latest_by_card.get(cid)
            if review is None:
                never_reviewed += 1
                due_today += 1
                continue

            bucket = review.bucket or 0
            if bucket >= 4:
                mastered += 1
            elif bucket >= 1:
                reviewing += 1
            else:
                struggling += 1

            if review.next_review_at and review.next_review_at <= now:
                due_today += 1

        return {
            "total": total_cards,
            "never_reviewed": never_reviewed,
            "mastered": mastered,
            "reviewing": reviewing,
            "struggling": struggling,
            "due_today": due_today,
        }

    def _card_to_dict(
        self,
        card: FlashcardConcept,
        review: Optional[FlashcardReview],
    ) -> Dict[str, Any]:
        """将卡片+复习记录转为前端可用的 dict。"""

        bucket = review.bucket if review else None
        if bucket is None:
            mastery_state = "new"
        elif bucket >= 4:
            mastery_state = "mastered"
        elif bucket >= 1:
            mastery_state = "reviewing"
        else:
            mastery_state = "struggling"

        return {
            "card_id": card.id,
            "tenant_id": card.tenant_id,
            "document_id": card.document_id,
            "question_id": card.question_id,
            "chunk_id": card.chunk_id,
            "concept_tag": card.concept_tag,
            "cue": card.cue,
            "answer": card.answer,
            "confidence": card.confidence,
            "source_ref": card.source_ref,
            "legend_images": card.legend_images,
            "mastery_state": mastery_state,
            "bucket": bucket,
            "next_review_at": (
                review.next_review_at.isoformat() if review and review.next_review_at else None
            ),
            "last_score": review.score if review else None,
            "review_count": (
                self.db.query(FlashcardReview)
                .filter(
                    FlashcardReview.card_id == card.id,
                    FlashcardReview.user_id == review.user_id,
                )
                .count()
                if review else 0
            ),
        }
