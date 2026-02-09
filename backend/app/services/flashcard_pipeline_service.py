"""FlashcardPipelineService — 知识点闪卡生成管线。

短文档（≤30 页）：读取 Question + canonical_answer → Turbo 结构化输出知识点卡。
长文档（>30 页）：读取原文件 → Qwen Long 生成章节纲要 → Turbo 结构化输出知识点卡。

所有操作均以 tenant_id 做数据隔离，user_id 记录触发者。
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from textwrap import dedent
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import (
    Document,
    FlashcardConcept,
    FlashcardGenerationJob,
    Question,
)
from .qwen_client import QwenClient, QwenRequestError

logger = logging.getLogger("flashcards.pipeline")

# ── 常量 ──────────────────────────────────────────────
LONG_DOC_PAGE_THRESHOLD = 30
SHORT_DOC_MAX_CHARS = 60_000          # Turbo 单次最大输入字符
LONG_CHUNK_TARGET_CHARS = 40_000      # Long 输出分块目标字符

EXAM_CARD_EXAMPLE = dedent(
    """
    示例输入 (试卷题目):
    题目 1: 已知复数 (1+5i)^1 的虚部是多少？
    标准答案: 因为 z^1 = z，所以虚部仍为 5。

    示例输出(JSON):
    [
      {
        "concept_tag": "复数的虚部定义",
        "cue": "复数 a + bi 的“虚部”指什么?",
        "answer": "1. 只看 i 前的实系数; 2. 虚部 = b; 3. 若 b = 0 则该复数是实数",
        "question_number": 1,
        "confidence": 0.92
      },
      {
        "concept_tag": "指数为 1 的幂运算",
        "cue": "当 z 取 1 次方时, 它的虚部会发生变化吗?",
        "answer": "1. 任意数 z 都有 z^1 = z; 2. 因此虚部保持不变; 3. 只要指数为 1, 结果与原数一致",
        "question_number": 1,
        "confidence": 0.88
      },
      {
        "concept_tag": "举例巩固: 虚部不变",
        "cue": "举一个虚部为 7 的复数, 并说明它 1 次方后的虚部",
        "answer": "示例: 3 + 7i。计算 (3+7i)^1 = 3+7i, 因此虚部仍为 7",
        "question_number": 1,
        "confidence": 0.83
      }
    ]
    """
)

DOC_CARD_EXAMPLE = dedent(
    """
    示例输入 (长文档摘要):
    章节 1 摘要: DNA 的双螺旋结构由互补碱基配对稳定, 复制遵循半保留机制...

    示例输出(JSON):
    [
      {
        "concept_tag": "DNA 半保留复制机制",
        "cue": "为什么说 DNA 复制是“半保留”的?",
        "answer": "1. 复制时以旧链为模板; 2. 每条子链都含一条旧链+一条新链; 3. 该机制保证遗传信息稳定",
        "confidence": 0.9
      },
      {
        "concept_tag": "互补碱基配对的作用",
        "cue": "互补碱基配对如何保证双螺旋结构稳定?",
        "answer": "1. A-T 和 G-C 配对提供氢键; 2. 配对规则使两条链长度一致; 3. 防止复制时产生大量错误",
        "confidence": 0.86
      }
    ]
    """
)

KNOWLEDGE_CARD_STYLE_GUIDANCE = dedent(
    """
    卡片类型请在以下 4 类之间自由组合，确保学习者理解知识点而非背题：
    1. 定义/性质：解释概念、符号含义、必要条件。
    2. 判断/易错辨析：给出判定步骤或常见错误的校正。
    3. 举例/情境：构造 1~2 个示例，说明如何应用该概念。
    4. 反问/自生成练习：让学生自己写一个例子或结论，并在答案中提供参考。
    每张卡只聚焦一个知识点，cue 用“如何/为什么/在什么条件下/举一个例子”等疑问句触发回忆。
    """
)


class FlashcardPipelineService:
    """知识点闪卡生成管线，支持短文档与长文档两条链路。"""

    def __init__(self, db: Session) -> None:
        self.db = db
        self.settings = get_settings()

    # ── 公共入口 ──────────────────────────────────────

    def generate_for_document(
        self,
        *,
        tenant_id: int,
        user_id: int,
        document_id: int,
        max_cards: int = 40,
        force: bool = False,
    ) -> FlashcardGenerationJob:
        """为指定文档生成知识点闪卡（同步执行，返回 Job 记录）。

        如果文档已有闪卡且 force=False，直接返回已完成的 Job。
        """

        doc: Document | None = (
            self.db.query(Document)
            .filter(Document.id == document_id, Document.tenant_id == tenant_id)
            .first()
        )
        if doc is None:
            raise ValueError(f"Document {document_id} not found for tenant {tenant_id}")

        # 检查是否已有闪卡
        if not force:
            existing_count = (
                self.db.query(FlashcardConcept)
                .filter(
                    FlashcardConcept.tenant_id == tenant_id,
                    FlashcardConcept.document_id == document_id,
                )
                .count()
            )
            if existing_count > 0:
                job = self._create_job(tenant_id, document_id, user_id, "skip")
                job.status = "completed"
                job.progress = 100
                job.completed_at = datetime.utcnow()
                self.db.flush()
                return job

        # 判定长/短文档
        is_long = doc.page_count > LONG_DOC_PAGE_THRESHOLD
        mode = "long" if is_long else "short"

        job = self._create_job(tenant_id, document_id, user_id, mode)
        job.status = "running"
        self.db.flush()

        try:
            if force:
                self._clear_existing_cards(tenant_id, document_id)

            if is_long:
                cards = self._pipeline_long(doc, tenant_id, user_id, max_cards)
            else:
                cards = self._pipeline_short(doc, tenant_id, user_id, max_cards)

            job.status = "completed"
            job.progress = 100
            job.completed_at = datetime.utcnow()
            self.db.flush()
            logger.info(
                "pipeline.generate completed tenant=%s doc=%s mode=%s cards=%s",
                tenant_id, document_id, mode, len(cards),
            )
        except Exception as exc:
            job.status = "failed"
            job.error_message = str(exc)[:2000]
            self.db.flush()
            logger.exception(
                "pipeline.generate failed tenant=%s doc=%s mode=%s",
                tenant_id, document_id, mode,
            )
            raise

        return job

    # ── 短文档管线 ────────────────────────────────────

    def _pipeline_short(
        self,
        doc: Document,
        tenant_id: int,
        user_id: int,
        max_cards: int,
    ) -> List[FlashcardConcept]:
        """短文档：从 Question 表读取题干+答案，调用 Turbo 生成知识点卡。"""

        questions: List[Question] = (
            self.db.query(Question)
            .filter(
                Question.tenant_id == tenant_id,
                Question.document_id == doc.id,
            )
            .order_by(Question.sequence_index.asc())
            .all()
        )

        if not questions:
            # 尝试从 OCR 缓存生成
            md_text = self._get_document_markdown(doc)
            if md_text:
                return self._generate_cards_from_text(
                    doc, tenant_id, user_id, md_text, max_cards, source_type="ocr_text",
                )
            return []

        # 组装题目上下文
        q_blocks: List[str] = []
        q_map: Dict[int, Question] = {}
        for q in questions:
            block = f"【第{q.sequence_index + 1}题】\n{q.content}"
            if q.canonical_answer:
                block += f"\n【标准答案】{q.canonical_answer}"
            elif q.grading_predicted_answer:
                block += f"\n【参考答案(AI)】{q.grading_predicted_answer}"
            q_blocks.append(block)
            q_map[q.sequence_index + 1] = q

        full_text = "\n\n".join(q_blocks)
        # 截断保护
        if len(full_text) > SHORT_DOC_MAX_CHARS:
            full_text = full_text[:SHORT_DOC_MAX_CHARS]

        raw_cards = self._invoke_turbo_structured(full_text, max_cards, source_type="exam")

        # 写入数据库
        concepts: List[FlashcardConcept] = []
        for idx, card in enumerate(raw_cards):
            q_num = card.get("question_number")
            linked_q = q_map.get(q_num) if isinstance(q_num, int) else None

            source_ref: Dict[str, Any] = {"document_id": doc.id}
            if linked_q:
                source_ref["question_id"] = linked_q.id
                source_ref["page"] = linked_q.page

            concept = FlashcardConcept(
                tenant_id=tenant_id,
                document_id=doc.id,
                question_id=linked_q.id if linked_q else None,
                concept_tag=card.get("concept_tag", "未分类"),
                cue=card.get("cue", ""),
                answer=card.get("answer", ""),
                confidence=card.get("confidence"),
                source_ref=source_ref,
                created_by_user_id=user_id,
            )
            self.db.add(concept)
            concepts.append(concept)

        self.db.flush()
        return concepts

    # ── 长文档管线 ────────────────────────────────────

    def _pipeline_long(
        self,
        doc: Document,
        tenant_id: int,
        user_id: int,
        max_cards: int,
    ) -> List[FlashcardConcept]:
        """长文档：原文件 → Qwen Long 章节纲要 → Turbo 结构化知识点卡。"""

        # 1) 获取 Long 摘要（优先缓存）
        outline_chunks = self._get_or_create_long_outline(doc, tenant_id)
        if not outline_chunks:
            return []

        # 2) 逐块调用 Turbo 生成知识点卡
        all_concepts: List[FlashcardConcept] = []
        cards_per_chunk = max(1, max_cards // max(len(outline_chunks), 1))

        for chunk in outline_chunks:
            chunk_id = chunk.get("chunk_id", "unknown")
            chunk_text = chunk.get("summary", "")
            if not chunk_text.strip():
                continue

            raw_cards = self._invoke_turbo_structured(
                chunk_text, cards_per_chunk, source_type="long_doc",
            )

            for card in raw_cards:
                source_ref: Dict[str, Any] = {
                    "document_id": doc.id,
                    "chunk_id": chunk_id,
                }
                if chunk.get("page_start") is not None:
                    source_ref["page_range"] = [
                        chunk.get("page_start"),
                        chunk.get("page_end"),
                    ]

                concept = FlashcardConcept(
                    tenant_id=tenant_id,
                    document_id=doc.id,
                    chunk_id=chunk_id,
                    concept_tag=card.get("concept_tag", "未分类"),
                    cue=card.get("cue", ""),
                    answer=card.get("answer", ""),
                    confidence=card.get("confidence"),
                    source_ref=source_ref,
                    created_by_user_id=user_id,
                )
                self.db.add(concept)
                all_concepts.append(concept)

            if len(all_concepts) >= max_cards:
                break

        self.db.flush()
        return all_concepts[:max_cards]

    def _get_or_create_long_outline(
        self, doc: Document, tenant_id: int,
    ) -> List[Dict[str, Any]]:
        """获取或生成长文档的章节纲要缓存。"""

        # 优先读缓存
        if doc.long_summary_cache:
            try:
                cached = json.loads(doc.long_summary_cache)
                if isinstance(cached, list) and len(cached) > 0:
                    return cached
            except (json.JSONDecodeError, TypeError):
                pass

        # 获取原文
        raw_text = self._get_document_markdown(doc)
        if not raw_text:
            logger.warning(
                "pipeline.long no_text tenant=%s doc=%s", tenant_id, doc.id,
            )
            return []

        # 调用 Qwen Long 生成章节纲要
        outline_chunks = self._invoke_qwen_long_outline(raw_text)

        # 写入缓存
        doc.long_summary_cache = json.dumps(outline_chunks, ensure_ascii=False)
        doc.long_summary_version = datetime.utcnow().strftime("%Y%m%d%H%M%S")
        self.db.flush()

        return outline_chunks

    def _invoke_qwen_long_outline(self, raw_text: str) -> List[Dict[str, Any]]:
        """调用 Qwen Long 模型，将长文档压缩为章节级纲要。"""

        model_name = getattr(self.settings, "alibaba_model_qwen_long", None)
        if not model_name:
            model_name = "qwen-long"

        system_prompt = (
            "你是一名教研助手，负责将长篇教材/讲义/笔记压缩为章节级知识纲要。\n"
            "请按章节/段落输出结构化 JSON 数组，每个元素包含：\n"
            '  chunk_id (字符串，如 "ch1-sec2")，\n'
            "  page_start (整数，可选)，page_end (整数，可选)，\n"
            "  summary (该章节的核心内容摘要，300~800字)，\n"
            '  concepts (数组，每个元素 {"tag": "概念名", "description": "一句话描述"})。\n'
            "输出严格为 JSON 数组，不要用 ``` 包裹，不要输出多余说明。"
        )
        user_prompt = f"以下是完整文档内容，请生成章节级知识纲要：\n\n{raw_text}"

        try:
            client = QwenClient(model=model_name, max_output_tokens=8000)
            reply, usage = client.chat(
                [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=0.3,
            )
        except QwenRequestError as exc:
            logger.warning("pipeline.long qwen_long failed: %s", exc)
            return []
        except Exception:
            logger.exception("pipeline.long qwen_long unexpected error")
            return []

        return self._parse_json_array(reply, fallback_label="long_outline")

    # ── Turbo 结构化知识点生成 ────────────────────────

    def _invoke_turbo_structured(
        self,
        text: str,
        max_cards: int,
        *,
        source_type: str = "exam",
    ) -> List[Dict[str, Any]]:
        """调用 Turbo 模型，从文本中提取知识点闪卡。"""

        if source_type == "exam":
            context_hint = "以下是试卷中的题目及答案"
            extra_field = (
                '  question_number (整数，对应原题序号，如 1、2、3，若无法对应则为 null)，\n'
            )
            example_block = EXAM_CARD_EXAMPLE
        else:
            context_hint = "以下是文档章节摘要"
            extra_field = ""
            example_block = DOC_CARD_EXAMPLE

        system_prompt = (
            "你是一名教研专家，负责从学习材料中提取细粒度知识点，生成用于间隔重复复习的闪卡。\n"
            "严禁照搬题干或原文，请先抽象出知识点，再用主动召回问题引导学习者回忆。\n"
            "输出严格为 JSON 数组，每个元素包含：\n"
            '  concept_tag (字符串，知识点主题标签，如"牛顿第二定律"），\n'
            "  cue (15~40 字，使用“如何/为什么/在什么条件下”等疑问句，禁止直接粘贴题干原句)，\n"
            "  answer (2~4 条要点，可用 `1.` `2.` 或 `•` 开头，聚焦推理/公式/结论)，\n"
            f"{extra_field}"
            "  confidence (0~1 浮点数，对该知识点提取质量的自信度)。\n"
            "质量规则：\n"
            "1. 一张卡只考一个概念/公式/方法，concept_tag 必须是知识点名称。\n"
            "2. cue 只能概括知识点，不得带入原题长句、数值或“第X题”描述。\n"
            "3. answer 需要给出关键条件/步骤/结论，禁止空泛描述。\n"
            "4. 若输入包含多个题目，请覆盖不同知识点，避免重复。\n"
            f"5. 最多输出 {max_cards} 张卡片，若知识点不足可少于该数量。"
        )
        user_prompt = (
            f"{context_hint}。请严格参考示例的结构与写作风格生成闪卡。\n"
            f"{example_block}\n"
            "输入数据如下：\n"
            f"{text}"
        )

        turbo_model = self.settings.alibaba_model_qwen_flash
        try:
            client = QwenClient(model=turbo_model, max_output_tokens=8000)
            reply, usage = client.chat(
                [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=0.2,
            )
        except QwenRequestError as exc:
            logger.warning("pipeline.turbo failed: %s", exc)
            return []
        except Exception:
            logger.exception("pipeline.turbo unexpected error")
            return []

        return self._parse_json_array(reply, fallback_label="turbo_cards")

    # ── 从纯文本生成（无 Question 时的回退路径）──────

    def _generate_cards_from_text(
        self,
        doc: Document,
        tenant_id: int,
        user_id: int,
        text: str,
        max_cards: int,
        *,
        source_type: str = "ocr_text",
    ) -> List[FlashcardConcept]:
        """从纯文本生成知识点卡（短文档无 Question 时的回退）。"""

        if len(text) > SHORT_DOC_MAX_CHARS:
            text = text[:SHORT_DOC_MAX_CHARS]

        raw_cards = self._invoke_turbo_structured(text, max_cards, source_type=source_type)

        concepts: List[FlashcardConcept] = []
        for card in raw_cards:
            concept = FlashcardConcept(
                tenant_id=tenant_id,
                document_id=doc.id,
                concept_tag=card.get("concept_tag", "未分类"),
                cue=card.get("cue", ""),
                answer=card.get("answer", ""),
                confidence=card.get("confidence"),
                source_ref={"document_id": doc.id},
                created_by_user_id=user_id,
            )
            self.db.add(concept)
            concepts.append(concept)

        self.db.flush()
        return concepts

    # ── 辅助方法 ──────────────────────────────────────

    def _get_document_markdown(self, doc: Document) -> str:
        """从 Document 的 OCR 缓存中提取 markdown 文本。"""

        if not doc.ocr_md_cache:
            return ""

        try:
            md_payload = json.loads(doc.ocr_md_cache)
        except (json.JSONDecodeError, TypeError):
            return ""

        if isinstance(md_payload, str):
            return md_payload.strip()
        elif isinstance(md_payload, list):
            return "\n\n".join(str(x) for x in md_payload).strip()
        elif md_payload is not None:
            return str(md_payload).strip()
        return ""

    def _parse_json_array(
        self, raw: str, *, fallback_label: str = "unknown",
    ) -> List[Dict[str, Any]]:
        """从 LLM 回复中解析 JSON 数组。"""

        raw = (raw or "").strip()
        if not raw:
            return []

        start = raw.find("[")
        end = raw.rfind("]")
        if start != -1 and end != -1 and end > start:
            raw_json = raw[start : end + 1]
        else:
            raw_json = raw

        try:
            data = json.loads(raw_json)
        except (json.JSONDecodeError, TypeError):
            logger.warning(
                "pipeline.parse_json failed label=%s preview=%s",
                fallback_label, raw[:400],
            )
            return []

        if not isinstance(data, list):
            logger.warning(
                "pipeline.parse_json not_list label=%s type=%s",
                fallback_label, type(data),
            )
            return []

        return [item for item in data if isinstance(item, dict)]

    def _create_job(
        self,
        tenant_id: int,
        document_id: int,
        user_id: int,
        mode: str,
    ) -> FlashcardGenerationJob:
        """创建一条生成任务记录。"""

        job = FlashcardGenerationJob(
            tenant_id=tenant_id,
            document_id=document_id,
            mode=mode,
            status="pending",
            progress=0,
            triggered_by_user_id=user_id,
        )
        self.db.add(job)
        self.db.flush()
        return job

    def _clear_existing_cards(self, tenant_id: int, document_id: int) -> int:
        """清除文档下已有的知识点卡片。"""

        count = (
            self.db.query(FlashcardConcept)
            .filter(
                FlashcardConcept.tenant_id == tenant_id,
                FlashcardConcept.document_id == document_id,
            )
            .delete(synchronize_session="fetch")
        )
        self.db.flush()
        logger.info(
            "pipeline.clear_cards tenant=%s doc=%s deleted=%s",
            tenant_id, document_id, count,
        )
        return count
