from __future__ import annotations

import logging
from datetime import datetime
from typing import List, Optional

from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Question, Document
from .qwen_client import QwenClient, QwenRequestError


logger = logging.getLogger("flashcards.answers")


class AnswerCompletionService:
    """补全部分或缺失标准答案的题目。

    当前版本：
    - 基于 Question.content 及已有的 grading_predicted_answer / student_answer
      调用 Qwen 生成标准答案文案；
    - 将结果写入 Question.canonical_answer，并把 answer_status/answer_source
      置为 ai_draft/ai；
    - 仅处理指定文档下的题目，支持按 question_ids 过滤。
    """

    def __init__(self, db: Session) -> None:
        self.db = db
        self.settings = get_settings()

    def _build_prompt_for_question(self, q: Question) -> str:
        parts: List[str] = []
        parts.append("你是一名阅卷老师，请为下面这道题生成一个**简洁、标准**的参考答案。")
        parts.append(""
        "\n要求：\n"
        "1. 答案使用中文；\n"
        "2. 只输出答案本身，不要解释过程；\n"
        "3. 若题目为主观题，请给出一个覆盖要点的理想答案；\n"
        "4. 若题目为选择题/填空题，可以直接给出选项或空格应填写的内容；\n"
        "5. 禁止输出与答案无关的客套话。\n"
        )

        parts.append("\n题目内容：\n" + (q.content or "").strip())

        if getattr(q, "grading_predicted_answer", None):
            parts.append("\n（可选参考）此前模型给出的作答：\n" + (q.grading_predicted_answer or "").strip())
        elif getattr(q, "student_answer", None):
            parts.append("\n（可选参考）学生的作答：\n" + (q.student_answer or "").strip())

        return "\n\n".join(parts)

    def complete_missing_answers(
        self,
        *,
        tenant_id: int,
        document_id: int,
        question_ids: Optional[List[int]] = None,
        max_questions: int = 20,
    ) -> List[int]:
        """为指定文档下缺失标准答案的题目补全 canonical_answer。

        返回实际写入答案的 question_id 列表。
        """

        query = (
            self.db.query(Question)
            .filter(
                Question.tenant_id == tenant_id,
                Question.document_id == document_id,
            )
        )
        if question_ids:
            query = query.filter(Question.id.in_(question_ids))

        # 只处理 canonical_answer 为空或仅空白的题目
        candidates: List[Question] = []
        for q in query.order_by(Question.sequence_index.asc(), Question.id.asc()).all():
            canon = (getattr(q, "canonical_answer", None) or "").strip()
            if not canon:
                candidates.append(q)
        if not candidates:
            return []

        if max_questions > 0:
            candidates = candidates[:max_questions]

        try:
            client = QwenClient(model=self.settings.alibaba_model_qwen_plus, max_output_tokens=2048)
        except Exception:
            logger.exception("answer_completion: failed to init QwenClient")
            return []

        updated_ids: List[int] = []

        for q in candidates:
            prompt = self._build_prompt_for_question(q)
            messages = [
                {"role": "system", "content": "你是一名严格的阅卷老师。"},
                {"role": "user", "content": prompt},
            ]
            try:
                reply, usage = client.chat(messages)
            except QwenRequestError as exc:
                logger.warning(
                    "answer_completion: qwen request failed question_id=%s error=%s", q.id, exc
                )
                continue
            except Exception:
                logger.exception(
                    "answer_completion: unexpected error when calling qwen question_id=%s", q.id
                )
                continue

            answer_text = (reply or "").strip()
            if not answer_text:
                continue

            q.canonical_answer = answer_text
            q.answer_status = "ai_draft"
            q.answer_source = "ai"
            q.updated_at = datetime.utcnow()
            updated_ids.append(q.id)

        if updated_ids:
            try:
                self.db.commit()
            except Exception:
                logger.exception(
                    "answer_completion: failed to commit updated answers document_id=%s tenant_id=%s",
                    document_id,
                    tenant_id,
                )
                self.db.rollback()
                return []

        return updated_ids
