import json
import logging
from datetime import datetime
from typing import Any, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models import AgentMessage, AgentSession, Document, Question, QuestionCatalog, Subscription

logger = logging.getLogger("agent")

MAX_QUESTION_VERSION_HISTORY = 4  # 历史版本最大保留数量（不含当前版本）


class AgentService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def _query_active_subscription(self, tenant_id: int) -> Subscription | None:
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
        return subscription

    # ===== Subscription & plan enforcement =====
    def require_active_subscription(self, tenant_id: int) -> Subscription:
        subscription = self._query_active_subscription(tenant_id)
        if subscription:
            logger.info(
                "sub ok tenant=%s plan=%s status=%s start=%s end=%s",
                tenant_id,
                subscription.plan_id,
                subscription.status,
                subscription.current_period_start,
                subscription.current_period_end,
            )
            return subscription

        subs = (
            self.db.query(Subscription)
            .filter(Subscription.tenant_id == tenant_id)
            .order_by(Subscription.id.desc())
            .all()
        )
        logger.warning(
            "sub missing tenant=%s existing_subs=%s",
            tenant_id,
            [
                (
                    s.id,
                    s.plan_id,
                    s.status,
                    s.current_period_start,
                    s.current_period_end,
                )
                for s in subs
            ],
        )
        raise HTTPException(status_code=402, detail="订阅不可用或已过期")

    def has_active_subscription(self, tenant_id: int) -> bool:
        return self._query_active_subscription(tenant_id) is not None

    # ===== Document helpers =====
    def _ensure_document(
        self,
        *,
        tenant_id: int,
        user_id: int,
        document_id: Optional[int],
        session_id: Optional[int],
        file_id: Optional[int],
        title: Optional[str],
    ) -> Document:
        if document_id:
            document = self.db.query(Document).filter(
                Document.id == document_id, Document.tenant_id == tenant_id
            ).first()
            if document is None:
                raise HTTPException(status_code=404, detail="文档不存在或不属于该租户")
            return document

        # 检查 session_id 是否有效（不是 None 且不是 0）
        if session_id and session_id > 0:
            document = (
                self.db.query(Document)
                .filter(
                    Document.session_id == session_id,
                    Document.tenant_id == tenant_id,
                )
                .with_for_update()
                .first()
            )
            if document:
                return document

        # 如果既没有 document_id 也没有有效的 session_id，则创建新文档
        # 对于来自收藏的题目，session_id 可能为 0，此时创建一个新的文档
        document = Document(
            tenant_id=tenant_id,
            owner_user_id=user_id,
            file_id=file_id if file_id and file_id > 0 else None,
            session_id=session_id if session_id and session_id > 0 else None,
            title=title or "未命名试卷",
            status="draft",
        )
        self.db.add(document)
        self.db.flush()
        return document

    def _build_question_catalog_entries(self, questions: List[Question]) -> list[dict[str, int]]:
        """将题目列表转换为轻量 catalog（仅 id/序号/展示编号）。"""

        entries: list[dict[str, int]] = []
        for q in questions:
            if q.id is None:
                continue
            try:
                qid = int(q.id)
                seq = int(q.sequence_index)
            except (TypeError, ValueError):
                continue
            entries.append(
                {
                    "question_id": qid,
                    "sequence_index": seq,
                    "display_index": seq + 1,
                }
            )
        return entries

    def _refresh_question_catalog(
        self,
        *,
        tenant_id: int,
        document_id: int,
        bump_version: bool,
    ) -> QuestionCatalog:
        """重建并写入 document 的 question_catalog。"""

        questions = (
            self.db.query(Question)
            .filter(
                Question.tenant_id == tenant_id,
                Question.document_id == document_id,
            )
            .order_by(Question.sequence_index.asc(), Question.id.asc())
            .all()
        )
        entries = self._build_question_catalog_entries(questions)

        catalog = (
            self.db.query(QuestionCatalog)
            .filter(
                QuestionCatalog.tenant_id == tenant_id,
                QuestionCatalog.document_id == document_id,
            )
            .with_for_update()
            .first()
        )

        if catalog is None:
            catalog = QuestionCatalog(
                tenant_id=tenant_id,
                document_id=document_id,
                version=1,
                question_count=len(entries),
                catalog_json=entries,
            )
            self.db.add(catalog)
            self.db.flush()
            return catalog

        if bump_version:
            catalog.version = int(catalog.version or 0) + 1
        catalog.question_count = len(entries)
        catalog.catalog_json = entries
        catalog.updated_at = datetime.utcnow()
        self.db.add(catalog)
        self.db.flush()
        return catalog

    def get_question_catalog(
        self,
        *,
        tenant_id: int,
        document_id: int,
        limit: int = 200,
        offset: int = 0,
        if_none_match_version: Optional[int] = None,
    ) -> dict[str, Any]:
        """读取 question_catalog；若不存在则即时构建一次。"""

        if limit <= 0:
            limit = 1
        if limit > 500:
            limit = 500
        if offset < 0:
            offset = 0

        catalog = (
            self.db.query(QuestionCatalog)
            .filter(
                QuestionCatalog.tenant_id == tenant_id,
                QuestionCatalog.document_id == document_id,
            )
            .first()
        )

        if catalog is None:
            catalog = self._refresh_question_catalog(
                tenant_id=tenant_id,
                document_id=document_id,
                bump_version=False,
            )
            self.db.commit()

        version = int(catalog.version or 1)
        if if_none_match_version is not None and int(if_none_match_version) == version:
            return {
                "not_modified": True,
                "version": version,
                "question_count": int(catalog.question_count or 0),
                "rows": [],
            }

        rows = list(catalog.catalog_json or [])
        sliced = rows[offset : offset + limit]
        return {
            "not_modified": False,
            "version": version,
            "question_count": int(catalog.question_count or len(rows)),
            "rows": sliced,
            "offset": offset,
            "limit": limit,
            "has_more": offset + limit < len(rows),
        }

    def create_agent_chat_document(
        self,
        *,
        tenant_id: int,
        user_id: int,
        title: Optional[str] = None,
    ) -> Document:
        """创建一份仅用于本次 Copilot 会话的全新空白文档。"""

        final_title = title or f"Copilot 对话 - {datetime.utcnow():%Y-%m-%d %H:%M}"
        document = Document(
            tenant_id=tenant_id,
            owner_user_id=user_id,
            file_id=None,
            session_id=None,
            title=final_title,
            status="agent_chat",
        )
        self.db.add(document)
        self.db.flush()
        return document

    def _ensure_favorite_document(
        self,
        *,
        tenant_id: int,
        user_id: int,
        title: Optional[str],
    ) -> Document:
        """为收藏题目创建或获取一个专门的 document"""
        # 查找是否已有"收藏题目"document（session_id 为 None，file_id 为 None）
        document = (
            self.db.query(Document)
            .filter(
                Document.tenant_id == tenant_id,
                Document.owner_user_id == user_id,
                Document.session_id.is_(None),
                Document.file_id.is_(None),
                Document.title == "收藏题目",
            )
            .with_for_update()
            .first()
        )
        
        if document:
            return document

        # 创建新的"收藏题目"document
        document = Document(
            tenant_id=tenant_id,
            owner_user_id=user_id,
            file_id=None,
            session_id=None,
            title="收藏题目",
            status="draft",
        )
        self.db.add(document)
        self.db.flush()
        return document

    def get_or_create_session(
        self,
        *,
        tenant_id: int,
        user_id: int,
        document_id: int,
        view_id: str,
        session_id: Optional[int] = None,
    ) -> AgentSession:
        if session_id:
            session = (
                self.db.query(AgentSession)
                .filter(
                    AgentSession.id == session_id,
                    AgentSession.tenant_id == tenant_id,
                )
                .first()
            )
            if session is None:
                raise HTTPException(status_code=404, detail="Agent 会话不存在")
            return self._ensure_session_thread_id(
                session=session,
                tenant_id=tenant_id,
                user_id=user_id,
            )

        session = AgentSession(
            tenant_id=tenant_id,
            user_id=user_id,
            document_id=document_id,
            view_id=view_id,
            status="active",
        )
        self.db.add(session)
        self.db.flush()
        return self._ensure_session_thread_id(
            session=session,
            tenant_id=tenant_id,
            user_id=user_id,
        )

    def get_session(
        self,
        *,
        tenant_id: int,
        session_id: int,
        user_id: Optional[int] = None,
    ) -> AgentSession:
        """Fetch an existing AgentSession and ensure it has a thread_id.

        用于在 LangGraph 的 resume 场景下，通过 session_id 恢复对应的
        thread_id，从而继续在同一会话线程上执行。
        """

        query = self.db.query(AgentSession).filter(
            AgentSession.id == session_id,
            AgentSession.tenant_id == tenant_id,
        )
        if user_id is not None:
            query = query.filter(AgentSession.user_id == user_id)

        session = query.first()
        if session is None:
            raise HTTPException(status_code=404, detail="Agent 会话不存在")

        return self._ensure_session_thread_id(
            session=session,
            tenant_id=tenant_id,
            user_id=session.user_id,
        )

    def _ensure_session_thread_id(
        self,
        *,
        session: AgentSession,
        tenant_id: int,
        user_id: int,
    ) -> AgentSession:
        """Ensure the AgentSession has a stable LangGraph thread_id.

        thread_id 需要在 LangGraph 中作为可持久化的字符串主键，用于区分
        不同的会话线程。这里采用 tenant/user/document/session 四元组生成，
        其中 session.id 能保证同一文档下多会话之间的唯一性。
        """

        if getattr(session, "thread_id", None):
            return session

        # 确保已分配自增 ID
        if session.id is None:
            self.db.flush()

        base_document_id = getattr(session, "document_id", None)
        doc_part = base_document_id or "no-doc"
        session.thread_id = f"agent:{tenant_id}:{user_id}:{doc_part}:s{session.id}"

        self.db.commit()
        self.db.refresh(session)
        return session

    # ===== Question helpers =====
    def get_question_context(
        self,
        *,
        tenant_id: int,
        document_id: int,
        question_id: int,
    ) -> dict:
        """Return a fully structured snapshot of a single question."""

        question = (
            self.db.query(Question)
            .filter(
                Question.id == question_id,
                Question.tenant_id == tenant_id,
                Question.document_id == document_id,
            )
            .first()
        )
        if question is None:
            raise HTTPException(status_code=404, detail="题目不存在或不属于该试卷")

        legend_list: list[str] = []
        raw_legend = getattr(question, "legend_images", None)
        if raw_legend:
            try:
                parsed = json.loads(raw_legend)
                if isinstance(parsed, list):
                    legend_list = [str(item) for item in parsed]
            except Exception:
                legend_list = []

        versions = getattr(question, "versions", None)
        if not isinstance(versions, list):
            versions = []

        context = {
            "question_id": question.id,
            "document_id": document_id,
            "tenant_id": tenant_id,
            "sequence_index": question.sequence_index,
            "page": question.page,
            "content": question.content,
            "legend_images": legend_list,
            "has_vision_asset": bool(legend_list),
            "student_answer": question.student_answer,
            "grading": {
                "judgement": question.grading_judgement,
                "predicted_answer": question.grading_predicted_answer,
                "reasoning": question.grading_reasoning,
                "confidence": question.grading_confidence,
            },
            "versions": versions,
        }

        logger.info(
            "agent.question_context.ok tenant=%s document_id=%s question_id=%s seq=%s has_vision_asset=%s versions=%s",
            tenant_id,
            document_id,
            question.id,
            question.sequence_index,
            bool(legend_list),
            len(versions),
        )

        return context

    # ===== Concurrency helpers =====
    def _lock_question_for_update(
        self,
        *,
        question_id: int,
        tenant_id: Optional[int] = None,
    ) -> Question:
        query = self.db.query(Question).filter(Question.id == question_id)
        if tenant_id is not None:
            query = query.filter(Question.tenant_id == tenant_id)
        question = query.with_for_update().first()
        if question is None:
            raise HTTPException(status_code=404, detail="题目不存在或不属于该租户")
        return question

    def record_message(
        self,
        *,
        tenant_id: int,
        session_id: int,
        role: str,
        content: str,
        token_usage: Optional[int] = None,
    ) -> AgentMessage:
        message = AgentMessage(
            tenant_id=tenant_id,
            session_id=session_id,
            role=role,
            content=content,
            token_usage=token_usage,
        )
        self.db.add(message)
        self.db.commit()
        self.db.refresh(message)
        return message

    def list_messages(
        self, *, tenant_id: int, session_id: int, limit: int = 10
    ) -> List[AgentMessage]:
        return (
            self.db.query(AgentMessage)
            .filter(
                AgentMessage.tenant_id == tenant_id,
                AgentMessage.session_id == session_id,
            )
            .order_by(AgentMessage.id.desc())
            .limit(limit)
            .all()
        )

    # ===== Conversation session & history helpers =====
    def list_sessions(
        self,
        *,
        tenant_id: int,
        user_id: int,
        document_id: Optional[int] = None,
        view_id: Optional[str] = None,
        include_archived: bool = False,
        limit: int = 50,
        offset: int = 0,
    ) -> List[AgentSession]:
        """List agent sessions for a given tenant/user, optionally scoped to a document/view.

        仅返回未被软删除的会话；如需包含归档会话，可通过 include_archived 控制。
        """

        query = (
            self.db.query(AgentSession)
            .filter(
                AgentSession.tenant_id == tenant_id,
                AgentSession.user_id == user_id,
                AgentSession.deleted_at.is_(None),
            )
        )

        if document_id is not None:
            query = query.filter(AgentSession.document_id == document_id)
        if view_id is not None:
            query = query.filter(AgentSession.view_id == view_id)
        if not include_archived:
            query = query.filter(AgentSession.archived.is_(False))

        return (
            query.order_by(AgentSession.updated_at.desc())
            .offset(offset)
            .limit(limit)
            .all()
        )

    def update_session(
        self,
        *,
        tenant_id: int,
        user_id: int,
        session_id: int,
        title: Optional[str] = None,
        archived: Optional[bool] = None,
        status: Optional[str] = None,
    ) -> AgentSession:
        """Update basic metadata of an AgentSession (title / archived / status)."""

        session = (
            self.db.query(AgentSession)
            .filter(
                AgentSession.id == session_id,
                AgentSession.tenant_id == tenant_id,
                AgentSession.user_id == user_id,
                AgentSession.deleted_at.is_(None),
            )
            .first()
        )
        if session is None:
            raise HTTPException(status_code=404, detail="Agent 会话不存在")

        changed = False
        if title is not None and title != session.title:
            session.title = title
            changed = True
        if archived is not None and archived != session.archived:
            session.archived = archived
            changed = True
        if status is not None and status != session.status:
            session.status = status
            changed = True

        if changed:
            session.updated_at = datetime.utcnow()
            self.db.commit()
            self.db.refresh(session)
        return session

    def update_session_profile(
        self,
        *,
        tenant_id: int,
        session_id: int,
        profile: dict | None,
        history_summary: str | None,
    ) -> None:
        """更新 AgentSession 的画像与摘要字段。

        - profile 期望为结构化的会话画像（偏好/进度/禁用方法等），持久化到
          AgentSession.profile_json；若传入 None，则视为 {}。
        - history_summary 为对长历史对话的简短摘要，允许为空。
        """

        session = (
            self.db.query(AgentSession)
            .filter(
                AgentSession.id == session_id,
                AgentSession.tenant_id == tenant_id,
                AgentSession.deleted_at.is_(None),
            )
            .with_for_update()
            .first()
        )
        if session is None:
            raise HTTPException(status_code=404, detail="Agent 会话不存在")

        raw_profile = profile or {}
        try:
            # 确保可 JSON 序列化；若失败则退回空对象，避免阻塞主流程。
            json.dumps(raw_profile, ensure_ascii=False)
        except Exception:  # noqa: BLE001
            logger.warning(
                "agent.session_profile.invalid tenant=%s session=%s profile_preview=%s",
                tenant_id,
                session_id,
                str(raw_profile)[:200],
            )
            raw_profile = {}

        session.profile_json = raw_profile
        session.history_summary = history_summary
        session.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(session)

    def soft_delete_session(self, *, tenant_id: int, user_id: int, session_id: int) -> None:
        """Soft delete a session by marking deleted_at and updating status.

        物理删除会导致历史记录丢失，这里采用软删除以便未来做审计/恢复。
        """

        session = (
            self.db.query(AgentSession)
            .filter(
                AgentSession.id == session_id,
                AgentSession.tenant_id == tenant_id,
                AgentSession.user_id == user_id,
                AgentSession.deleted_at.is_(None),
            )
            .first()
        )
        if session is None:
            raise HTTPException(status_code=404, detail="Agent 会话不存在")

        session.status = "deleted"
        session.archived = True
        session.deleted_at = datetime.utcnow()
        session.updated_at = datetime.utcnow()
        self.db.commit()

    def replace_messages(
        self,
        *,
        tenant_id: int,
        session_id: int,
        messages: List[Tuple[str, str]],
    ) -> None:
        """Replace all messages of a session with the given list.

        messages: List of (role, content) pairs. 一般仅包含 user/assistant 消息，
        由上层路由负责过滤 system/tool 等内部消息。
        """

        session = (
            self.db.query(AgentSession)
            .filter(
                AgentSession.id == session_id,
                AgentSession.tenant_id == tenant_id,
                AgentSession.deleted_at.is_(None),
            )
            .with_for_update()
            .first()
        )
        if session is None:
            raise HTTPException(status_code=404, detail="Agent 会话不存在")

        # 清空旧消息
        (
            self.db.query(AgentMessage)
            .filter(
                AgentMessage.tenant_id == tenant_id,
                AgentMessage.session_id == session_id,
            )
            .delete(synchronize_session=False)
        )

        # 重新插入新消息
        for role, content in messages:
            msg = AgentMessage(
                tenant_id=tenant_id,
                session_id=session_id,
                role=role,
                content=content,
                token_usage=None,
            )
            self.db.add(msg)

        # 会话元数据更新
        session.message_count = len(messages)
        if messages:
            # 使用最后一条消息作为列表预览
            session.last_message_preview = (messages[-1][1] or "")[:500]
            # 如果尚未命名会话，则使用首条用户消息作为标题
            if not session.title:
                for role, content in messages:
                    if role == "user" and content:
                        session.title = content.strip()[:80]
                        break
        else:
            session.last_message_preview = None

        session.updated_at = datetime.utcnow()
        self.db.commit()

    # ===== Question sync =====
    def sync_question(
        self,
        *,
        tenant_id: int,
        user_id: int,
        document_id: Optional[int],
        session_id: Optional[int],
        file_id: Optional[int],
        question_id: Optional[int],
        sequence_index: int,
        page: Optional[int],
        content: str,
        legend_images: Optional[List[str]],
        student_answer: Optional[str],
        title: Optional[str],
        source_type: Optional[str] = None,
    ) -> Tuple[Document, Question]:
        self.require_active_subscription(tenant_id)
        
        # 如果是来自收藏的题目，创建一个专门的"收藏题目"document
        if source_type == 'favorite' and not document_id:
            document = self._ensure_favorite_document(
                tenant_id=tenant_id,
                user_id=user_id,
                title=title,
            )
        else:
            # 监控缺失 document_id 的调用，便于排查前端是否有未正确携带
            # agentDocumentId 的残留路径。这里暂不改变原有行为，仅补充日志。
            if document_id is None:
                logger.warning(
                    "agent.sync_question.missing_document_id tenant=%s user=%s session_id=%s file_id=%s source_type=%s",
                    tenant_id,
                    user_id,
                    session_id,
                    file_id,
                    source_type,
                )

            document = self._ensure_document(
                tenant_id=tenant_id,
                user_id=user_id,
                document_id=document_id,
                session_id=session_id,
                file_id=file_id,
                title=title,
            )

        legend_json = json.dumps(legend_images or [], ensure_ascii=False)

        question: Optional[Question] = None
        if question_id:
            question = (
                self.db.query(Question)
                .filter(
                    Question.id == question_id,
                    Question.tenant_id == tenant_id,
                    Question.document_id == document.id,
                )
                .with_for_update()
                .first()
            )
            if question is None:
                raise HTTPException(status_code=404, detail="题目不存在或不属于该文档")
        else:
            question = (
                self.db.query(Question)
                .filter(
                    Question.document_id == document.id,
                    Question.sequence_index == sequence_index,
                )
                .first()
            )

        if question is None:
            question = Question(
                tenant_id=tenant_id,
                document_id=document.id,
                sequence_index=sequence_index,
                versions=[],
            )
            self.db.add(question)

        question.page = page
        question.content = content
        question.legend_images = legend_json
        question.student_answer = student_answer
        if question.versions is None:
            question.versions = []
        question.updated_at = datetime.utcnow()

        self.db.commit()
        self.db.refresh(question)

        # 确保每道题都有稳定的分组标识：默认使用自身 id 作为 group_id
        if getattr(question, "group_id", None) is None:
            question.group_id = question.id
            self.db.commit()
            self.db.refresh(question)

        self._refresh_question_catalog(
            tenant_id=tenant_id,
            document_id=document.id,
            bump_version=True,
        )
        self.db.commit()
        return document, question

    def update_question_grading(
        self,
        *,
        tenant_id: int,
        document_id: int,
        sequence_index: int,
        student_answer: Optional[str],
        judgement: Optional[str],
        predicted_answer: Optional[str],
        reasoning: Optional[str],
        confidence: Optional[float],
    ) -> None:
        """Update grading-related fields for a specific question.

        This is used by the grading endpoint so that the question snapshot
        reflects the latest student answer and grading result, which can then
        be consumed by the side-panel agent.
        """

        question: Optional[Question] = (
            self.db.query(Question)
            .filter(
                Question.tenant_id == tenant_id,
                Question.document_id == document_id,
                Question.sequence_index == sequence_index,
            )
            .with_for_update()
            .order_by(Question.id.asc())
            .first()
        )
        if question is None:
            logger.warning(
                "update_question_grading: question not found tenant=%s document=%s seq=%s",
                tenant_id,
                document_id,
                sequence_index,
            )
            return

        if student_answer is not None:
            question.student_answer = student_answer
        question.grading_judgement = judgement
        question.grading_predicted_answer = predicted_answer
        question.grading_reasoning = reasoning
        question.grading_confidence = confidence
        question.updated_at = datetime.utcnow()

        self.db.commit()

    # ===== Snapshot =====
    def get_snapshot(
        self, *, tenant_id: int, document_id: int
    ) -> Tuple[Document, List[Question]]:
        self.require_active_subscription(tenant_id)
        document = (
            self.db.query(Document)
            .filter(
                Document.id == document_id,
                Document.tenant_id == tenant_id,
            )
            .first()
        )
        if document is None:
            raise HTTPException(status_code=404, detail="文档不存在")

        questions = (
            self.db.query(Question)
            .filter(
                Question.document_id == document.id,
                Question.tenant_id == tenant_id,
            )
            .order_by(Question.sequence_index.asc(), Question.id.asc())
            .all()
        )
        return document, questions

    # ===== Question helpers for agent tools =====
    def get_question_by_id(
        self,
        *,
        tenant_id: int,
        document_id: int,
        question_id: int,
    ) -> Question:
        question = (
            self.db.query(Question)
            .filter(
                Question.tenant_id == tenant_id,
                Question.document_id == document_id,
                Question.id == question_id,
            )
            .first()
        )
        if question is None:
            raise HTTPException(status_code=404, detail="题目不存在")
        return question

    def get_question_by_sequence(
        self, *, tenant_id: int, document_id: int, sequence_index: int
    ) -> Question:
        question = (
            self.db.query(Question)
            .filter(
                Question.tenant_id == tenant_id,
                Question.document_id == document_id,
                Question.sequence_index == sequence_index,
            )
            .order_by(Question.id.asc())
            .first()
        )
        if question is None:
            raise HTTPException(status_code=404, detail="题目不存在")
        return question

    def has_any_question(
        self,
        *,
        tenant_id: int,
        document_id: int,
    ) -> bool:
        exists = (
            self.db.query(Question.id)
            .filter(
                Question.tenant_id == tenant_id,
                Question.document_id == document_id,
            )
            .limit(1)
            .first()
        )
        return exists is not None

    def delete_question(
        self,
        *,
        tenant_id: int,
        document_id: int,
        question_id: int,
    ) -> None:
        """物理删除一条题目记录，用于与前端题卡删除保持一致。"""

        question = (
            self.db.query(Question)
            .filter(
                Question.id == question_id,
                Question.tenant_id == tenant_id,
                Question.document_id == document_id,
            )
            .first()
        )
        if question is None:
            logger.warning(
                "delete_question: question not found tenant=%s document=%s question_id=%s",
                tenant_id,
                document_id,
                question_id,
            )
            return

        self.db.delete(question)
        self.db.flush()

        self._refresh_question_catalog(
            tenant_id=tenant_id,
            document_id=document_id,
            bump_version=True,
        )
        self.db.commit()

    def get_base_question_for_insert(
        self,
        *,
        tenant_id: int,
        document_id: int,
        target_sequence_index: int,
    ) -> Question:
        """为插入类似题选择一个稳定的“原题”，用于分组。

        优先策略：
        1) 直接使用 target_sequence_index 命中的题目；
        2) 如果不存在，则尝试使用 (target_sequence_index - 1)；
        3) 仍然不存在时，选择 sequence_index 小于等于 target 的题目中序号最大的；
        4) 如果整张试卷还没有题目，则抛 404。
        """

        # 1) 精确命中
        question = (
            self.db.query(Question)
            .filter(
                Question.tenant_id == tenant_id,
                Question.document_id == document_id,
                Question.sequence_index == target_sequence_index,
            )
            .order_by(Question.id.asc())
            .first()
        )
        if question is not None:
            return question

        # 2) 尝试使用 target-1，兼容上游可能用“插入位置索引”而非原题索引的情况
        if target_sequence_index > 0:
            prev = (
                self.db.query(Question)
                .filter(
                    Question.tenant_id == tenant_id,
                    Question.document_id == document_id,
                    Question.sequence_index == target_sequence_index - 1,
                )
                .order_by(Question.id.asc())
                .first()
            )
            if prev is not None:
                return prev

        # 3) 选择 <= target 中 sequence_index 最大的一道题
        fallback = (
            self.db.query(Question)
            .filter(
                Question.tenant_id == tenant_id,
                Question.document_id == document_id,
                Question.sequence_index <= target_sequence_index,
            )
            .order_by(Question.sequence_index.desc(), Question.id.desc())
            .first()
        )
        if fallback is not None:
            return fallback

        # 4) 如果仍不存在，则整张试卷还没有题目
        raise HTTPException(status_code=404, detail="题目不存在")

    def overwrite_question_content(
        self,
        *,
        question: Question,
        content: str,
        legend_images: Optional[List[str]] = None,
    ) -> Question:
        if question.id is not None:
            question = self._lock_question_for_update(
                question_id=question.id,
                tenant_id=question.tenant_id,
            )

        legend_json = json.dumps(legend_images or [], ensure_ascii=False)
        question.content = content
        question.legend_images = legend_json
        # 当题干被覆盖为新题（例如类似题覆盖）时，原有的学生作答与批改结果已不再适用。
        # 为避免后续 Agent 上下文仍引用旧的错误状态，这里统一清空作答与批改字段，
        # 让这道题在语义上回到“未作答、未批改”的初始状态。
        question.student_answer = None
        question.grading_judgement = None
        question.grading_predicted_answer = None
        question.grading_reasoning = None
        question.grading_confidence = None
        question.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(question)
        return question

    def insert_question(
        self,
        *,
        tenant_id: int,
        document_id: int,
        content: str,
        legend_images: Optional[List[str]] = None,
        page: Optional[int] = None,
        after_sequence_index: Optional[int] = None,
        group_id: Optional[int] = None,
    ) -> Question:
        if after_sequence_index is not None:
            self.db.query(Question).filter(
                Question.tenant_id == tenant_id,
                Question.document_id == document_id,
                Question.sequence_index > after_sequence_index,
            ).update(
                {Question.sequence_index: Question.sequence_index + 1},
                synchronize_session=False,
            )
            next_seq = after_sequence_index + 1
        else:
            max_seq: Optional[int] = (
                self.db.query(func.max(Question.sequence_index))
                .filter(
                    Question.tenant_id == tenant_id,
                    Question.document_id == document_id,
                )
                .scalar()
            )
            next_seq = (max_seq or 0) + 1
        legend_json = json.dumps(legend_images or [], ensure_ascii=False)
        question = Question(
            tenant_id=tenant_id,
            document_id=document_id,
            group_id=group_id,
            sequence_index=next_seq,
            content=content,
            legend_images=legend_json,
            page=page,
            versions=[],
        )
        self.db.add(question)
        self.db.commit()
        self.db.refresh(question)

        # 如果未显式指定 group_id，则将其回填为自身 id，以便前端稳定按卡片分组
        if question.group_id is None:
            question.group_id = question.id
            self.db.commit()
            self.db.refresh(question)

        self._refresh_question_catalog(
            tenant_id=tenant_id,
            document_id=document_id,
            bump_version=True,
        )
        self.db.commit()
        return question

    def _serialize_legend_images(self, legend_json: str | None) -> List[str]:
        if not legend_json:
            return []
        try:
            val = json.loads(legend_json)
            if isinstance(val, list):
                return [str(x) for x in val]
        except Exception:  # noqa: BLE001
            pass
        return []

    def append_question_version(
        self,
        *,
        question: Question,
        new_content: str,
        new_legend_images: Optional[List[str]] = None,
        origin: Optional[dict[str, Any]] = None,
    ) -> Question:
        """将当前题目内容推入 versions 历史，再更新为新内容。"""

        if question.id is not None:
            question = self._lock_question_for_update(
                question_id=question.id,
                tenant_id=question.tenant_id,
            )

        now = datetime.utcnow()
        history = question.versions or []

        previous_entry = {
            "content": question.content,
            "legendImages": self._serialize_legend_images(question.legend_images),
            "studentAnswer": question.student_answer,
            "grading": {
                "judgement": question.grading_judgement,
                "predictedAnswer": question.grading_predicted_answer,
                "reasoning": question.grading_reasoning,
                "confidence": question.grading_confidence,
            },
            "page": question.page,
            "capturedAt": now.isoformat(),
        }
        if origin:
            previous_entry["origin"] = origin

        new_history = [previous_entry] + history
        if len(new_history) > MAX_QUESTION_VERSION_HISTORY:
            new_history = new_history[:MAX_QUESTION_VERSION_HISTORY]

        question.versions = new_history
        question.content = new_content
        question.legend_images = json.dumps(new_legend_images or [], ensure_ascii=False)
        question.student_answer = None
        question.grading_judgement = None
        question.grading_predicted_answer = None
        question.grading_reasoning = None
        question.grading_confidence = None
        question.updated_at = now

        self.db.commit()
        self.db.refresh(question)
        return question
