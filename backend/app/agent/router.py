import atexit
import json
import logging
import queue
import re
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import SessionLocal, get_db
from .assistant_graph.adapters.message_adapter import (
    from_state_messages,
    is_fresh_conversation,
    sanitize_conversation_messages,
    to_state_messages,
)
from .assistant_graph.runtime_bootstrap import get_compiled_agent_app
from ..config import get_settings
from .services.agent_invocation_service import build_run_thread_id
from .assistant_graph.session_runtime import (
    resolve_resume_runtime_context,
    resolve_run_runtime_context,
    resolve_source_file_ids,
)
from .assistant_graph.router_runtime import (
    StreamTraceReducer,
    build_agent_environment_model,
    build_agent_router_context,
    iter_stream_trace_events,
    normalize_stream_event,
    persist_agent_messages,
)
from .services.agent_service import AgentService
from ..services.qwen_client import QwenClient, QwenRequestError
from ..services.workroom_scope_service import assert_workroom_scope, assert_studio_document_scope
from ..services.fulltext_service import FulltextService
from ..models import AgentSession, AgentMessage, Document, File, Question
from ..utils.rate_limiter import rate_limit

logger = logging.getLogger("agent.router")


router = APIRouter(prefix="/api/agent", tags=["agent_v2"])
settings = get_settings()
agent_run_limit = rate_limit("agent-run", limit=30, window_seconds=60)
agent_stream_limit = rate_limit("agent-run-stream", limit=30, window_seconds=60)
agent_resume_limit = rate_limit("agent-run-resume", limit=30, window_seconds=60)
grade_limit = rate_limit("agent-grade", limit=10, window_seconds=60)
split_limit = rate_limit("agent-split", limit=10, window_seconds=60)
sync_limit = rate_limit("agent-sync", limit=60, window_seconds=60)
snapshot_limit = rate_limit("agent-snapshot", limit=60, window_seconds=60)
mindmap_limit = rate_limit("mindmap-generate", limit=5, window_seconds=60)

class AgentMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str


class NoteFocusPayload(BaseModel):
    studio_document_id: Optional[int] = None
    file_id: Optional[int] = None
    block_index: Optional[int] = None
    snippet: Optional[str] = None
    title: Optional[str] = None


class AgentRunRequest(BaseModel):
    tenant_id: int
    user_id: int
    workroom_id: int
    ui_context: Literal["blank", "exam_editor", "code_editor", "other", "batch_question"] = "blank"
    studio_document_id: int | None = None
    studio_snapshot: str | None = None
    source_file_ids: List[int] = Field(default_factory=list)
    messages: List[AgentMessage]
    note_focus: Optional[NoteFocusPayload] = None
    view_id: Optional[str] = None
    session_id: Optional[int] = None
    agent_max_steps: Optional[int] = None


class AgentResumeRequest(BaseModel):
    """Resume execution from a LangGraph interrupt checkpoint."""

    tenant_id: int
    user_id: int
    workroom_id: int
    ui_context: Literal["blank", "exam_editor", "code_editor", "other", "batch_question"] = "blank"
    studio_document_id: int | None = None
    session_id: Optional[int] = None
    thread_id: Optional[str] = None
    resume_payload: dict
    agent_max_steps: Optional[int] = None


class AgentRunResponse(BaseModel):
    session_id: Optional[int] = None
    messages: List[AgentMessage]
    halt_reason: Optional[str] = None
    interrupt_payload: Optional[dict] = None
    ag_ui_events: List[dict] = Field(default_factory=list)


class AgentSessionMeta(BaseModel):
    id: int
    tenant_id: int
    user_id: int
    studio_document_id: int | None = None
    view_id: str | None = None
    title: Optional[str] = None
    last_message_preview: Optional[str] = None
    message_count: int
    status: str
    archived: bool
    created_at: datetime
    updated_at: datetime


class AgentSessionListResponse(BaseModel):
    sessions: List[AgentSessionMeta]


class AgentSessionUpdateRequest(BaseModel):
    tenant_id: int
    user_id: int
    title: Optional[str] = None
    archived: Optional[bool] = None
    status: Optional[str] = None


class AgentHistoryMessage(BaseModel):
    id: int
    role: Literal["system", "user", "assistant", "tool"]
    content: str
    created_at: datetime


class AgentSessionMessagesResponse(BaseModel):
    session_id: int
    messages: List[AgentHistoryMessage]


class GradeQuestionPayload(BaseModel):
    sequence_index: int
    content: str
    user_answer: str | None = None
    legend_images: List[str] | None = None
    page: int | None = None
    file_name: str | None = None


class GradeRunRequest(BaseModel):
    tenant_id: int
    user_id: int
    workroom_id: int
    studio_document_id: int | None = None
    title: str | None = None
    questions: List[GradeQuestionPayload]


class GradeQuestionResult(BaseModel):
    sequence_index: int
    judgement: Literal["correct", "incorrect", "skipped", "uncertain", "error"]
    predicted_answer: Optional[str] = None
    reasoning: Optional[str] = None
    confidence: Optional[float] = None
    raw_response: Optional[str] = None
    error: Optional[str] = None


class GradeRunResponse(BaseModel):
    results: List[GradeQuestionResult]


class SnapshotRequest(BaseModel):
    tenant_id: int
    user_id: int
    workroom_id: int
    studio_document_id: int


class SplitQuestionsRequest(BaseModel):
    tenant_id: int
    user_id: int
    text: str
    max_questions: int | None = 20


class SplitQuestionItem(BaseModel):
    index: int
    text: str


class SplitQuestionsResponse(BaseModel):
    questions: List[SplitQuestionItem]


class MindMapRequest(BaseModel):
    """Request payload for mind map generation.

    mode:
      - "document": generate from a specific studio_document_id.
      - "file": generate directly from an uploaded file_id.
    """

    mode: Literal["document", "file"] = "document"
    studio_document_id: Optional[int] = None
    file_id: Optional[int] = None


class MindMapNode(BaseModel):
    """Single node in mind map graph.

    Additional optional fields:
    - parent_id: parent node id for tree layout.
    - side: left/right/center hint for branch placement.
    """

    id: str
    label: str
    type: str = "topic"
    parent_id: Optional[str] = None
    side: Optional[Literal["left", "right", "center"]] = None
    data: dict = {}


class MindMapEdge(BaseModel):
    id: str
    source: str
    target: str
    label: Optional[str] = None
    type: str = "default"


class MindMapResponse(BaseModel):
    """Mind map graph returned to the frontend.

    root_id can be null; frontend may infer root when needed.
    """

    nodes: List[MindMapNode] = []
    edges: List[MindMapEdge] = []
    root_id: Optional[str] = None
    cached: bool = False
    has_question_refs: bool = False


class DeleteQuestionRequest(BaseModel):
    tenant_id: int
    user_id: int
    workroom_id: int
    studio_document_id: int
    question_id: int


def _infer_question_refs_from_nodes(nodes: Any) -> bool:
    if not nodes:
        return False
    for node in nodes:
        data = None
        if isinstance(node, MindMapNode):
            data = node.data
        elif isinstance(node, dict):
            data = node.get("data")
        else:
            data = getattr(node, "data", None)
        if not data:
            continue
        question_ids = data.get("questionIds") or data.get("question_ids")
        if isinstance(question_ids, list):
            for qid in question_ids:
                if qid not in (None, "", []):
                    return True
    return False


def ensure_question_flag(payload: dict) -> dict:
    """Ensure payload contains the has_question_refs marker."""

    if not isinstance(payload, dict):
        return payload
    if "has_question_refs" not in payload:
        payload["has_question_refs"] = _infer_question_refs_from_nodes(payload.get("nodes"))
    return payload


def _log_messages_preview(tag: str, messages: List[dict]) -> None:
    preview: List[dict] = []
    for m in messages:
        role = m.get("role")
        content = str(m.get("content", ""))
        preview.append({"role": role, "content": content[:200]})
    logger.info("%s messages_preview=%s", tag, preview)


_DATA_URL_LOG_RE = re.compile(r"^(data:[^;]+;base64,)([A-Za-z0-9+/=\s]+)$", re.IGNORECASE)


def _sanitize_log_value(value: Any, *, max_len: int = 1200) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        raw = value.strip()
        matched = _DATA_URL_LOG_RE.match(raw)
        if matched:
            prefix, payload = matched.group(1), matched.group(2)
            compact = re.sub(r"\s+", "", payload)
            head = compact[:24]
            return f"{prefix}{head}...[base64_len={len(compact)}]"
        if len(raw) <= max_len:
            return raw
        return raw[:max_len] + f"...[truncated {len(raw) - max_len} chars]"
    if isinstance(value, dict):
        return {str(k): _sanitize_log_value(v, max_len=max_len) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_sanitize_log_value(v, max_len=max_len) for v in value]
    return _sanitize_log_value(str(value), max_len=max_len)


_QUESTION_REF_PATTERNS = [
    re.compile(r"@题目(\d+)", re.IGNORECASE),
    re.compile(r"题目\s*#\s*(\d+)", re.IGNORECASE),
    re.compile(r"第\s*(\d+)\s*(?:题目|题|道|问)"),
]
_QUESTION_RANGE_PATTERN = re.compile(
    r"第\s*([0-9一二三四五六七八九十百零〇两、，,.-－—~～至到]+)\s*(?:题目|题|道|问)",
    re.IGNORECASE,
)
_FULLWIDTH_DIGIT_TRANS = str.maketrans({ord("０") + i: str(i) for i in range(10)})
_CHINESE_DIGITS = {
    "零": 0,
    "〇": 0,
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
}
_CHINESE_UNITS = {"十": 10, "百": 100, "千": 1000}


_app = get_compiled_agent_app()


