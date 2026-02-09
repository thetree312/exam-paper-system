from datetime import datetime
from typing import Optional

from sqlalchemy import (
    BigInteger,
    Column,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
    Boolean,
)
from sqlalchemy.orm import relationship, Mapped, mapped_column

from .db import Base


class Tenant(Base):
    __tablename__ = "tenants"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    status: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    users: Mapped[list["User"]] = relationship("User", back_populates="tenant")


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    email: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    display_name: Mapped[str] = mapped_column(String(100), nullable=False)
    role: Mapped[str] = mapped_column(String(50), nullable=False, default="member")
    status: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    tenant: Mapped[Tenant] = relationship("Tenant", back_populates="users")


class SocialAccount(Base):
    __tablename__ = "social_accounts"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    provider_account_id: Mapped[str] = mapped_column(String(255), nullable=False)
    access_token: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    refresh_token: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    tenant: Mapped[Tenant] = relationship("Tenant")
    user: Mapped["User"] = relationship("User")


class File(Base):
    __tablename__ = "files"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    uploader_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    original_name: Mapped[str] = mapped_column(String(255), nullable=False)
    storage_path: Mapped[str] = mapped_column(String(512), nullable=False)
    preview_path: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    mime_type: Mapped[str] = mapped_column(String(100), nullable=False)
    file_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    source_type: Mapped[str] = mapped_column(
        Enum("image", "pdf", "word", name="source_type_enum"), nullable=False
    )
    status: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )
    content_hash: Mapped[Optional[str]] = mapped_column(
        String(64), nullable=True, index=True
    )

    tenant: Mapped[Tenant] = relationship("Tenant")
    uploader: Mapped[Optional[User]] = relationship("User")
    sessions: Mapped[list["ExtractionSession"]] = relationship(
        "ExtractionSession", back_populates="file"
    )
    fulltext_blocks: Mapped[list["FulltextBlock"]] = relationship(
        "FulltextBlock", back_populates="file", cascade="all, delete-orphan"
    )


class ExtractionSession(Base):
    __tablename__ = "extraction_sessions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    file_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("files.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(
        Enum("pending", "processing", "done", "failed", name="session_status_enum"),
        nullable=False,
        default="pending",
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    tenant: Mapped[Tenant] = relationship("Tenant")
    user: Mapped[User] = relationship("User")
    file: Mapped[File] = relationship("File", back_populates="sessions")
    items: Mapped[list["ExtractedItem"]] = relationship(
        "ExtractedItem", back_populates="session"
    )


class ExtractedItem(Base):
    __tablename__ = "extracted_items"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    session_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("extraction_sessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    sequence_index: Mapped[int] = mapped_column(Integer, nullable=False)
    content_html: Mapped[str] = mapped_column(Text, nullable=False)
    content_plain: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    question_type: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    confidence: Mapped[Optional[float]] = mapped_column(
        nullable=True
    )  # DECIMAL(5,2) in DB
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    tenant: Mapped[Tenant] = relationship("Tenant")
    session: Mapped[ExtractionSession] = relationship(
        "ExtractionSession", back_populates="items"
    )


class Plan(Base):
    __tablename__ = "plans"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    max_agent_tokens_month: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_agent_sessions_day: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_favorite_questions: Mapped[int] = mapped_column(Integer, nullable=False, default=1000)
    features: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    subscriptions: Mapped[list["Subscription"]] = relationship(
        "Subscription", back_populates="plan"
    )


class Subscription(Base):
    __tablename__ = "subscriptions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    plan_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("plans.id", ondelete="RESTRICT"), nullable=False
    )
    status: Mapped[str] = mapped_column(
        Enum("trialing", "active", "past_due", "canceled", name="subscription_status_enum"),
        nullable=False,
        default="trialing",
    )
    current_period_start: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    current_period_end: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    tenant: Mapped[Tenant] = relationship("Tenant")
    plan: Mapped[Plan] = relationship("Plan", back_populates="subscriptions")


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    owner_user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    file_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("files.id", ondelete="SET NULL"), nullable=True
    )
    session_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("extraction_sessions.id", ondelete="SET NULL"), nullable=True
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False, default="未命名试卷")
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="draft")
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )
    mindmap_cache: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    mindmap_generated_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )
    ocr_md_cache: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    ocr_layout_cache: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    ocr_cache_generated_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )
    ocr_cache_model: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)

    tenant: Mapped[Tenant] = relationship("Tenant")
    owner: Mapped[Optional[User]] = relationship("User")
    file: Mapped[Optional[File]] = relationship("File")
    session: Mapped[Optional[ExtractionSession]] = relationship("ExtractionSession")
    questions: Mapped[list["Question"]] = relationship(
        "Question", back_populates="document", cascade="all, delete-orphan"
    )


