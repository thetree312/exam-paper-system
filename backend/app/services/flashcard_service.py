from __future__ import annotations

import json
import logging
from textwrap import dedent
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Question
from .qwen_client import QwenClient, QwenRequestError


logger = logging.getLogger("flashcards")


class FlashcardService:
    """Flashcard views and generation utilities.

    - 基于已存在的 Question 记录生成试卷型闪卡；
    - 基于整篇 markdown 文本生成文章型闪卡（通过 Qwen）。
    """

    def __init__(self, db: Session) -> None:
        self.db = db
        self.settings = get_settings()

    def get_by_document(
        self,
        *,
        tenant_id: int,
        document_id: int,
        include_legend: bool = True,
    ) -> List[Dict[str, Any]]:
        """Return flashcards for all questions under a document."""

        questions: List[Question] = (
            self.db.query(Question)
            .filter(
                Question.tenant_id == tenant_id,
                Question.document_id == document_id,
            )
            .order_by(Question.sequence_index.asc(), Question.id.asc())
            .all()
        )

        flashcards: List[Dict[str, Any]] = []
        for q in questions:
            legend_images: List[str] = []
            if include_legend and q.legend_images:
                try:
                    data = json.loads(q.legend_images)
                    if isinstance(data, list):
                        legend_images = [str(x) for x in data]
                except (TypeError, json.JSONDecodeError):
                    legend_images = []

            back_text: Optional[str] = None
            answer_status: Optional[str] = None
            answer_source: Optional[str] = None

            if getattr(q, "canonical_answer", None):
                back_text = q.canonical_answer  # type: ignore[attr-defined]
                answer_status = getattr(q, "answer_status", None)
                answer_source = getattr(q, "answer_source", None)
            elif getattr(q, "grading_predicted_answer", None):
                back_text = q.grading_predicted_answer
                # 标记为 AI 草稿，前端可以据此展示不同样式
                answer_status = answer_status or "ai_draft"
                answer_source = answer_source or "ai"

            item: Dict[str, Any] = {
                "question_id": q.id,
                "document_id": q.document_id,
                "sequence_index": q.sequence_index,
                "page": q.page,
                "front_markdown": q.content,
                "back_markdown": back_text,
                "legend_images": legend_images,
                "answer_status": answer_status,
                "answer_source": answer_source,
            }
            flashcards.append(item)

        return flashcards

    def get_by_question(
        self,
        *,
        tenant_id: int,
        question_id: int,
        include_legend: bool = True,
    ) -> Optional[Dict[str, Any]]:
        """Return a single flashcard built from a Question."""

        q: Optional[Question] = (
            self.db.query(Question)
            .filter(
                Question.tenant_id == tenant_id,
                Question.id == question_id,
            )
            .first()
        )
        if q is None:
            return None

        legend_images: List[str] = []
        if include_legend and q.legend_images:
            try:
                data = json.loads(q.legend_images)
                if isinstance(data, list):
                    legend_images = [str(x) for x in data]
            except (TypeError, json.JSONDecodeError):
                legend_images = []

        back_text: Optional[str] = None
        answer_status: Optional[str] = None
        answer_source: Optional[str] = None

        if getattr(q, "canonical_answer", None):
            back_text = q.canonical_answer  # type: ignore[attr-defined]
            answer_status = getattr(q, "answer_status", None)
            answer_source = getattr(q, "answer_source", None)
        elif getattr(q, "grading_predicted_answer", None):
            back_text = q.grading_predicted_answer
            answer_status = answer_status or "ai_draft"
            answer_source = answer_source or "ai"

        return {
            "question_id": q.id,
            "document_id": q.document_id,
            "sequence_index": q.sequence_index,
            "page": q.page,
            "front_markdown": q.content,
            "back_markdown": back_text,
            "legend_images": legend_images,
            "answer_status": answer_status,
            "answer_source": answer_source,
        }

    # ===== Article-style flashcards from markdown text =====

    def generate_from_text(
        self,
        *,
        tenant_id: int,
        document_id: int,
        markdown: str,
        max_cards: int = 20,
    ) -> List[Dict[str, Any]]:
        """Generate flashcards from arbitrary markdown / plain text.

        当前版本：
        - 不落库，仅返回闪卡视图；
        - 输出为若干 {front, back} 结构，映射到 FlashcardItem 的
          front_markdown/back_markdown 字段。
        """

        text = (markdown or "").strip()
        if not text:
            return []

        # 控制上下文长度，避免超长文档导致推理困难
        max_chars = 8000
        snippet = text[:max_chars]

        system_prompt = (
            "你是一名教研员，负责基于一篇文章或讲义生成用于复习的闪卡（question-answer 卡片）。\n"
            "每张卡片包含一个问题（或者提示）和一个对应的要点式答案。"
        )
        user_prompt = dedent(
            f"""
            请阅读下面的内容，生成若干条学习闪卡。要求：
            1. 使用中文输出；
            2. 每条卡片包含 front(问题或提示) 和 back(答案或要点)，内容尽量简洁；
            3. 覆盖文中的核心概念、结论、公式、例子等；
            4. 输出严格为 JSON 数组，不要使用 ``` 包裹，也不要输出多余说明；
            5. JSON 结构示例：
               [
                 {"front": "什么是 XXX？", "back": "XXX 的定义是……"},
                 {"front": "YYY 的公式？", "back": "YYY = ……"}
               ]
            6. 优先保证 JSON 能被解析，宁可少一些卡片。

            下面是文档内容：
            {snippet}
            """
        ).strip()

        try:
            client = QwenClient(
                model=self.settings.alibaba_model_qwen_flash,
                max_output_tokens=4096,
            )
        except Exception:
            logger.exception("flashcards: failed to init QwenClient for article flashcards")
            return []

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]

        try:
            reply, usage = client.chat(messages)
        except QwenRequestError as exc:
            logger.warning(
                "flashcards: qwen request failed tenant=%s document=%s error=%s",
                tenant_id,
                document_id,
                exc,
            )
            return []
        except Exception:
            logger.exception(
                "flashcards: unexpected error when calling qwen tenant=%s document=%s",
                tenant_id,
                document_id,
            )
            return []

        raw = (reply or "").strip()
        if not raw:
            return []

        # 尝试从回复中截取 JSON 数组部分
        start = raw.find("[")
        end = raw.rfind("]")
        if start != -1 and end != -1 and end > start:
            raw_json = raw[start : end + 1]
        else:
            raw_json = raw

        try:
            data = json.loads(raw_json)
        except Exception:
            logger.exception(
                "flashcards: failed to parse qwen reply as JSON tenant=%s document=%s preview=%s",
                tenant_id,
                document_id,
                raw[:400],
            )
            return []

        if not isinstance(data, list):
            logger.warning(
                "flashcards: qwen reply is not a list tenant=%s document=%s type=%s",
                tenant_id,
                document_id,
                type(data),
            )
            return []

        cards: List[Dict[str, Any]] = []
        for idx, item in enumerate(data):
            if not isinstance(item, dict):
                continue
            front = (
                str(
                    item.get("front")
                    or item.get("question")
                    or item.get("q")
                    or ""
                )
                .strip()
            )
            back = (
                str(
                    item.get("back")
                    or item.get("answer")
                    or item.get("a")
                    or ""
                )
                .strip()
            )
            if not front:
                continue

            cards.append(
                {
                    "question_id": None,
                    "document_id": document_id,
                    "sequence_index": idx,
                    "page": None,
                    "front_markdown": front,
                    "back_markdown": back or None,
                    "legend_images": [],
                    "answer_status": None,
                    "answer_source": None,
                }
            )

            if 0 < max_cards <= len(cards):
                break

        return cards