def _extract_question_numbers(text: str | None) -> List[int]:
    if not text:
        return []
    normalized_text = text.translate(_FULLWIDTH_DIGIT_TRANS)
    found: set[int] = set()
    for pattern in _QUESTION_REF_PATTERNS:
        for match in pattern.findall(normalized_text):
            try:
                num = int(match)
            except (TypeError, ValueError):
                continue
            if num > 0:
                found.add(num)
    for match in _QUESTION_RANGE_PATTERN.finditer(normalized_text):
        chunk = match.group(1)
        for num in _parse_question_chunk(chunk):
            if num > 0:
                found.add(num)
    return sorted(found)


def _parse_question_chunk(chunk: str | None) -> List[int]:
    if not chunk:
        return []
    text = chunk.replace("、", ",").replace("，", ",")
    text = re.sub(r"\s+", "", text)
    text = re.sub(r"[～~－—–−至到]+", "-", text)
    tokens = [tok for tok in text.split(",") if tok]
    numbers: list[int] = []
    for token in tokens:
        if "-" in token:
            parts = [p for p in token.split("-") if p]
            if len(parts) != 2:
                continue
            start = _parse_single_question_number(parts[0])
            end = _parse_single_question_number(parts[1])
            if start is None or end is None:
                continue
            low, high = sorted((start, end))
            numbers.extend(range(low, high + 1))
            continue
        num = _parse_single_question_number(token)
        if num is not None:
            numbers.append(num)
    return numbers


def _parse_single_question_number(token: str | None) -> int | None:
    if token is None:
        return None
    stripped = token.strip()
    if not stripped:
        return None
    if stripped.isdigit():
        value = int(stripped)
        return value if value > 0 else None
    try:
        value = int(stripped)
        return value if value > 0 else None
    except (TypeError, ValueError):
        pass
    value = _chinese_numeral_to_int(stripped)
    if value is None or value <= 0:
        return None
    return value


def _chinese_numeral_to_int(token: str) -> int | None:
    if not token:
        return None
    total = 0
    current = 0
    for char in token:
        if char in _CHINESE_DIGITS:
            current = _CHINESE_DIGITS[char]
        elif char in _CHINESE_UNITS:
            unit_val = _CHINESE_UNITS[char]
            if current == 0:
                current = 1
            total += current * unit_val
            current = 0
        else:
            return None
    return total + current


def _collect_question_contexts(
    *,
    svc: AgentService,
    tenant_id: int,
    studio_document_id: int,
    question_numbers: List[int],
    question_index_map: dict,
) -> tuple[list[dict], list[dict]]:
    if not question_numbers or not studio_document_id:
        return [], []

    display_to_id = question_index_map.get("display_to_id") or {}
    contexts: list[dict] = []
    vision_candidates: list[dict] = []
    fetched_ids: set[int] = set()
    for display_num in question_numbers:
        question_id = display_to_id.get(display_num)
        if not question_id or question_id in fetched_ids:
            continue
        try:
            raw = svc.get_question_context(
                tenant_id=tenant_id,
                document_id=studio_document_id,
                question_id=question_id,
            )
        except HTTPException as exc:
            logger.warning(
                "question_context.fetch_failed tenant=%s studio_document=%s question_id=%s detail=%s",
                tenant_id,
                studio_document_id,
                question_id,
                getattr(exc, "detail", None),
            )
            continue
        fetched_ids.add(question_id)

        # 将题目上下文收缩为轻量快照，避免将冗长题干/解析反复灌入 LLM。
        if not isinstance(raw, dict):
            continue

        content = (raw.get("content") or "").strip()
        # 题干在此处做一次保守截断，后续 _build_doc_context 会再次控制展示长度。
        if len(content) > 800:
            content = content[:800]

        ctx: dict = {
            "question_id": raw.get("question_id") or raw.get("id") or question_id,
            "sequence_index": raw.get("sequence_index"),
            "display_index": display_num,
            "page": raw.get("page"),
            "content": content,
            "student_answer": raw.get("student_answer"),
            "grading": raw.get("grading"),
            "has_vision_asset": raw.get("has_vision_asset"),
            # legend_images 供 vision_node 使用，保持原样透传
            "legend_images": raw.get("legend_images"),
        }

        contexts.append(ctx)
        if ctx.get("has_vision_asset"):
            vision_candidates.append(ctx)
    return contexts, vision_candidates

_CONCLUSION_RE = re.compile(
    r"最终结论：\s*正确答案是\s*(?P<correct>[^，,。；;]+)\s*[，,]\s*学生答案是\s*(?P<student>[^，,。；;]+)\s*[，,]\s*判定为\s*(?P<verdict>正确|错误|无法确定)\s*(?:。|\.|$)"
)


def _extract_final_conclusion(reasoning: Optional[str]) -> dict | None:
    if not reasoning:
        return None
    lines = [line.strip() for line in reasoning.splitlines() if line.strip()]
    if not lines:
        return None
    last_line = lines[-1]
    match = _CONCLUSION_RE.search(last_line)
    if not match:
        return None
    verdict_text = match.group("verdict")
    judgement_map = {
        "正确": "correct",
        "错误": "incorrect",
        "无法确定": "uncertain",
    }
    judgement = judgement_map.get(verdict_text)
    if not judgement:
        return None
    return {
        "correct_answer": match.group("correct").strip(),
        "student_answer": match.group("student").strip(),
        "judgement": judgement,
    }