class FileOcrCache(Base):
    __tablename__ = "file_ocr_cache"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    file_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("files.id", ondelete="SET NULL"), nullable=True
    )
    md_cache: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    layout_cache: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    generated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    model: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    is_active: Mapped[bool] = mapped_column(Integer, nullable=False, default=1)
    source_document_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("documents.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    tenant: Mapped[Tenant] = relationship("Tenant")
    file: Mapped[Optional[File]] = relationship("File")
    document: Mapped[Optional[Document]] = relationship("Document")


class MindMap(Base):
    __tablename__ = "mindmaps"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    created_by_user_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    source_type: Mapped[str] = mapped_column(String(64), nullable=False)
    source_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    kind: Mapped[str] = mapped_column(String(64), nullable=False, default="knowledge")
    title: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    graph_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    is_active: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    tenant: Mapped["Tenant"] = relationship("Tenant")
    created_by: Mapped[Optional["User"]] = relationship("User")


class FulltextBlock(Base):
    __tablename__ = "fulltext_blocks"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    file_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("files.id", ondelete="CASCADE"), nullable=False
    )
    page_num: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    block_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    file: Mapped[File] = relationship("File", back_populates="fulltext_blocks")


class Question(Base):
    __tablename__ = "questions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    document_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    # 同一张题卡（原题 + 类似题变体）通过 group_id 进行分组
    group_id: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    sequence_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    page: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    legend_images: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    student_answer: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    grading_judgement: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    grading_predicted_answer: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    grading_reasoning: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    grading_confidence: Mapped[Optional[float]] = mapped_column(nullable=True)
    versions: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    tenant: Mapped[Tenant] = relationship("Tenant")
    document: Mapped[Document] = relationship("Document", back_populates="questions")


class AgentSession(Base):
    __tablename__ = "agent_sessions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    document_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    view_id: Mapped[str] = mapped_column(String(64), nullable=False)
    # LangGraph 线程 ID，用于与 checkpoint 存储关联
    thread_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    # 会话标题与最近一条消息摘要，供前端会话列表与搜索使用
    title: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    last_message_preview: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # 累计消息数量，便于排序与统计
    message_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="active")
    archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # 会话级画像（结构化偏好/进度等）与摘要文本，用于上下文压缩后的长期记忆
    profile_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    history_summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    tenant: Mapped[Tenant] = relationship("Tenant")
    user: Mapped[User] = relationship("User")
    document: Mapped[Document] = relationship("Document")
    messages: Mapped[list["AgentMessage"]] = relationship(
        "AgentMessage", back_populates="session", cascade="all, delete-orphan"
    )


class AgentMessage(Base):
    __tablename__ = "agent_messages"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    session_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("agent_sessions.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    token_usage: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

    tenant: Mapped[Tenant] = relationship("Tenant")
    session: Mapped[AgentSession] = relationship("AgentSession", back_populates="messages")


class QuestionFavorite(Base):
    """用户收藏的题目记录"""
    __tablename__ = "question_favorites"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    question_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("questions.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    tenant: Mapped[Tenant] = relationship("Tenant")
    user: Mapped[User] = relationship("User")
    question: Mapped[Question] = relationship("Question")
    question_type: Mapped[Optional["QuestionType"]] = relationship("QuestionType")
    subject: Mapped[Optional["Subject"]] = relationship("Subject")
    tags: Mapped[list["Tag"]] = relationship(
        "Tag", secondary="favorite_tags", back_populates="favorites"
    )
    question_type_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("question_types.id", ondelete="SET NULL"), nullable=True
    )
    subject_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("subjects.id", ondelete="SET NULL"), nullable=True
    )


class QuestionType(Base):
    """题型"""
    __tablename__ = "question_types"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    tenant: Mapped[Tenant] = relationship("Tenant")


class Subject(Base):
    """科目"""
    __tablename__ = "subjects"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    tenant: Mapped[Tenant] = relationship("Tenant")


class Tag(Base):
    """标签"""
    __tablename__ = "tags"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    tenant: Mapped[Tenant] = relationship("Tenant")
    favorites: Mapped[list["QuestionFavorite"]] = relationship(
        "QuestionFavorite", secondary="favorite_tags", back_populates="tags"
    )


class FavoriteTag(Base):
    """收藏与标签的关联表"""
    __tablename__ = "favorite_tags"

    favorite_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("question_favorites.id", ondelete="CASCADE"), primary_key=True
    )
    tag_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True
    )
