"""Flashcard API routes — 知识点闪卡完整接口。

提供：生成 / 列表 / 待复习 / 自评 / 掌握统计 / Agent 升级 等端点。
所有接口均要求 tenant_id（租户隔离）。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import FlashcardConcept, FlashcardGenerationJob
from ..services.flashcard_pipeline_service import FlashcardPipelineService
from ..services.flashcard_scheduling_service import FlashcardSchedulingService


logger = logging.getLogger("flashcards.api")

router = APIRouter(prefix="/api/flashcards", tags=["flashcards"])


# ── Pydantic schemas ─────────────────────────────────

class FlashcardCardOut(BaseModel):
    card_id: int
    tenant_id: int
    document_id: int
    question_id: Optional[int] = None
    chunk_id: Optional[str] = None
    concept_tag: str
    cue: str
    answer: str
    confidence: Optional[float] = None
    source_ref: Optional[dict] = None
    legend_images: Optional[list] = None
    mastery_state: str = "new"
    bucket: Optional[int] = None
    next_review_at: Optional[str] = None
    last_score: Optional[int] = None
    review_count: int = 0


class FlashcardListResponse(BaseModel):
    items: List[FlashcardCardOut]


class GenerateRequest(BaseModel):
    document_id: int
    max_cards: int = Field(200, ge=1, le=20_000)
    force: bool = False
    preferred_language: Optional[str] = None


class GenerateResponse(BaseModel):
    job_id: int
    status: str
    mode: str
    card_count: int


class ReviewRequest(BaseModel):
    card_id: int
    score: int = Field(..., ge=0, le=2, description="0=没掌握, 1=一般, 2=熟练")
    memo: Optional[str] = None


class ReviewResponse(BaseModel):
    review_id: int
    card_id: int
    score: int
    bucket: Optional[int]
    interval_days: int
    next_review_at: Optional[str]


class MasteryStatsResponse(BaseModel):
    total: int
    never_reviewed: int
    mastered: int
    reviewing: int
    struggling: int
    due_today: int


class AgentEscalateRequest(BaseModel):
    card_id: int
    user_note: Optional[str] = None


class AgentEscalateResponse(BaseModel):
    escalated: bool
    card_id: int
    concept_tag: str
    message: str


# ── 生成接口 ─────────────────────────────────────────

@router.post("/generate", response_model=GenerateResponse)
async def generate_flashcards(
    payload: GenerateRequest,
    tenant_id: int = Query(..., description="租户 ID"),
    user_id: int = Query(..., description="用户 ID"),
    db: Session = Depends(get_db),
) -> GenerateResponse:
    """为指定文档生成知识点闪卡。

    - 短文档（≤30页）：读取 Question + canonical_answer → Turbo 结构化。
    - 长文档（>30页）：原文件 → Qwen Long 纲要 → Turbo 结构化。
    - force=true 时清除已有卡片并重新生成。
    """

    pipeline = FlashcardPipelineService(db)
    try:
        job = await run_in_threadpool(
            pipeline.generate_for_document,
            tenant_id=tenant_id,
            user_id=user_id,
            document_id=payload.document_id,
            max_cards=payload.max_cards,
            force=payload.force,
            preferred_language=payload.preferred_language,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        logger.exception("flashcards.generate failed")
        raise HTTPException(status_code=500, detail=f"生成失败: {exc}")

    card_count = (
        db.query(FlashcardConcept)
        .filter(
            FlashcardConcept.tenant_id == tenant_id,
            FlashcardConcept.document_id == payload.document_id,
        )
        .count()
    )

    db.commit()

    return GenerateResponse(
        job_id=job.id,
        status=job.status,
        mode=job.mode,
        card_count=card_count,
    )


# ── 列表接口 ─────────────────────────────────────────

@router.get("/list/{document_id}", response_model=FlashcardListResponse)
def list_flashcards(
    document_id: int,
    tenant_id: int = Query(..., description="租户 ID"),
    user_id: int = Query(..., description="用户 ID"),
    concept_tag: Optional[str] = Query(None, description="按知识点标签筛选"),
    db: Session = Depends(get_db),
) -> FlashcardListResponse:
    """获取某文档下所有知识点闪卡（含用户掌握状态）。"""

    scheduling = FlashcardSchedulingService(db)

    query = (
        db.query(FlashcardConcept)
        .filter(
            FlashcardConcept.tenant_id == tenant_id,
            FlashcardConcept.document_id == document_id,
        )
    )
    if concept_tag:
        query = query.filter(FlashcardConcept.concept_tag == concept_tag)

    cards = query.order_by(FlashcardConcept.id.asc()).all()

    items = []
    for card in cards:
        card_dict = scheduling._card_to_dict(card, None)
        # 尝试获取该用户的最新 review
        from ..models import FlashcardReview
        latest = (
            db.query(FlashcardReview)
            .filter(
                FlashcardReview.tenant_id == tenant_id,
                FlashcardReview.card_id == card.id,
                FlashcardReview.user_id == user_id,
            )
            .order_by(FlashcardReview.reviewed_at.desc())
            .first()
        )
        if latest:
            card_dict = scheduling._card_to_dict(card, latest)
        items.append(FlashcardCardOut(**card_dict))

    return FlashcardListResponse(items=items)


# ── 待复习接口 ───────────────────────────────────────

@router.get("/due", response_model=FlashcardListResponse)
def get_due_flashcards(
    tenant_id: int = Query(..., description="租户 ID"),
    user_id: int = Query(..., description="用户 ID"),
    document_id: Optional[int] = Query(None, description="限定文档"),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
) -> FlashcardListResponse:
    """获取用户当前需要复习的闪卡（含从未复习的新卡）。"""

    scheduling = FlashcardSchedulingService(db)
    due_items = scheduling.get_due_cards(
        tenant_id=tenant_id,
        user_id=user_id,
        document_id=document_id,
        limit=limit,
    )
    items = [FlashcardCardOut(**item) for item in due_items]
    return FlashcardListResponse(items=items)


# ── 自评接口 ─────────────────────────────────────────

@router.post("/review", response_model=ReviewResponse)
def submit_review(
    payload: ReviewRequest,
    tenant_id: int = Query(..., description="租户 ID"),
    user_id: int = Query(..., description="用户 ID"),
    db: Session = Depends(get_db),
) -> ReviewResponse:
    """提交一次闪卡自评，更新间隔重复调度。

    score: 0=没掌握, 1=一般, 2=熟练
    """

    # 验证卡片存在且属于该租户
    card = (
        db.query(FlashcardConcept)
        .filter(
            FlashcardConcept.id == payload.card_id,
            FlashcardConcept.tenant_id == tenant_id,
        )
        .first()
    )
    if card is None:
        raise HTTPException(status_code=404, detail="闪卡不存在")

    scheduling = FlashcardSchedulingService(db)
    review = scheduling.record_review(
        tenant_id=tenant_id,
        user_id=user_id,
        card_id=payload.card_id,
        score=payload.score,
        memo=payload.memo,
    )
    db.commit()

    return ReviewResponse(
        review_id=review.id,
        card_id=review.card_id,
        score=review.score,
        bucket=review.bucket,
        interval_days=review.interval_days,
        next_review_at=review.next_review_at.isoformat() if review.next_review_at else None,
    )


# ── 掌握统计接口 ─────────────────────────────────────

@router.get("/stats/{document_id}", response_model=MasteryStatsResponse)
def get_mastery_stats(
    document_id: int,
    tenant_id: int = Query(..., description="租户 ID"),
    user_id: int = Query(..., description="用户 ID"),
    db: Session = Depends(get_db),
) -> MasteryStatsResponse:
    """获取某文档下用户的闪卡掌握程度统计。"""

    scheduling = FlashcardSchedulingService(db)
    stats = scheduling.get_card_mastery_stats(
        tenant_id=tenant_id,
        user_id=user_id,
        document_id=document_id,
    )
    return MasteryStatsResponse(**stats)


# ── Agent 升级接口 ───────────────────────────────────

@router.post("/agent-escalate", response_model=AgentEscalateResponse)
def agent_escalate(
    payload: AgentEscalateRequest,
    tenant_id: int = Query(..., description="租户 ID"),
    user_id: int = Query(..., description="用户 ID"),
    db: Session = Depends(get_db),
) -> AgentEscalateResponse:
    """将未掌握的闪卡升级给 Agent 进行讲解辅导。

    前端在用户点击"提交给 AI 辅导"时调用此接口，
    后端组装 concept_tag + source_ref 等上下文，
    返回确认信息供前端跳转到 Agent 会话。
    """

    card = (
        db.query(FlashcardConcept)
        .filter(
            FlashcardConcept.id == payload.card_id,
            FlashcardConcept.tenant_id == tenant_id,
        )
        .first()
    )
    if card is None:
        raise HTTPException(status_code=404, detail="闪卡不存在")

    # 组装 Agent 上下文（后续可对接 AgentService.start_flashcard_help）
    context = {
        "card_id": card.id,
        "concept_tag": card.concept_tag,
        "cue": card.cue,
        "answer": card.answer,
        "source_ref": card.source_ref,
        "user_note": payload.user_note,
        "tenant_id": tenant_id,
        "user_id": user_id,
    }

    logger.info(
        "flashcards.agent_escalate tenant=%s user=%s card=%s tag=%s",
        tenant_id, user_id, card.id, card.concept_tag,
    )

    return AgentEscalateResponse(
        escalated=True,
        card_id=card.id,
        concept_tag=card.concept_tag,
        message=f"已将知识点「{card.concept_tag}」提交给 AI 辅导，请前往对话面板查看。",
    )