def _generate_mindmap_core(payload: MindMapRequest, db: Session) -> MindMapResponse:
    """Core implementation for generating a mind map.

    This function encapsulates the previous /v2/mindmap logic so it can be reused
    by other routers (e.g. generic /api/mindmaps endpoints) without duplicating
    the LLM and fulltext wiring.
    """

    file: File | None = None
    doc_for_cache: Document | None = None

    if payload.mode == "document":
        if not payload.studio_document_id:
            raise HTTPException(status_code=400, detail="studio_document_id 不能为空")

        doc_for_cache = (
            db.query(Document)
            .filter(Document.id == payload.studio_document_id)
            .first()
        )
        if doc_for_cache is None:
            raise HTTPException(status_code=404, detail="文档不存在")

        if doc_for_cache.file_id is None:
            raise HTTPException(
                status_code=400,
                detail="文档未绑定原始文件，无法生成思维导图",
            )

        file = db.query(File).filter(File.id == doc_for_cache.file_id).first()
        if file is None:
            raise HTTPException(status_code=404, detail="文档关联的文件不存在")

        # 命中缓存直接返回
        if doc_for_cache.mindmap_cache:
            try:
                cached_data = ensure_question_flag(json.loads(doc_for_cache.mindmap_cache))
                logger.info("mindmap: hit cache studio_document_id=%s", doc_for_cache.id)
                return MindMapResponse(**cached_data, cached=True)
            except Exception:
                logger.warning(
                    "mindmap: invalid cache for studio_document_id=%s, ignore",
                    doc_for_cache.id,
                )

    else:  # payload.mode == "file"
        if not payload.file_id:
            raise HTTPException(status_code=400, detail="file_id 不能为空")

        file = db.query(File).filter(File.id == payload.file_id).first()
        if file is None:
            raise HTTPException(status_code=404, detail="文件不存在")

        # 若该文件之前已被同步为某个 Document，则尽量复用以便缓存与题目概览
        doc_for_cache = (
            db.query(Document)
            .filter(Document.file_id == file.id)
            .order_by(Document.id.desc())
            .first()
        )

        # 如果找到了对应的 Document 且已有思维导图缓存，则直接复用
        if doc_for_cache is not None and doc_for_cache.mindmap_cache:
            try:
                cached_data = ensure_question_flag(json.loads(doc_for_cache.mindmap_cache))
                logger.info(
                    "mindmap: hit cache via file mode studio_document_id=%s file_id=%s",
                    doc_for_cache.id,
                    file.id,
                )
                return MindMapResponse(**cached_data, cached=True)
            except Exception:
                logger.warning(
                    "mindmap: invalid cache for studio_document_id=%s via file mode, ignore",
                    doc_for_cache.id,
                )

    assert file is not None  # for type checker

    # 2) 全文抽取
    fulltext_service = FulltextService(db)
    blocks = fulltext_service.get_or_extract_fulltext(file.id)
    if not blocks:
        raise HTTPException(status_code=400, detail="未能提取到文件全文内容")

    full_content = "\n\n".join(b.content for b in blocks if b.content)

    # 3) 题目内容（如有）——仅在基于 document 的模式下作为补充上下文
    questions: List[Question] = []
    if payload.mode == "document" and doc_for_cache is not None:
        questions = (
            db.query(Question)
            .filter(Question.document_id == doc_for_cache.id)
            .order_by(Question.sequence_index.asc())
            .all()
        )

    question_snippets: list[str] = []
    for q in questions:
        preview = (q.content or "").strip()
        if len(preview) > 400:
            preview = preview[:400] + "..."
        question_snippets.append(
            f"题目 {q.sequence_index + 1} (id={q.id}, page={q.page}):\n{preview}"
        )

    # 4) 构造 LLM 输入
    #
    # Groundbase 设计：基于真实树结构深度的思维导图生成
    # 前端会根据 parent_id 计算真实深度，而非依赖 type 字段
    # 因此模型只需要正确设置 parent_id 关系，前端会自动处理视觉层级
    #
    # 层级结构：
    # - 第 1 层：整份文档或课程主题（root）
    # - 第 2 层：单元 / 篇章 / 模块（结构性分组）
    # - 第 3 层：具体知识点
    # - 第 4 层：知识点的细化要点（type: detail）
    # - 第 5 层：进一步细化（type: sub_detail），仅在必要时
    json_template = (
        '{'
        '\n  "root_id": "k_root",'
        '\n  "nodes": ['
        '\n    {"id": "k_root", "label": "整份文档的主题", "type": "topic",'
        '\n     "parent_id": null, "side": "center", "data": {'
        '\n       "description": "一句话高度概括整份文档的主题",'
        '\n       "source": "可以是题号、页码或原文摘要",'
        '\n       "questionIds": [1, 2]'
        '\n     }},'
        '\n    {"id": "k1", "label": "某一部分或章节的主题", "type": "subtopic",'
        '\n     "parent_id": "k_root", "side": "left", "data": {'
        '\n       "description": "简短说明本部分内容（建议不超过约 40 个汉字）",'
        '\n       "source": "本部分在原文中的标题或位置说明"'
        '\n     }},'
        '\n    {"id": "k1_1", "label": "本部分下的第 1 个具体知识点", "type": "concept",'
        '\n     "parent_id": "k1", "data": {'
        '\n       "description": "用 1-2 句解释该知识点的含义或要点",'
        '\n       "source": "该知识点在原文中的小节标题或定位"'
        '\n     }},'
        '\n    {"id": "k1_1_1", "label": "知识点 k1_1 的第 1 个细化要点", "type": "detail",'
        '\n     "parent_id": "k1_1", "data": {'
        '\n       "description": "进一步细化该知识点的某个方面（例如：定义、作用、例子等）"'
        '\n     }},'
        '\n    {"id": "k1_1_1_1", "label": "对细化要点的进一步说明", "type": "sub_detail",'
        '\n     "parent_id": "k1_1_1", "data": {'
        '\n       "description": "仅在内容非常复杂时才添加第 5 层"'
        '\n     }},'
        '\n    {"id": "k1_2", "label": "本部分下的第 2 个具体知识点", "type": "concept",'
        '\n     "parent_id": "k1"}'
        '\n  ],'
        '\n  "edges": ['
        '\n    {"id": "e1", "source": "k_root", "target": "k1", "label": "包含", "type": "hierarchy"},'
        '\n    {"id": "e2", "source": "k1", "target": "k1_1", "label": "从属", "type": "hierarchy"},'
        '\n    {"id": "e3", "source": "k1_1", "target": "k1_1_1", "label": "细化", "type": "hierarchy"},'
        '\n    {"id": "e4", "source": "k1_1_1", "target": "k1_1_1_1", "label": "深化", "type": "hierarchy"}'
        '\n  ]'
        '\n}'
    )

    system_prompt = (
        "你是一个知识点提炼专家，负责将整份文档（试卷、讲义、学习笔记等）整理为知识点思维导图。"
        "\n\n请严格按如下 JSON 结构输出，仅输出 JSON 本身，不要包含 ``` 等 Markdown 包裹："
        "\n" + json_template +
        "\n分层要求（根据文档复杂度自适应）："
        "\n- 简单文档（知识点 < 10 个）：生成 3-4 层。"
        "\n- 中等文档（知识点 10-30 个）：生成 4 层。"
        "\n- 复杂文档（知识点 > 30 个）：生成 4-5 层。"
        "\n- 第 1 层：root（文档主题）。"
        "\n- 第 2 层：结构性分组（章节/单元/主题簇），2-7 个节点。"
        "\n- 第 3 层：具体知识点，每个分组下 2-8 个。"
        "\n- 第 4 层（可选）：知识点的细化要点（type: detail）。"
        "\n- 第 5 层（可选）：对第 4 层的进一步细化（type: sub_detail），仅在必要时。"
        "\n- 禁止把大量知识点直接挂在 root。"
        "\n- 每一对 parent_id 关系都必须在 edges 中有对应的边。"
        "\n- type 可使用：topic / subtopic / concept / detail / sub_detail / stage / timeline / question_ref / example。"
        "\n- 严禁输出除 JSON 以外的任何文字，严禁使用 ```json 或 ``` 包裹。"
    )

    user_parts: list[str] = []
    title = None
    if doc_for_cache is not None:
        title = (doc_for_cache.title or "未命名文档").strip()
    else:
        # 在仅文件模式下，退化为使用原始文件名作为标题
        title = getattr(file, "original_name", None) or "未命名文档"

    user_parts.append(f"文档标题：{title}")

    if question_snippets:
        user_parts.append("\n已解析出的题目：")
        user_parts.append("\n\n".join(question_snippets))

    user_parts.append("\n全文内容：")
    user_parts.append(full_content)

    user_content = "\n\n".join(user_parts)

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
    ]

    settings = get_settings()
    client = QwenClient(
        model=settings.alibaba_model_qwen_flash,
        max_output_tokens=30000,
    )
    document_identifier = getattr(doc_for_cache, "id", None)

    def persist_raw_reply(content: str | None, *, suffix: str) -> None:
        if not content:
            return
        try:
            logs_dir = Path(__file__).resolve().parent.parent / "logs"
            logs_dir.mkdir(parents=True, exist_ok=True)
            timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
            reply_path = logs_dir / f"mindmap_reply_{document_identifier or 'no_doc'}_{timestamp}_{suffix}.json"
            reply_path.write_text(content, encoding="utf-8")
            logger.info("mindmap: raw reply stored at %s", reply_path)
        except Exception:
            logger.exception("mindmap: failed to persist %s reply studio_document_id=%s", suffix, document_identifier)

    try:
        reply, usage = client.chat(messages)
        reply_length = len(reply or "")
        logger.info(
            "mindmap: qwen reply tokens=%s chars=%s studio_document_id=%s",
            getattr(usage, "output_tokens", None),
            reply_length,
            document_identifier,
        )
        persist_raw_reply(reply, suffix="success")
    except QwenRequestError as exc:
        logger.exception("mindmap: qwen chat failed studio_document_id=%s", document_identifier)
        persist_raw_reply(getattr(exc, "response_text", None), suffix="error")
        raise HTTPException(status_code=502, detail=f"知识点提炼失败: {exc}") from exc
    except Exception as exc:  # pragma: no cover - 网络/服务异常
        logger.exception("mindmap: qwen chat failed studio_document_id=%s", document_identifier)
        raise HTTPException(status_code=502, detail=f"知识点提炼失败: {exc}") from exc

    def sanitize_json_text(text: str) -> str:
        """Escape lone backslashes that break JSON decoding."""
        if not text:
            return text
        pattern = re.compile(r"(?<!\\)\\(?![\\\/\"bfnrtu])")
        return pattern.sub(r"\\\\", text)

    safe_reply = sanitize_json_text(reply or "")
    if safe_reply != (reply or ""):
        logger.warning(
            "mindmap: sanitized raw reply to escape invalid backslashes studio_document_id=%s",
            document_identifier,
        )

    try:
        data = ensure_question_flag(json.loads(safe_reply))
    except Exception as exc:
        preview = (reply or "")[:400]
        logger.exception(
            "mindmap: invalid JSON reply studio_document_id=%s preview=%s",
            getattr(doc_for_cache, "id", None),
            preview,
        )
        raise HTTPException(status_code=500, detail=f"模型返回非 JSON 内容: {exc}")

    # 5) 写入缓存
    if doc_for_cache is not None:
        try:
            doc_for_cache.mindmap_cache = json.dumps(data, ensure_ascii=False)
            doc_for_cache.mindmap_generated_at = datetime.utcnow()
            db.add(doc_for_cache)
            db.commit()
        except Exception:
            logger.exception(
                "mindmap: failed to persist cache studio_document_id=%s", doc_for_cache.id
            )

    return MindMapResponse(**data, cached=False)


@router.post("/v2/mindmap", response_model=MindMapResponse, dependencies=[Depends(mindmap_limit)])
def generate_mindmap(payload: MindMapRequest, db: Session = Depends(get_db)) -> MindMapResponse:
    """生成知识点思维导图（向后兼容的 HTTP 包装层）。"""

    doc_for_cache: Document | None = None
    if payload.mode == "document" and payload.studio_document_id:
        doc_for_cache = (
            db.query(Document)
            .filter(Document.id == payload.studio_document_id)
            .first()
        )
    elif payload.mode == "file" and payload.file_id:
        doc_for_cache = (
            db.query(Document)
            .filter(Document.file_id == payload.file_id)
            .order_by(Document.id.desc())
            .first()
        )

    if doc_for_cache and doc_for_cache.mindmap_cache:
        try:
            cached = ensure_question_flag(json.loads(doc_for_cache.mindmap_cache))
            logger.info(
                "mindmap: return cached result studio_document_id=%s mode=%s",
                doc_for_cache.id,
                payload.mode,
            )
            return MindMapResponse(**cached, cached=True)
        except Exception:
            logger.warning(
                "mindmap: cached json invalid studio_document_id=%s, regenerating",
                doc_for_cache.id,
            )

    return _generate_mindmap_core(payload, db)


class MindMapSaveRequest(BaseModel):
    """保存前端编辑后的思维导图结构。

    与 MindMapRequest 相同的定位信息 + 完整图结构，覆盖原有缓存。
    """

    mode: Literal["document", "file"] = "document"
    studio_document_id: Optional[int] = None
    file_id: Optional[int] = None
    root_id: Optional[str] = None
    nodes: List[MindMapNode]
    edges: List[MindMapEdge]


@router.post("/v2/mindmap/save", response_model=MindMapResponse)
def save_mindmap(payload: MindMapSaveRequest, db: Session = Depends(get_db)) -> MindMapResponse:
    """持久化已编辑的思维导图到 Document.mindmap_cache。

    若处于 document 模式，则要求有效的 studio_document_id；
    若处于 file 模式，则会寻找该文件最近同步出的 Document 并写入其缓存。
    """

    file: File | None = None
    doc_for_cache: Document | None = None

    if payload.mode == "document":
        if not payload.studio_document_id:
            raise HTTPException(status_code=400, detail="studio_document_id 不能为空")

        doc_for_cache = (
            db.query(Document).filter(Document.id == payload.studio_document_id).first()
        )
        if doc_for_cache is None:
            raise HTTPException(status_code=404, detail="文档不存在")

        file = doc_for_cache.file
    else:  # file 模式
        if not payload.file_id:
            raise HTTPException(status_code=400, detail="file_id 不能为空")

        file = db.query(File).filter(File.id == payload.file_id).first()
        if file is None:
            raise HTTPException(status_code=404, detail="文件不存在")

        doc_for_cache = (
            db.query(Document)
            .filter(Document.file_id == file.id)
            .order_by(Document.id.desc())
            .first()
        )

    if doc_for_cache is None:
        raise HTTPException(status_code=400, detail="当前模式下无法定位可写入的文档缓存")

    # 统一写入缓存
    data = {
        "root_id": payload.root_id,
        "nodes": [n.model_dump() for n in payload.nodes],
        "edges": [e.model_dump() for e in payload.edges],
    }

    try:
        doc_for_cache.mindmap_cache = json.dumps(data, ensure_ascii=False)
        doc_for_cache.mindmap_generated_at = datetime.utcnow()
        db.add(doc_for_cache)
        db.commit()
    except Exception:
        logger.exception(
            "mindmap: failed to persist edited cache studio_document_id=%s", doc_for_cache.id
        )
        raise HTTPException(status_code=500, detail="保存思维导图失败")

    return MindMapResponse(**data, cached=True)


