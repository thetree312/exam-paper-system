from datetime import datetime
from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, EmailStr, Field, constr, validator


class RegionExclusion(BaseModel):
    x: float = Field(..., ge=0.0, le=1.0, description="排除区域左上角 x，0-1 归一化")
    y: float = Field(..., ge=0.0, le=1.0, description="排除区域左上角 y，0-1 归一化")
    width: float = Field(..., gt=0.0, le=1.0, description="排除区域宽度，0-1 归一化")
    height: float = Field(..., gt=0.0, le=1.0, description="排除区域高度，0-1 归一化")


class Region(BaseModel):
    page: int = Field(1, description="页码，从 1 开始")
    x: float = Field(..., ge=0.0, le=1.0, description="左上角 x，0-1 归一化")
    y: float = Field(..., ge=0.0, le=1.0, description="左上角 y，0-1 归一化")
    width: float = Field(..., gt=0.0, le=1.0, description="宽度，0-1 归一化")
    height: float = Field(..., gt=0.0, le=1.0, description="高度，0-1 归一化")
    exclusions: List[RegionExclusion] = Field(
        default_factory=list,
        description="需要挖掉的子矩形，坐标同样按整页归一化",
    )


class OcrRequest(BaseModel):
    session_id: int
    regions: List[Region]


class LegendRegion(BaseModel):
    page: int = Field(1, description="页码，从 1 开始")
    x: float = Field(..., ge=0.0, le=1.0, description="左上角 x，0-1 归一化")
    y: float = Field(..., ge=0.0, le=1.0, description="左上角 y，0-1 归一化")
    width: float = Field(..., gt=0.0, le=1.0, description="宽度，0-1 归一化")
    height: float = Field(..., gt=0.0, le=1.0, description="高度，0-1 归一化")


class LegendRequest(BaseModel):
    session_id: int
    legends: List[LegendRegion]


class OcrItem(BaseModel):
    region_index: int
    text: str


class OcrResponse(BaseModel):
    session_id: int
    items: List[OcrItem]


class LegendResponse(BaseModel):
    images: List[str]


class FileUploadResponse(BaseModel):
    file_id: int
    session_id: int
    preview_url: Optional[str] = None
    preview_pages: List[str] = []


class SessionStatusResponse(BaseModel):
    session_id: int
    file_id: int
    status: str
    preview_url: Optional[str] = None
    preview_pages: List[str] = []


class UserOut(BaseModel):
    id: int
    tenant_id: int
    email: str
    display_name: str


PasswordStr = constr(min_length=8, max_length=128)
LoginPasswordStr = constr(min_length=1, max_length=128)


class RegisterRequest(BaseModel):
    email: EmailStr
    password: PasswordStr
    display_name: Optional[str] = None

    @validator("password")
    def validate_password_strength(cls, value: str) -> str:
        has_letter = any(ch.isalpha() for ch in value)
        has_digit = any(ch.isdigit() for ch in value)
        if not (has_letter and has_digit):
            raise ValueError("密码需包含字母和数字")
        return value


class LoginRequest(BaseModel):
    email: EmailStr
    password: LoginPasswordStr


class AuthResponse(BaseModel):
    user: UserOut


class AgentQuestion(BaseModel):
    id: int
    sequence_index: int
    page: Optional[int] = None
    content: str
    legend_images: List[str] = Field(default_factory=list)


class QuestionSyncRequest(BaseModel):
    tenant_id: int
    user_id: int
    document_id: Optional[int] = Field(default=None, description="已有文档 ID，可为空")
    session_id: Optional[int] = Field(default=None, description="Extraction session ID，用于首次创建")
    file_id: Optional[int] = Field(default=None, description="原始文件 ID，首次创建时用于绑定")
    question_id: Optional[int] = Field(default=None, description="已有题目 ID，可为空")
    sequence_index: int = Field(..., ge=0, description="题目在文档内的顺序")
    page: Optional[int] = Field(default=None, description="题目所在页")
    content: str = Field(..., description="题目文本内容（纯文本）")
    legend_images: List[str] = Field(default_factory=list, description="题目引用的图例 base64 列表")
    title: Optional[str] = Field(default=None, description="文档标题，首次创建文档时使用")


class QuestionSyncResponse(BaseModel):
    document_id: int
    question: AgentQuestion


class AgentSnapshotRequest(BaseModel):
    tenant_id: int
    document_id: int


class AgentSnapshotResponse(BaseModel):
    document_id: int
    title: str
    status: str
    questions: List[AgentQuestion]


class AgentMessageOut(BaseModel):
    id: int
    role: str
    content: str
    token_usage: Optional[int] = None
    created_at: datetime


class AgentChatRequest(BaseModel):
    tenant_id: int
    user_id: int
    document_id: int
    view_id: str = Field(..., description="前端编辑视图/标签 ID，用于复用会话")
    session_id: Optional[int] = Field(
        default=None, description="已有 agent 会话 ID，可选"
    )
    query: str = Field(..., description="用户向 Agent 提出的指令/问题")
    temperature: float = Field(0.2, ge=0.0, le=1.0)
    top_p: float = Field(0.8, ge=0.0, le=1.0)
    history_limit: int = Field(10, ge=1, le=30, description="返回的历史消息上限")


class AgentChatResponse(BaseModel):
    session_id: int
    document_id: int
    answer: str
    message_id: int
    history: List[AgentMessageOut]


class ExportQuestion(BaseModel):
    index: int = Field(..., ge=1, description="题目序号（从 1 开始）")
    markdown: str = Field(..., description="该题的 Markdown+LaTeX 内容，包括题干/选项/解析等")


class ExportWordRequest(BaseModel):
    title: str = Field(..., description="试卷标题，用于文档标题和文件名")
    questions: List[ExportQuestion] = Field(
        default_factory=list,
        description="需要导出的题目列表，按 index 排序",
    )
    template_key: Optional[str] = Field(
        default=None,
        alias="templateKey",
        description="可选的模板标识，对应后端 templates 目录下的某个 .docx 文件（不含扩展名）",
    )


class ExportTemplateInfo(BaseModel):
    key: str = Field(..., description="模板标识，一般为模板文件名（不含扩展名）")
    name: str = Field(..., description="模板展示名称")
    description: Optional[str] = Field(
        default=None,
        description="模板说明，可选",
    )


class ExportTemplatesResponse(BaseModel):
    templates: List[ExportTemplateInfo] = Field(
        default_factory=list,
        description="可用的 Word 导出模板列表",
    )


class TranslationScope(str, Enum):
    word = "word"
    sentence = "sentence"


class WordSense(BaseModel):
    pos: Optional[str] = None
    meaning: Optional[str] = None
    note: Optional[str] = None


class TranslationWordPayload(BaseModel):
    phonetic: Optional[str] = None
    translation: Optional[str] = None
    example: Optional[str] = None
    lemma: Optional[str] = None
    morphology: Optional[str] = None
    forms: List[str] = Field(default_factory=list)
    senses: List[WordSense] = Field(default_factory=list)


class TranslationQuotaInfo(BaseModel):
    limit: Optional[int] = None
    remaining: Optional[int] = None
    reset_at: Optional[datetime] = None


class TranslationLookupRequest(BaseModel):
    tenant_id: int
    user_id: int
    text: str = Field(..., min_length=1, max_length=2000)
    scope: TranslationScope = Field(TranslationScope.sentence, description="word=单词释义；sentence=整句翻译")


class TranslationLookupResponse(BaseModel):
    translation: Optional[str] = None
    word: Optional[TranslationWordPayload] = None
    quota: Optional[TranslationQuotaInfo] = None
