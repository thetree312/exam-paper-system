"""Flashcard API routes.

This router exposes flashcard views built on top of existing Question data.
Initially it focuses on exam-like documents where questions are already
imported, and does not introduce new persistent tables.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..glm_ocr.service import GlmOcrService
from ..models import Document
from ..services.flashcard_service import FlashcardService
from ..services.answer_completion_service import AnswerCompletionService


logger = logging.getLogger("flashcards.api")

router = APIRouter(prefix="/api/flashcards", tags=["flashcards"])


class FlashcardItem(BaseModel):
    question_id: int
    document_id: int
    sequence_index: int
    page: Optional[int] = None
    front_markdown: str
    back_markdown: Optional[str] = None
    legend_images: List[str] = Field(default_factory=list)
    answer_status: Optional[str] = None
    answer_source: Optional[str] = None


class FlashcardListResponse(BaseModel):
    items: List[FlashcardItem]


class CompleteAnswersRequest(BaseModel):
    document_id: int
    question_ids: Optional[List[int]] = None
    max_questions: int = Field(20, ge=1, le=200)


class CompleteAnswersResponse(BaseModel):
    updated_question_ids: List[int]


@router.get("/by-document/{document_id}", response_model=FlashcardListResponse)
def get_flashcards_by_document(
    document_id: int,
    tenant_id: int = Query(..., description="租户 ID"),
    include_legend: bool = Query(True, description="是否包含图例"),
    db: Session = Depends(get_db),
) -> FlashcardListResponse:
    """获取某文档下所有题目的闪卡视图。

    当前实现：仅基于已导入的 Question 记录生成闪卡，不触发新的 OCR
    或 AI 推理，用于试卷场景的第一阶段落地。
    """

    service = FlashcardService(db)
    items_raw = service.get_by_document(
        tenant_id=tenant_id,
        document_id=document_id,
        include_legend=include_legend,
    )
    items = [FlashcardItem(**it) for it in items_raw]
    return FlashcardListResponse(items=items)


@router.get("/by-question/{question_id}", response_model=FlashcardItem)
def get_flashcard_by_question(
    question_id: int,
    tenant_id: int = Query(..., description="租户 ID"),
    include_legend: bool = Query(True, description="是否包含图例"),
    db: Session = Depends(get_db),
) -> FlashcardItem:
    """获取单道题目的闪卡视图。"""

    service = FlashcardService(db)
    item_raw = service.get_by_question(
        tenant_id=tenant_id,
        question_id=question_id,
        include_legend=include_legend,
    )
    if item_raw is None:
        raise HTTPException(status_code=404, detail="题目不存在")
    return FlashcardItem(**item_raw)


@router.get("/article/{document_id}", response_model=FlashcardListResponse)
async def get_article_flashcards_by_document(
    document_id: int,
    tenant_id: int = Query(..., description="租户 ID"),
    max_cards: int = Query(20, ge=1, le=200, description="最多生成多少张闪卡"),
    db: Session = Depends(get_db),
) -> FlashcardListResponse:
    """基于文档全文内容生成学习型闪卡（文章模式）。

    - 优先复用 Document.ocr_md_cache；
    - 若无缓存，则自动触发 GLM-OCR（受 FileOcrCache 管理，不会重复扣量）；
    - 基于整篇 markdown / 纯文本调用 Qwen 生成若干 front/back 对。
    """

    doc: Document | None = (
        db.query(Document)
        .filter(Document.id == document_id, Document.tenant_id == tenant_id)
        .first()
    )
    if doc is None:
        raise HTTPException(status_code=404, detail="文档不存在")

    # 1) 取 OCR 文本缓存
    md_payload: Any = None
    if doc.ocr_md_cache:
        try:
            md_payload = json.loads(doc.ocr_md_cache)
        except Exception:
            logger.warning(
                "flashcards.article: failed to decode ocr_md_cache document_id=%s",
                doc.id,
            )

    # 2) 若无缓存，则触发 GLM-OCR，一次性写回 Document 缓存
    if md_payload is None:
        file = doc.file
        if file is None:
            raise HTTPException(status_code=400, detail="文档未绑定源文件，无法执行 OCR")

        ocr_service = GlmOcrService()
        glm_result, _ = await ocr_service.call_layout_parsing(
            db,
            file=file,
            tenant_id=tenant_id,
            document=doc,
            force_refresh=False,
        )
        md_payload = glm_result.get("md_results")
        try:
            db.commit()
            db.refresh(doc)
        except Exception:
            logger.exception(
                "flashcards.article: failed to persist ocr cache document_id=%s",
                doc.id,
            )
            db.rollback()

    # 3) 将 md_results 归一为一个大文本
    text = ""
    if isinstance(md_payload, str):
        text = md_payload
    elif isinstance(md_payload, list):
        try:
            text = "\n\n".join(str(x) for x in md_payload)
        except Exception:
            text = "\n\n".join([str(x) for x in md_payload])
    elif md_payload is not None:
        text = str(md_payload)

    text = (text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="文档 OCR 文本为空，无法生成闪卡")

    service = FlashcardService(db)
    items_raw = await run_in_threadpool(
        service.generate_from_text,
        tenant_id=tenant_id,
        document_id=document_id,
        markdown=text,
        max_cards=max_cards,
    )
    items = [FlashcardItem(**it) for it in items_raw]
    return FlashcardListResponse(items=items)


@router.post("/complete-answers", response_model=CompleteAnswersResponse)
def complete_answers_for_document(
    payload: CompleteAnswersRequest,
    tenant_id: int = Query(..., description="租户 ID"),
    db: Session = Depends(get_db),
) -> CompleteAnswersResponse:
    """为指定文档下缺失标准答案的题目批量补全 canonical_answer。

    - 只处理 canonical_answer 为空的题目；
    - 默认最多处理 20 道题，可通过 max_questions 调整；
    - 返回实际写入答案的 question_id 列表。
    """

    service = AnswerCompletionService(db)
    updated_ids = service.complete_missing_answers(
        tenant_id=tenant_id,
        document_id=payload.document_id,
        question_ids=payload.question_ids,
        max_questions=payload.max_questions,
    )
    return CompleteAnswersResponse(updated_question_ids=updated_ids)