@router.post("/run", response_model=AgentRunResponse, dependencies=[Depends(agent_run_limit)])
def agent_run(payload: AgentRunRequest, db: Session = Depends(get_db)) -> AgentRunResponse:
    assert_workroom_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
    )
    resolved_document_id = payload.studio_document_id
    logger.info(
        "agent_run start tenant=%s user=%s workroom=%s ui=%s studio_document_id=%s msg_count=%s",
        payload.tenant_id,
        payload.user_id,
        payload.workroom_id,
        payload.ui_context,
        resolved_document_id,
        len(payload.messages),
    )

    resolved_source_file_ids = resolve_source_file_ids(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        explicit_source_ids=list(payload.source_file_ids or []),
    )

    is_fresh_turn = is_fresh_conversation(payload.messages)

    session_id: int | None = payload.session_id
    thread_id: str | None = None
    view_id = payload.view_id or "default"

    session_profile: dict | None = None
    history_summary: str | None = None
    continuation_seed: dict = {}

    if view_id:
        try:
            runtime_ctx = resolve_run_runtime_context(
                db=db,
                tenant_id=payload.tenant_id,
                user_id=payload.user_id,
                workroom_id=payload.workroom_id,
                resolved_document_id=resolved_document_id,
                payload_session_id=session_id,
                is_fresh_turn=is_fresh_turn,
                view_id=view_id,
                unique_thread_fallback=False,
            )
            session_id = runtime_ctx.get("session_id")
            thread_id = runtime_ctx.get("thread_id")
            session_profile = runtime_ctx.get("session_profile")
            history_summary = runtime_ctx.get("history_summary")
            continuation_seed = runtime_ctx.get("continuation_seed") or {}
        except HTTPException as exc:
            logger.warning(
                "agent_run session_failed tenant=%s user=%s studio_document_id=%s view_id=%s detail=%s",
                payload.tenant_id,
                payload.user_id,
                resolved_document_id,
                view_id,
                getattr(exc, "detail", None),
            )

    if not thread_id:
        thread_id = build_run_thread_id(
            tenant_id=payload.tenant_id,
            user_id=payload.user_id,
            workroom_id=payload.workroom_id,
            studio_document_id=resolved_document_id,
            with_suffix=True,
        )

    messages = sanitize_conversation_messages(payload.messages)
    context = build_agent_router_context(
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        studio_document_id=resolved_document_id,
        source_file_ids=resolved_source_file_ids,
        ui_context=payload.ui_context,
        session_id=session_id,
        thread_id=thread_id,
        environment_model=build_agent_environment_model(
            db=db,
            tenant_id=payload.tenant_id,
            user_id=payload.user_id,
            workroom_id=payload.workroom_id,
            studio_document_id=resolved_document_id,
            source_file_ids=resolved_source_file_ids,
            ui_context=payload.ui_context,
        ),
    )
    if payload.agent_max_steps is not None and int(payload.agent_max_steps) > 0:
        context["agent_max_steps"] = int(payload.agent_max_steps)
    if session_profile:
        context["session_profile"] = session_profile
    if history_summary:
        context["history_summary"] = history_summary
    model_messages = [
        {"role": m["role"], "content": m["content"]}
        for m in messages
        if m["role"] in ("system", "user", "assistant")
    ]
    _log_messages_preview("agent_run.before_invoke", model_messages)

    config = {"configurable": {"thread_id": thread_id}}
    result = _app.invoke({**context, "messages": model_messages}, config=config)
    persist_agent_messages(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        session_id=session_id,
        result_messages=result["messages"],
    )
    return AgentRunResponse(
        session_id=session_id,
        messages=[AgentMessage(**m) for m in from_state_messages(result["messages"])],
        halt_reason=result.get("halt_reason"),
        interrupt_payload=result.get("interrupt_payload"),
        ag_ui_events=list(result.get("ag_ui_events") or []),
    )


# ===== Legacy-compatible tools: sync-question & snapshot =====


class QuestionSyncRequest(BaseModel):
    tenant_id: int
    user_id: int
    workroom_id: int
    studio_document_id: int | None = None
    session_id: int | None = None
    file_id: int | None = None
    question_id: int | None = None
    sequence_index: int
    page: int | None = None
    content: str
    legend_images: List[str] | None = None
    student_answer: str | None = None
    title: str | None = None
    source_type: str | None = None  # 'upload' 或 'favorite'


class EnsureDocumentRequest(BaseModel):
    tenant_id: int
    user_id: int
    workroom_id: int
    studio_document_id: int | None = None
    session_id: int | None = None
    file_id: int | None = None
    title: str | None = None
    source_type: str | None = None


class EnsureDocumentResponse(BaseModel):
    studio_document_id: int
    title: str


@router.post("/sync-question", dependencies=[Depends(sync_limit)])
def sync_question(payload: QuestionSyncRequest, db: Session = Depends(get_db)) -> dict:
    """与旧前端兼容的题目同步接口。

    使用 AgentService.sync_question 将 OCR 结果持久化为 questions/document，
    返回 studio_document_id 及题目 id/sequence_index。
    """

    assert_workroom_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
    )
    assert_studio_document_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        studio_document_id=payload.studio_document_id,
    )
    if payload.session_id is not None:
        session_ok = db.execute(
            text(
                """
                SELECT 1
                FROM extraction_sessions
                WHERE id = :session_id
                  AND tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND workroom_id = :workroom_id
                LIMIT 1
                """
            ),
            {
                "session_id": int(payload.session_id),
                "tenant_id": int(payload.tenant_id),
                "user_id": int(payload.user_id),
                "workroom_id": int(payload.workroom_id),
            },
        ).fetchone()
        if not session_ok:
            raise HTTPException(status_code=409, detail="session_id not in workroom scope")
    if payload.file_id is not None:
        file_ok = db.execute(
            text(
                """
                SELECT 1
                FROM workroom_source_bindings
                WHERE file_id = :file_id
                  AND tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND workroom_id = :workroom_id
                  AND is_active = TRUE
                LIMIT 1
                """
            ),
            {
                "file_id": int(payload.file_id),
                "tenant_id": int(payload.tenant_id),
                "user_id": int(payload.user_id),
                "workroom_id": int(payload.workroom_id),
            },
        ).fetchone()
        if not file_ok:
            raise HTTPException(status_code=409, detail="file_id not in workroom scope")

    svc = AgentService(db)
    document, question = svc.sync_question(
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        document_id=payload.studio_document_id,
        session_id=payload.session_id,
        file_id=payload.file_id,
        question_id=payload.question_id,
        sequence_index=payload.sequence_index,
        page=payload.page,
        content=payload.content,
        legend_images=payload.legend_images,
        student_answer=payload.student_answer,
        title=payload.title,
        source_type=payload.source_type,
    )
    return {
        "studio_document_id": document.id,
        "question": {
            "id": question.id,
            "sequence_index": question.sequence_index,
        },
    }


@router.post("/ensure-document", response_model=EnsureDocumentResponse)
def ensure_document(payload: EnsureDocumentRequest, db: Session = Depends(get_db)) -> EnsureDocumentResponse:
    assert_workroom_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
    )
    assert_studio_document_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        studio_document_id=payload.studio_document_id,
    )
    if payload.session_id is not None:
        session_ok = db.execute(
            text(
                """
                SELECT 1
                FROM extraction_sessions
                WHERE id = :session_id
                  AND tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND workroom_id = :workroom_id
                LIMIT 1
                """
            ),
            {
                "session_id": int(payload.session_id),
                "tenant_id": int(payload.tenant_id),
                "user_id": int(payload.user_id),
                "workroom_id": int(payload.workroom_id),
            },
        ).fetchone()
        if not session_ok:
            raise HTTPException(status_code=409, detail="session_id not in workroom scope")
    if payload.file_id is not None:
        file_ok = db.execute(
            text(
                """
                SELECT 1
                FROM workroom_source_bindings
                WHERE file_id = :file_id
                  AND tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND workroom_id = :workroom_id
                  AND is_active = TRUE
                LIMIT 1
                """
            ),
            {
                "file_id": int(payload.file_id),
                "tenant_id": int(payload.tenant_id),
                "user_id": int(payload.user_id),
                "workroom_id": int(payload.workroom_id),
            },
        ).fetchone()
        if not file_ok:
            raise HTTPException(status_code=409, detail="file_id not in workroom scope")
    svc = AgentService(db)
    svc.require_active_subscription(payload.tenant_id)

    if payload.source_type == "favorite" and payload.studio_document_id is None:
        document = svc._ensure_favorite_document(
            tenant_id=payload.tenant_id,
            user_id=payload.user_id,
            workroom_id=payload.workroom_id,
            title=payload.title,
        )
    else:
        document = svc._ensure_document(
            tenant_id=payload.tenant_id,
            user_id=payload.user_id,
            workroom_id=payload.workroom_id,
            document_id=payload.studio_document_id,
            session_id=payload.session_id,
            file_id=payload.file_id,
            title=payload.title,
        )

    return EnsureDocumentResponse(studio_document_id=document.id, title=document.title)


@router.post("/snapshot", dependencies=[Depends(snapshot_limit)])
def get_snapshot(payload: SnapshotRequest, db: Session = Depends(get_db)) -> dict:
    """返回指定试卷的题目快照，兼容旧前端 AgentSnapshotResponse 结构。"""
    assert_workroom_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
    )
    assert_studio_document_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        studio_document_id=payload.studio_document_id,
    )

    svc = AgentService(db)
    document, questions = svc.get_snapshot(
        tenant_id=payload.tenant_id,
        document_id=payload.studio_document_id,
    )

    def _parse_legend_images(raw: str | None) -> List[str]:
        import json

        if not raw:
            return []
        try:
            val = json.loads(raw)
            if isinstance(val, list):
                return [str(x) for x in val]
        except Exception:  # noqa: BLE001 - 容错
            pass
        return []

    return {
        "studio_document_id": document.id,
        "title": document.title,
        "status": document.status,
        "questions": [
            {
                "id": q.id,
                "sequenceIndex": q.sequence_index,
                "groupId": getattr(q, "group_id", None),
                "page": q.page,
                "content": q.content,
                "legendImages": _parse_legend_images(q.legend_images),
                "studentAnswer": getattr(q, "student_answer", None),
                "gradingJudgement": getattr(q, "grading_judgement", None),
                "gradingPredictedAnswer": getattr(q, "grading_predicted_answer", None),
                "gradingReasoning": getattr(q, "grading_reasoning", None),
                "gradingConfidence": getattr(q, "grading_confidence", None),
                "versions": getattr(q, "versions", []) or [],
            }
            for q in questions
        ],
    }


@router.post("/delete-question", dependencies=[Depends(sync_limit)])
def delete_question(payload: DeleteQuestionRequest, db: Session = Depends(get_db)) -> dict:
    """删除单道题目，供前端题卡删除后同步更新 agent 快照使用。"""
    assert_workroom_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
    )
    assert_studio_document_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        studio_document_id=payload.studio_document_id,
    )

    svc = AgentService(db)
    svc.delete_question(
        tenant_id=payload.tenant_id,
        document_id=payload.studio_document_id,
        question_id=payload.question_id,
    )
    return {"ok": True}


GRADING_SYSTEM_PROMPT = (
    "你是一个严格的数学/理科阅卷老师，负责对单道题的作答进行机器阅卷。"
    "你会拿到：题目原文、（可选的）图像文字描述、以及学生答案。"
    "你的任务是：先在可见的 reasoning 中完整推理出该题的正确答案，再根据该最终推理结论，给出结构化的 JSON 判定结果。"
    "\n\n【判分规则（务必遵守）】"
    "1. 请在 reasoning 中用中文分步骤且简洁地推理。允许进行至多一次简短复查，但不要多次反复推翻之前的结论。最后必须明确给出："
    "   - 你最终认可的正确答案 correct_answer（例如：正确答案是 C，或正确答案是 1 等）；"
    "   - 学生答案是否等于 correct_answer，以及因此学生作答是正确/错误/无法确定。"
    "2. 完成推理后，根据该结论填写 JSON："
    "   - predicted_answer 必须等于你在 reasoning 最后给出的正确答案；"
    "   - judgement 必须与 reasoning 最后一行的结论完全一致（只能为 'correct', 'incorrect', 'skipped', 'uncertain'）；"
    "   - 严禁出现 reasoning 的最终结论与 JSON 中的 predicted_answer 或 judgement 相矛盾的情况。"
    "3. 将学生答案 student_answer 与 correct_answer 做严格比较："
    "   - 若能够明确比较且二者相同，则 judgement 必须为 'correct'；"
    "   - 若能够明确比较且二者不同，则 judgement 必须为 'incorrect'；"
    "   - 若题目信息不足或存在多解、无解等情况，无法可靠判断对错时，judgement 必须为 'uncertain'；"
    "   - 学生未作答在上游已处理，这里不会出现 judgement='skipped' 的场景。"
    "4. reasoning 内容需覆盖：求解过程 + 正确答案 + 学生答案为何被判为当前 judgement，并避免无意义的来回修改。"
    "5. 在 reasoning 的最后一行必须使用固定格式总结："
    "   “最终结论：正确答案是 {correct_answer}，学生答案是 {student_answer}，判定为 {正确/错误/无法确定}。”"
    "   其中 {correct_answer}、{student_answer}、{判定为…} 均需与 JSON 字段完全一致。"
    "6. confidence 为 0~1 之间的小数，表示你对当前判定的主观把握程度（例如 0.95）。"
    "7. reasoning 不宜过长，通常 8~12 行推理即可，确保逻辑清晰。"
    "\n\n【输出要求】"
    "- 最终回复中必须只输出一个 JSON 对象，不能包含任何 JSON 之外的额外文本、评论或 Markdown。"
    "- JSON 字段必须完整且仅包含：predicted_answer, judgement, confidence, reasoning。"
    "- judgement 取值只能是: 'correct', 'incorrect', 'skipped', 'uncertain' 之一（小写）。"
    '示例 JSON：{"predicted_answer": "C", "judgement": "incorrect", "confidence": 0.87, "reasoning": "……最终结论：正确答案是 C，学生答案是 A，判定为 错误。"}'
)


def _parse_json_response(payload: str) -> dict:
    text = payload.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            snippet = text[start : end + 1]
            return json.loads(snippet)
        raise


@router.post("/split-questions", response_model=SplitQuestionsResponse, dependencies=[Depends(split_limit)])
def split_questions(
    payload: SplitQuestionsRequest, db: Session = Depends(get_db)
) -> SplitQuestionsResponse:
    svc = AgentService(db)
    svc.require_active_subscription(payload.tenant_id)

    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text 不能为空")

    max_q = payload.max_questions or 20

    system_prompt = (
        "你是一个试卷整理助手，负责将一段可能包含多道题目的中文文本拆分成可以独立编辑的题目块。"
        "题目可能是选择题、填空题、解答题等，你需要根据题号、结构和语义判断题目边界。"
        "输出必须是一个 JSON 对象，形如：{\"questions\":[{\"index\":1,\"text\":\"...\"}, ...]}。"
        "只输出 JSON，不要包含任何额外解释、注释或 Markdown。"
        "每个 text 字段应包含该题目的完整题干，可以保留题号和选项。"
        "不要把不同题目合并为一题，也不要把同一题拆得过细（例如将一个大题拆成多个无意义的碎片）。"
    )

    user_prompt_lines = [
        "下面是一段可能包含多道试题的文本，请按\"单道题\"的粒度进行拆分：",
        "\n【原始文本】\n",
        text,
        "\n【任务要求】\n",
        "1. 仔细识别题号（如：1.、2、（1）、一、二、三等）和题干结构，推断题目边界。",
        "2. 每道题的 text 中应包含完整题干以及紧随其后的与本题紧密相关的内容（包括选项）。",
        "3. 如果无法明显拆出多题，则只输出一条 questions，text 为原文或适度清理后的完整文本。",
        "4. 最多返回",
        str(max_q),
        "道题目，多余的题目可以忽略。",
        "5. 严格按照 {\"questions\":[{\"index\":number,\"text\":string}]} 的结构输出 JSON，不要输出任何多余文字。",
    ]
    user_prompt = "".join(user_prompt_lines)

    client = QwenClient()
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    raw_response = ""
    try:
        raw_response, _usage = client.chat(messages, temperature=0.1, top_p=0.8)
        parsed = _parse_json_response(raw_response)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "split_questions failed tenant=%s user=%s error=%s raw_preview=%s",
            payload.tenant_id,
            payload.user_id,
            exc,
            (raw_response[:300] + "...") if raw_response else "",
        )
        raise HTTPException(status_code=500, detail="LLM 返回结果解析失败") from exc

    items = parsed.get("questions")
    questions: List[SplitQuestionItem] = []
    if isinstance(items, list):
        for i, item in enumerate(items, start=1):
            if not isinstance(item, dict):
                continue
            text_val = str(item.get("text", "")).strip()
            if not text_val:
                continue
            idx_raw = item.get("index")
            try:
                idx = int(idx_raw) if idx_raw is not None else i
            except (TypeError, ValueError):
                idx = i
            questions.append(SplitQuestionItem(index=idx, text=text_val))

    if not questions:
        questions.append(SplitQuestionItem(index=1, text=text))

    questions = questions[:max_q]
    return SplitQuestionsResponse(questions=questions)


@router.post("/grade", response_model=GradeRunResponse, dependencies=[Depends(grade_limit)])
def grade_document(payload: GradeRunRequest, db: Session = Depends(get_db)) -> GradeRunResponse:
    if not payload.questions:
        raise HTTPException(status_code=400, detail="无题目可批改")

    svc = AgentService(db)
    # 仅用于校验订阅状态
    svc.require_active_subscription(payload.tenant_id)
    assert_workroom_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
    )
    assert_studio_document_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        studio_document_id=payload.studio_document_id,
    )

    client = QwenClient()
    results: List[GradeQuestionResult] = []

    for q in payload.questions:
        seq = q.sequence_index
        user_answer = (q.user_answer or "").strip()
        if not q.content.strip():
            results.append(
                GradeQuestionResult(
                    sequence_index=seq,
                    judgement="error",
                    error="题目内容为空，无法批改",
                )
            )
            if payload.studio_document_id is not None:
                svc.update_question_grading(
                    tenant_id=payload.tenant_id,
                    document_id=payload.studio_document_id,
                    sequence_index=seq,
                    student_answer=user_answer or None,
                    judgement="error",
                    predicted_answer=None,
                    reasoning="题目内容为空，无法批改",
                    confidence=None,
                )
            continue

        if not user_answer:
            results.append(
                GradeQuestionResult(
                    sequence_index=seq,
                    judgement="skipped",
                    predicted_answer=None,
                    reasoning="学生未作答",
                    confidence=None,
                )
            )
            if payload.studio_document_id is not None:
                svc.update_question_grading(
                    tenant_id=payload.tenant_id,
                    document_id=payload.studio_document_id,
                    sequence_index=seq,
                    student_answer=None,
                    judgement="skipped",
                    predicted_answer=None,
                    reasoning="学生未作答",
                    confidence=None,
                )
            continue

        user_prompt_lines = [
            "【题目】",
            q.content.strip(),
        ]
        user_prompt_lines.append("\n【学生答案】")
        user_prompt_lines.append(user_answer)
        user_prompt_lines.append(
            "\n请根据题目与学生答案判断对错，并填充指定 JSON。不要输出多余文字。"
        )
        user_prompt = "\n".join(user_prompt_lines)

        messages = [
            {"role": "system", "content": GRADING_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ]

        raw_response = ""
        try:
            raw_response, _usage = client.chat(messages, temperature=0.2, top_p=0.8)
            logger.info(
                "grade raw_response seq=%s length=%s raw=%s",
                seq,
                len(raw_response),
                raw_response,
            )
            parsed = _parse_json_response(raw_response)
            logger.info("grade parsed seq=%s parsed=%s", seq, parsed)
            judgement = str(parsed.get("judgement", "")).strip().lower()
            if judgement not in {"correct", "incorrect", "skipped", "uncertain"}:
                judgement = "uncertain"
            predicted_answer = parsed.get("predicted_answer")
            reasoning = parsed.get("reasoning")
            reasoning_text = str(reasoning).strip() if reasoning is not None else ""
            confidence = parsed.get("confidence")
            try:
                confidence_val = float(confidence) if confidence is not None else None
            except (TypeError, ValueError):
                confidence_val = None

            conclusion = _extract_final_conclusion(reasoning_text)
            if not conclusion:
                error_msg = "LLM reasoning 缺少固定格式的最终结论，拒绝采纳本次批改结果。"
                logger.warning(
                    "grade canonical_failed seq=%s reason=%s raw_preview=%s",
                    seq,
                    error_msg,
                    (raw_response[:300] + "...") if len(raw_response) > 300 else raw_response,
                )
                results.append(
                    GradeQuestionResult(
                        sequence_index=seq,
                        judgement="error",
                        error=error_msg,
                        raw_response=raw_response,
                        reasoning=reasoning_text or None,
                    )
                )
                if payload.studio_document_id is not None:
                    svc.update_question_grading(
                        tenant_id=payload.tenant_id,
                        document_id=payload.studio_document_id,
                        sequence_index=seq,
                        student_answer=user_answer or None,
                        judgement="error",
                        predicted_answer=None,
                        reasoning=error_msg,
                        confidence=None,
                    )
                continue

            final_predicted = conclusion["correct_answer"]
            final_judgement = conclusion["judgement"]
            conclusion_student_answer = conclusion["student_answer"]

            if str(predicted_answer).strip() != final_predicted:
                logger.warning(
                    "grade predicted_mismatch seq=%s json_pred=%s conclusion_pred=%s",
                    seq,
                    predicted_answer,
                    final_predicted,
                )
            if judgement != final_judgement:
                logger.warning(
                    "grade judgement_mismatch seq=%s json_judgement=%s conclusion_judgement=%s",
                    seq,
                    judgement,
                    final_judgement,
                )
            if conclusion_student_answer and conclusion_student_answer.strip() != user_answer:
                logger.warning(
                    "grade student_answer_mismatch seq=%s conclusion_student=%s user_answer=%s",
                    seq,
                    conclusion_student_answer,
                    user_answer,
                )
            judgement = final_judgement
            predicted_answer = final_predicted
            reasoning = reasoning_text

            # 详细记录每道题的批改结果，便于排查 judgement 与解析文字不一致的问题。
            logger.info(
                "grade result seq=%s judgement=%s predicted=%s user_answer=%s confidence=%s raw_preview=%s",
                seq,
                judgement,
                predicted_answer,
                user_answer,
                confidence_val,
                (raw_response[:300] + "...") if len(raw_response) > 300 else raw_response,
            )

            results.append(
                GradeQuestionResult(
                    sequence_index=seq,
                    judgement=judgement,  # type: ignore[arg-type]
                    predicted_answer=predicted_answer,
                    reasoning=reasoning,
                    confidence=confidence_val,
                    raw_response=raw_response,
                )
            )

            if payload.studio_document_id is not None:
                svc.update_question_grading(
                    tenant_id=payload.tenant_id,
                    document_id=payload.studio_document_id,
                    sequence_index=seq,
                    student_answer=user_answer or None,
                    judgement=judgement,
                    predicted_answer=str(predicted_answer) if predicted_answer is not None else None,
                    reasoning=str(reasoning) if reasoning is not None else None,
                    confidence=confidence_val,
                )
        except Exception as exc:  # noqa: BLE001
            logger.exception("grade question failed seq=%s", seq)
            results.append(
                GradeQuestionResult(
                    sequence_index=seq,
                    judgement="error",
                    error=str(exc),
                    raw_response=raw_response or None,
                )
            )

            if payload.studio_document_id is not None:
                svc.update_question_grading(
                    tenant_id=payload.tenant_id,
                    document_id=payload.studio_document_id,
                    sequence_index=seq,
                    student_answer=user_answer or None,
                    judgement="error",
                    predicted_answer=None,
                    reasoning=str(exc),
                    confidence=None,
                )

    return GradeRunResponse(results=results)


@router.post("/run-stream", dependencies=[Depends(agent_stream_limit)])
def agent_run_stream(payload: AgentRunRequest, db: Session = Depends(get_db)) -> StreamingResponse:
    """流式输出版本的 Agent 接口。

    - 与 /run 使用相同的请求体（tenant_id/user_id/workroom_id/ui_context/studio_document_id/messages）。
    - 在服务端拼好 SYSTEM_PROMPT + 试卷快照 + 对话历史，然后通过 QwenClient.chat_stream
      将生成的文本逐块推送给前端。
    """

    assert_workroom_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
    )
    assert_studio_document_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        studio_document_id=payload.studio_document_id,
    )
    logger.info(
        "agent_run_stream start tenant=%s user=%s workroom=%s ui=%s studio_document_id=%s msg_count=%s",
        payload.tenant_id,
        payload.user_id,
        payload.workroom_id,
        payload.ui_context,
        payload.studio_document_id,
        len(payload.messages),
    )

    conversation_messages: list[dict] = []
    resolved_document_id = payload.studio_document_id
    resolved_source_file_ids = resolve_source_file_ids(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        explicit_source_ids=list(payload.source_file_ids or []),
    )

    is_fresh_turn = is_fresh_conversation(payload.messages)

    stream_queue: "queue.Queue[dict | None]" = queue.Queue()

    session_id: int | None = payload.session_id
    thread_id: str | None = None
    view_id = payload.view_id or "default"
    session_profile: dict | None = None
    history_summary: str | None = None

    if view_id:
        try:
            runtime_ctx = resolve_run_runtime_context(
                db=db,
                tenant_id=payload.tenant_id,
                user_id=payload.user_id,
                workroom_id=payload.workroom_id,
                resolved_document_id=resolved_document_id,
                payload_session_id=session_id,
                is_fresh_turn=is_fresh_turn,
                view_id=view_id,
                unique_thread_fallback=True,
            )
            session_id = runtime_ctx.get("session_id")
            thread_id = runtime_ctx.get("thread_id")
            session_profile = runtime_ctx.get("session_profile")
            history_summary = runtime_ctx.get("history_summary")
        except HTTPException as exc:  # pragma: no cover - 容错
            logger.warning(
                "agent_run_stream session_failed tenant=%s user=%s studio_document_id=%s view_id=%s detail=%s",
                payload.tenant_id,
                payload.user_id,
                resolved_document_id,
                view_id,
                getattr(exc, "detail", None),
            )

    if not thread_id:
        thread_id = build_run_thread_id(
            tenant_id=payload.tenant_id,
            user_id=payload.user_id,
            workroom_id=payload.workroom_id,
            studio_document_id=resolved_document_id,
            with_suffix=True,
        )

    for m in sanitize_conversation_messages(payload.messages):
        role = m["role"] if m["role"] in ("system", "user", "assistant") else "user"
        conversation_messages.append({"role": role, "content": m["content"]})

    _log_messages_preview("agent_run_stream.before_qwen", conversation_messages)

    config = {"configurable": {"thread_id": thread_id}}

    def run_graph_thread() -> None:
        start_ts = time.time()
        db_local = SessionLocal()
        try:
            # 模型输入窗口：只使用规范化的 user/assistant 历史，不包含占位。
            model_messages = [
                {"role": m["role"], "content": m["content"]}
                for m in conversation_messages
                if m["role"] in ("system", "user", "assistant")
            ]
            logger.info(
                "agent_run_stream.graph_thread_start tenant=%s user=%s session=%s thread=%s base_len=%s window_len=%s",
                payload.tenant_id,
                payload.user_id,
                session_id,
                thread_id,
                len(model_messages),
                len(model_messages),
            )
            context = build_agent_router_context(
                tenant_id=payload.tenant_id,
                user_id=payload.user_id,
                workroom_id=payload.workroom_id,
                studio_document_id=resolved_document_id,
                source_file_ids=resolved_source_file_ids,
                ui_context=payload.ui_context,
                session_id=session_id,
                thread_id=thread_id,
                environment_model=build_agent_environment_model(
                    db=db_local,
                    tenant_id=payload.tenant_id,
                    user_id=payload.user_id,
                    workroom_id=payload.workroom_id,
                    studio_document_id=resolved_document_id,
                    source_file_ids=resolved_source_file_ids,
                    ui_context=payload.ui_context,
                ),
            )
            if payload.agent_max_steps is not None and int(payload.agent_max_steps) > 0:
                context["agent_max_steps"] = int(payload.agent_max_steps)
            if session_profile:
                context["session_profile"] = session_profile
            if history_summary:
                context["history_summary"] = history_summary
            logger.info(
                "agent_run_stream.environment tenant=%s user=%s thread=%s env_summary=%s",
                payload.tenant_id,
                payload.user_id,
                thread_id,
                {
                    "active_surface": ((context.get("environment") or {}).get("active_surface")),
                    "studio_document_id": context.get("studio_document_id"),
                    "source_count": len(list(context.get("source_file_ids") or [])),
                },
            )
            streamed_messages: list[Any] = []
            emitted_text: dict[str, str] = {}
            trace_reducer = StreamTraceReducer()
            emitted_final_text = False
            stream_stats = {"events_total": 0, "assistant_chunks": 0, "agent_traces": 0, "ag_ui": 0}
            stream = _app.stream(
                {**context, "messages": model_messages},
                config=config,
                stream_mode=["messages", "updates", "custom"],
            )
            for raw_event in stream:
                mode, event_payload = normalize_stream_event(raw_event)
                stream_stats["events_total"] += 1
                if mode == "custom" and isinstance(event_payload, dict):
                    stream_type = str(event_payload.get("stream_type") or "").strip().lower()
                    if stream_type == "assistant_delta":
                        delta = str(event_payload.get("delta") or "")
                        if delta:
                            stream_stats["assistant_chunks"] += 1
                    elif stream_type == "thinking_delta":
                        content = str(event_payload.get("content") or "")
                        if content:
                            stream_stats["agent_traces"] += 1
                            stream_queue.put(
                                {
                                    "type": "agent_trace",
                                    "payload": {
                                        "trace_type": "model_native_thinking",
                                        "node": str(event_payload.get("node") or "decide"),
                                        "content": content,
                                    },
                                }
                            )
                    elif stream_type == "tool_call":
                        stream_stats["agent_traces"] += 1
                        stream_queue.put(
                            {
                                "type": "agent_trace",
                                "payload": {
                                    "trace_type": "tool_call",
                                    "node": str(event_payload.get("node") or "execute_tools"),
                                    "tool_name": event_payload.get("tool_name"),
                                    "status": event_payload.get("status"),
                                    "tool_call_id": event_payload.get("tool_call_id"),
                                    "observation": event_payload.get("observation"),
                                    "query": event_payload.get("query"),
                                },
                            }
                        )
                    continue
                trace_events = trace_reducer.reduce(iter_stream_trace_events(mode, event_payload))
                for trace_event in trace_events:
                    kind = trace_event.get("kind")
                    if kind == "assistant_text":
                        message_id = str(trace_event.get("id") or "")
                        text = str(trace_event.get("text") or "")
                        if not text:
                            continue
                        previous = emitted_text.get(message_id, "")
                        delta = text
                        if message_id and previous and text.startswith(previous):
                            delta = text[len(previous):]
                        if not delta:
                            continue
                        emitted_text[message_id] = previous + delta if message_id else previous
                        stream_stats["assistant_chunks"] += 1
                        stream_queue.put({"type": "delta", "role": "assistant", "delta": delta})
                        continue
                    if kind == "agent_trace":
                        trace_payload = trace_event.get("payload")
                        if not isinstance(trace_payload, dict) or not trace_payload:
                            continue
                        trace_type = str(trace_payload.get("trace_type") or "").strip().lower()
                        if trace_type == "tool_call":
                            stream_stats["agent_traces"] += 1
                            stream_queue.put({"type": "agent_trace", "payload": trace_payload})
                        elif trace_type == "model_event":
                            tool_calls = trace_payload.get("tool_calls")
                            if isinstance(tool_calls, list) and tool_calls:
                                stream_stats["agent_traces"] += 1
                                stream_queue.put({"type": "agent_trace", "payload": trace_payload})
                        continue
                    if kind == "ag_ui":
                        event_obj = trace_event.get("event")
                        if isinstance(event_obj, dict):
                            stream_stats["ag_ui"] += 1
                            stream_queue.put({"type": "ag_ui", "event": event_obj})
                        continue
                if mode == "updates" and isinstance(event_payload, dict):
                    for node_update in event_payload.values():
                        if not isinstance(node_update, dict):
                            continue
                        messages = node_update.get("messages")
                        if isinstance(messages, list):
                            streamed_messages = messages
            result = {"messages": streamed_messages}
            persist_agent_messages(
                db=db_local,
                tenant_id=payload.tenant_id,
                user_id=payload.user_id,
                session_id=session_id,
                result_messages=result["messages"],
            )
            visible = from_state_messages(result["messages"])
            final_reply = ""
            for item in reversed(visible):
                if str(item.get("role") or "").strip().lower() == "assistant":
                    final_reply = str(item.get("content") or "").strip()
                    if final_reply:
                        break
            if final_reply and not emitted_final_text:
                stream_queue.put({"type": "delta", "role": "assistant", "delta": final_reply})
                emitted_final_text = True
            logger.info(
                "agent_run_stream.summary tenant=%s user=%s thread=%s stats=%s final_reply_len=%s",
                payload.tenant_id,
                payload.user_id,
                thread_id,
                stream_stats,
                len(final_reply or ""),
            )
        except Exception:
            logger.exception("agent_run_stream.graph_failed tenant=%s user=%s", payload.tenant_id, payload.user_id)
            stream_queue.put(
                {
                    "type": "error",
                    "message": "agent_runtime_error",
                }
            )
        finally:
            db_local.close()
            duration = (time.time() - start_ts) * 1000
            logger.info(
                "agent_run_stream.graph_thread_finish tenant=%s user=%s thread=%s duration_ms=%.2f",
                payload.tenant_id,
                payload.user_id,
                thread_id,
                duration,
            )
            stream_queue.put(None)

    threading.Thread(target=run_graph_thread, daemon=True).start()

    def merged_stream():
        # 首先向前端发送一次会话事件，告知本次对话对应的 session_id，便于后续 resume。
        if session_id is not None:
            yield json.dumps(
                {
                    "type": "session",
                    "session_id": session_id,
                    "studio_document_id": resolved_document_id,
                    "workroom_id": payload.workroom_id,
                },
                ensure_ascii=False,
            ) + "\n"

        while True:
            item = stream_queue.get()
            if item is None:
                break
            yield json.dumps(item, ensure_ascii=False) + "\n"

    return StreamingResponse(merged_stream(), media_type="text/plain; charset=utf-8")


@router.get("/sessions", response_model=AgentSessionListResponse)
def list_agent_sessions(
    tenant_id: int,
    user_id: int,
    workroom_id: int | None = None,
    studio_document_id: int | None = None,
    view_id: str | None = None,
    include_archived: bool = False,
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db),
) -> AgentSessionListResponse:
    """列出当前用户的 Agent 会话列表。

    - 按 tenant_id + user_id 做强隔离；
    - 可选按 studio_document_id/view_id 过滤；
    - 默认仅返回未归档会话。
    """

    svc = AgentService(db)
    sessions = svc.list_sessions(
        tenant_id=tenant_id,
        user_id=user_id,
        workroom_id=workroom_id,
        document_id=studio_document_id,
        view_id=view_id,
        include_archived=include_archived,
        limit=min(max(limit, 1), 200),
        offset=max(offset, 0),
    )

    items: list[AgentSessionMeta] = []
    for s in sessions:
        items.append(
            AgentSessionMeta(
                id=s.id,
                tenant_id=s.tenant_id,
                user_id=s.user_id,
                studio_document_id=s.document_id,
                view_id=s.view_id,
                title=getattr(s, "title", None),
                last_message_preview=getattr(s, "last_message_preview", None),
                message_count=getattr(s, "message_count", 0) or 0,
                status=s.status,
                archived=bool(getattr(s, "archived", False)),
                created_at=s.created_at,
                updated_at=s.updated_at,
            )
        )

    return AgentSessionListResponse(sessions=items)


@router.patch("/sessions/{session_id}", response_model=AgentSessionMeta)
def update_agent_session(
    session_id: int,
    payload: AgentSessionUpdateRequest,
    db: Session = Depends(get_db),
) -> AgentSessionMeta:
    """更新指定会话的元数据（标题 / 归档状态 / 自定义状态）。"""

    svc = AgentService(db)
    session = svc.update_session(
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        session_id=session_id,
        title=payload.title,
        archived=payload.archived,
        status=payload.status,
    )

    return AgentSessionMeta(
        id=session.id,
        tenant_id=session.tenant_id,
        user_id=session.user_id,
        studio_document_id=session.document_id,
        view_id=session.view_id,
        title=getattr(session, "title", None),
        last_message_preview=getattr(session, "last_message_preview", None),
        message_count=getattr(session, "message_count", 0) or 0,
        status=session.status,
        archived=bool(getattr(session, "archived", False)),
        created_at=session.created_at,
        updated_at=session.updated_at,
    )


class AgentSessionDeleteRequest(BaseModel):
    tenant_id: int
    user_id: int


@router.delete("/sessions/{session_id}")
def delete_agent_session(
    session_id: int,
    payload: AgentSessionDeleteRequest,
    db: Session = Depends(get_db),
) -> dict:
    """软删除指定会话：标记为 deleted/archived，但保留历史记录。"""

    svc = AgentService(db)
    svc.soft_delete_session(
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        session_id=session_id,
    )
    return {"ok": True}


@router.get("/sessions/{session_id}/messages", response_model=AgentSessionMessagesResponse)
def get_agent_session_messages(
    session_id: int,
    tenant_id: int,
    user_id: int,
    limit: int = 200,
    db: Session = Depends(get_db),
) -> AgentSessionMessagesResponse:
    """返回指定会话的历史消息列表（按时间正序）。"""

    svc = AgentService(db)
    # 校验会话归属，避免跨租户/跨用户访问
    svc.get_session(tenant_id=tenant_id, session_id=session_id, user_id=user_id)

    raw_messages = svc.list_messages(
        tenant_id=tenant_id,
        session_id=session_id,
        limit=min(max(limit, 1), 500),
    )

    # list_messages 默认按 id 倒序，这里翻转为时间正序
    raw_messages = list(sorted(raw_messages, key=lambda m: m.id))

    items: list[AgentHistoryMessage] = []
    for m in raw_messages:
        items.append(
            AgentHistoryMessage(
                id=m.id,
                role=m.role,  # 已由 AgentService 保证 role 为简单字符串
                content=m.content,
                created_at=m.created_at,
            )
        )

    return AgentSessionMessagesResponse(session_id=session_id, messages=items)


@router.post("/run-resume", response_model=AgentRunResponse, dependencies=[Depends(agent_resume_limit)])
def agent_run_resume(payload: AgentResumeRequest, db: Session = Depends(get_db)) -> AgentRunResponse:
    assert_workroom_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
    )
    assert_studio_document_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        studio_document_id=payload.studio_document_id,
    )

    runtime_ctx = resolve_resume_runtime_context(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        payload_thread_id=payload.thread_id,
        payload_session_id=payload.session_id,
        studio_document_id=payload.studio_document_id,
    )
    session_id = runtime_ctx.get("session_id")
    thread_id = str(runtime_ctx.get("thread_id") or "").strip()
    session_profile = runtime_ctx.get("session_profile")
    history_summary = runtime_ctx.get("history_summary")
    if not thread_id:
        raise HTTPException(status_code=400, detail="thread_id is required for resume")
    resolved_source_file_ids = resolve_source_file_ids(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        explicit_source_ids=None,
    )

    context = build_agent_router_context(
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        studio_document_id=payload.studio_document_id,
        source_file_ids=resolved_source_file_ids,
        ui_context=payload.ui_context,
        session_id=session_id,
        thread_id=thread_id,
        environment_model=build_agent_environment_model(
            db=db,
            tenant_id=payload.tenant_id,
            user_id=payload.user_id,
            workroom_id=payload.workroom_id,
            studio_document_id=payload.studio_document_id,
            source_file_ids=resolved_source_file_ids,
            ui_context=payload.ui_context,
        ),
    )
    if payload.agent_max_steps is not None and int(payload.agent_max_steps) > 0:
        context["agent_max_steps"] = int(payload.agent_max_steps)
    if session_profile:
        context["session_profile"] = session_profile
    if history_summary:
        context["history_summary"] = history_summary
    config = {"configurable": {"thread_id": thread_id}}
    result = _app.invoke(
        {
            **context,
            "messages": [],
            "resume_payload": payload.resume_payload,
        },
        config=config,
    )
    persist_agent_messages(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        session_id=session_id,
        result_messages=result.get("messages") or [],
    )
    return AgentRunResponse(
        session_id=session_id,
        messages=[AgentMessage(**m) for m in from_state_messages(result.get("messages") or [])],
        halt_reason=result.get("halt_reason"),
        interrupt_payload=result.get("interrupt_payload"),
        ag_ui_events=list(result.get("ag_ui_events") or []),
    )


@router.post("/run-resume-stream", dependencies=[Depends(agent_resume_limit)])
def agent_run_resume_stream(payload: AgentResumeRequest, db: Session = Depends(get_db)) -> StreamingResponse:
    assert_workroom_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
    )
    assert_studio_document_scope(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        studio_document_id=payload.studio_document_id,
    )

    runtime_ctx = resolve_resume_runtime_context(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        payload_thread_id=payload.thread_id,
        payload_session_id=payload.session_id,
        studio_document_id=payload.studio_document_id,
    )
    session_id = runtime_ctx.get("session_id")
    thread_id = str(runtime_ctx.get("thread_id") or "").strip()
    session_profile = runtime_ctx.get("session_profile")
    history_summary = runtime_ctx.get("history_summary")
    if not thread_id:
        raise HTTPException(status_code=400, detail="thread_id is required for resume")

    resolved_source_file_ids = resolve_source_file_ids(
        db=db,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        explicit_source_ids=None,
    )
    context = build_agent_router_context(
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=payload.workroom_id,
        studio_document_id=payload.studio_document_id,
        source_file_ids=resolved_source_file_ids,
        ui_context=payload.ui_context,
        session_id=session_id,
        thread_id=thread_id,
        environment_model=build_agent_environment_model(
            db=db,
            tenant_id=payload.tenant_id,
            user_id=payload.user_id,
            workroom_id=payload.workroom_id,
            studio_document_id=payload.studio_document_id,
            source_file_ids=resolved_source_file_ids,
            ui_context=payload.ui_context,
        ),
    )
    if payload.agent_max_steps is not None and int(payload.agent_max_steps) > 0:
        context["agent_max_steps"] = int(payload.agent_max_steps)
    if session_profile:
        context["session_profile"] = session_profile
    if history_summary:
        context["history_summary"] = history_summary
    config = {"configurable": {"thread_id": thread_id}}
    stream_queue: "queue.Queue[dict | None]" = queue.Queue()

    def run_resume_thread() -> None:
        db_local = SessionLocal()
        try:
            streamed_messages: list[Any] = []
            trace_reducer = StreamTraceReducer()
            emitted_text: dict[str, str] = {}
            emitted_final_text = False
            stream_stats = {"events_total": 0, "assistant_chunks": 0, "agent_traces": 0, "ag_ui": 0}
            stream = _app.stream(
                {
                    **context,
                    "messages": [],
                    "resume_payload": payload.resume_payload,
                },
                config=config,
                stream_mode=["messages", "updates", "custom"],
            )
            for raw_event in stream:
                mode, event_payload = normalize_stream_event(raw_event)
                stream_stats["events_total"] += 1
                if mode == "custom" and isinstance(event_payload, dict):
                    stream_type = str(event_payload.get("stream_type") or "").strip().lower()
                    if stream_type == "assistant_delta":
                        delta = str(event_payload.get("delta") or "")
                        if delta:
                            stream_stats["assistant_chunks"] += 1
                    elif stream_type == "thinking_delta":
                        content = str(event_payload.get("content") or "")
                        if content:
                            stream_stats["agent_traces"] += 1
                            stream_queue.put(
                                {
                                    "type": "agent_trace",
                                    "payload": {
                                        "trace_type": "model_native_thinking",
                                        "node": str(event_payload.get("node") or "decide"),
                                        "content": content,
                                    },
                                }
                            )
                    elif stream_type == "tool_call":
                        stream_stats["agent_traces"] += 1
                        stream_queue.put(
                            {
                                "type": "agent_trace",
                                "payload": {
                                    "trace_type": "tool_call",
                                    "node": str(event_payload.get("node") or "execute_tools"),
                                    "tool_name": event_payload.get("tool_name"),
                                    "status": event_payload.get("status"),
                                    "tool_call_id": event_payload.get("tool_call_id"),
                                    "observation": event_payload.get("observation"),
                                    "query": event_payload.get("query"),
                                },
                            }
                        )
                    continue
                trace_events = trace_reducer.reduce(iter_stream_trace_events(mode, event_payload))
                for trace_event in trace_events:
                    kind = trace_event.get("kind")
                    if kind == "assistant_text":
                        message_id = str(trace_event.get("id") or "")
                        text = str(trace_event.get("text") or "")
                        if not text:
                            continue
                        previous = emitted_text.get(message_id, "")
                        delta = text
                        if message_id and previous and text.startswith(previous):
                            delta = text[len(previous):]
                        if not delta:
                            continue
                        emitted_text[message_id] = previous + delta if message_id else previous
                        stream_stats["assistant_chunks"] += 1
                        continue
                    if kind == "agent_trace":
                        payload_obj = trace_event.get("payload")
                        if isinstance(payload_obj, dict) and payload_obj:
                            trace_type = str(payload_obj.get("trace_type") or "").strip().lower()
                            if trace_type == "tool_call":
                                stream_stats["agent_traces"] += 1
                                stream_queue.put({"type": "agent_trace", "payload": payload_obj})
                            elif trace_type == "model_event":
                                tool_calls = payload_obj.get("tool_calls")
                                if isinstance(tool_calls, list) and tool_calls:
                                    stream_stats["agent_traces"] += 1
                                    stream_queue.put({"type": "agent_trace", "payload": payload_obj})
                        continue
                    if kind == "ag_ui":
                        event_obj = trace_event.get("event")
                        if isinstance(event_obj, dict):
                            stream_stats["ag_ui"] += 1
                            stream_queue.put({"type": "ag_ui", "event": event_obj})
                        continue
                if mode == "updates" and isinstance(event_payload, dict):
                    for node_update in event_payload.values():
                        if not isinstance(node_update, dict):
                            continue
                        messages = node_update.get("messages")
                        if isinstance(messages, list):
                            streamed_messages = messages
            persist_agent_messages(
                db=db_local,
                tenant_id=payload.tenant_id,
                user_id=payload.user_id,
                session_id=session_id,
                result_messages=streamed_messages,
            )
            visible = from_state_messages(streamed_messages)
            final_reply = ""
            for item in reversed(visible):
                if str(item.get("role") or "").strip().lower() == "assistant":
                    final_reply = str(item.get("content") or "").strip()
                    if final_reply:
                        break
            if final_reply and not emitted_final_text:
                stream_queue.put({"type": "delta", "role": "assistant", "delta": final_reply})
                emitted_final_text = True
            logger.info(
                "agent_run_resume_stream.summary tenant=%s user=%s thread=%s stats=%s final_reply_len=%s",
                payload.tenant_id,
                payload.user_id,
                thread_id,
                stream_stats,
                len(final_reply or ""),
            )
        except Exception:
            logger.exception("agent_run_resume_stream.failed tenant=%s user=%s", payload.tenant_id, payload.user_id)
            stream_queue.put({"type": "error", "message": "agent_runtime_error"})
        finally:
            db_local.close()
            stream_queue.put(None)

    threading.Thread(target=run_resume_thread, daemon=True).start()

    def merged_stream():
        if session_id is not None:
            yield json.dumps(
                {
                    "type": "session",
                    "session_id": session_id,
                    "studio_document_id": payload.studio_document_id,
                    "workroom_id": payload.workroom_id,
                },
                ensure_ascii=False,
            ) + "\n"
        while True:
            item = stream_queue.get()
            if item is None:
                break
            yield json.dumps(item, ensure_ascii=False) + "\n"

    return StreamingResponse(merged_stream(), media_type="text/plain; charset=utf-8")

