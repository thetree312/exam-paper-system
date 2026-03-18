from datetime import datetime
from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, EmailStr, Field, constr, validator


class RegionExclusion(BaseModel):
    x: float = Field(..., ge=0.0, le=1.0, description="Exclusion region top-left x in normalized coordinates (0-1).")
    y: float = Field(..., ge=0.0, le=1.0, description="Exclusion region top-left y in normalized coordinates (0-1).")
    width: float = Field(..., gt=0.0, le=1.0, description="Exclusion region width in normalized coordinates (0-1).")
    height: float = Field(..., gt=0.0, le=1.0, description="Exclusion region height in normalized coordinates (0-1).")


class Region(BaseModel):
    page: int = Field(1, description="Page index starting from 1.")
    x: float = Field(..., ge=0.0, le=1.0, description="Region top-left x in normalized coordinates (0-1).")
    y: float = Field(..., ge=0.0, le=1.0, description="Region top-left y in normalized coordinates (0-1).")
    width: float = Field(..., gt=0.0, le=1.0, description="Region width in normalized coordinates (0-1).")
    height: float = Field(..., gt=0.0, le=1.0, description="Region height in normalized coordinates (0-1).")
    exclusions: List[RegionExclusion] = Field(
        default_factory=list,
        description="Sub-regions to exclude from OCR, using page-normalized coordinates.",
    )


class OcrRequest(BaseModel):
    session_id: int
    regions: List[Region]


class LegendRegion(BaseModel):
    page: int = Field(1, description="Page index starting from 1.")
    x: float = Field(..., ge=0.0, le=1.0, description="Legend region top-left x in normalized coordinates (0-1).")
    y: float = Field(..., ge=0.0, le=1.0, description="Legend region top-left y in normalized coordinates (0-1).")
    width: float = Field(..., gt=0.0, le=1.0, description="Legend region width in normalized coordinates (0-1).")
    height: float = Field(..., gt=0.0, le=1.0, description="Legend region height in normalized coordinates (0-1).")


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


class WorkroomFileTabOut(BaseModel):
    file_id: int
    session_id: int
    name: str
    source_type: Optional[str] = None
    status: str
    preview_url: Optional[str] = None
    preview_pages: List[str] = Field(default_factory=list)


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
            raise ValueError("Password must include both letters and digits.")
        return value


class LoginRequest(BaseModel):
    email: EmailStr
    password: LoginPasswordStr


class AuthResponse(BaseModel):
    user: UserOut


class WorkspaceOut(BaseModel):
    id: int
    tenant_id: int
    user_id: int
    name: str
    topic: Optional[str] = None
    status: str


class WorkspaceCreateRequest(BaseModel):
    tenant_id: int
    user_id: int
    name: str
    topic: Optional[str] = None


class WorkroomOut(BaseModel):
    id: int
    workspace_id: Optional[int] = None
    tenant_id: int
    user_id: int
    name: str
    status: str


class WorkroomSourceBindingOut(BaseModel):
    file_id: int
    source_id: Optional[int] = None
    is_active: bool = True


class WorkspaceLaunchResponse(BaseModel):
    workspace: WorkspaceOut
    workroom: WorkroomOut


class WorkroomRuntimeStateOut(BaseModel):
    active_file_id: Optional[int] = None
    active_session_id: Optional[int] = None
    active_tab_index: int = 0
    active_studio_document_id: Optional[int] = None
    active_agent_session_id: Optional[int] = None
    active_extraction_session_id: Optional[int] = None
    left_panel_state_json: dict = Field(default_factory=dict)
    center_panel_state_json: dict = Field(default_factory=dict)
    right_panel_state_json: dict = Field(default_factory=dict)


class WorkroomArtifactOut(BaseModel):
    artifact_type: str
    artifact_ref_id: str
    source_file_id: Optional[int] = None
    studio_document_id: Optional[int] = None
    payload_json: dict = Field(default_factory=dict)


class WorkroomCurrentResponse(BaseModel):
    workroom: WorkroomOut
    runtime_state: WorkroomRuntimeStateOut
    sources: List[WorkroomSourceBindingOut] = Field(default_factory=list)
    artifacts: List[WorkroomArtifactOut] = Field(default_factory=list)


class WorkroomRuntimeStateUpdateRequest(BaseModel):
    tenant_id: int
    user_id: int
    active_file_id: Optional[int] = None
    active_session_id: Optional[int] = None
    active_tab_index: Optional[int] = None
    active_studio_document_id: Optional[int] = None
    active_agent_session_id: Optional[int] = None
    active_extraction_session_id: Optional[int] = None
    left_panel_state_json: Optional[dict] = None
    center_panel_state_json: Optional[dict] = None
    right_panel_state_json: Optional[dict] = None


class WorkroomSourceBindRequest(BaseModel):
    tenant_id: int
    user_id: int
    file_id: int


class WorkroomArtifactUpdateRequest(BaseModel):
    tenant_id: int
    user_id: int
    source_file_id: Optional[int] = None
    studio_document_id: Optional[int] = None
    payload_json: dict = Field(default_factory=dict)


class AgentQuestion(BaseModel):
    id: int
    sequence_index: int
    page: Optional[int] = None
    content: str
    legend_images: List[str] = Field(default_factory=list)


class QuestionSyncRequest(BaseModel):
    tenant_id: int
    user_id: int
    document_id: Optional[int] = Field(default=None, description="Existing document ID (optional).")
    session_id: Optional[int] = Field(default=None, description="Extraction session ID for first-time creation.")
    file_id: Optional[int] = Field(default=None, description="Original file ID used for first-time binding.")
    question_id: Optional[int] = Field(default=None, description="Existing question ID (optional).")
    sequence_index: int = Field(..., ge=0, description="Question order index within the document.")
    page: Optional[int] = Field(default=None, description="Page number where the question appears.")
    content: str = Field(..., description="Question content in plain text.")
    legend_images: List[str] = Field(default_factory=list, description="Referenced legend image list in base64.")
    title: Optional[str] = Field(default=None, description="Document title used when first creating the document.")


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
    view_id: str = Field(..., description="Frontend editor view/tag ID used to reuse session.")
    session_id: Optional[int] = Field(
        default=None, description="Existing agent session ID (optional)."
    )
    query: str = Field(..., description="User query sent to the agent.")
    temperature: float = Field(0.2, ge=0.0, le=1.0)
    top_p: float = Field(0.8, ge=0.0, le=1.0)
    history_limit: int = Field(10, ge=1, le=30, description="Returned message history upper limit.")


class AgentChatResponse(BaseModel):
    session_id: int
    document_id: int
    answer: str
    message_id: int
    history: List[AgentMessageOut]


class ExportQuestion(BaseModel):
    index: int = Field(..., ge=1, description="Question index starting from 1.")
    markdown: str = Field(..., description="Question content in Markdown + LaTeX.")


class ExportWordRequest(BaseModel):
    title: str = Field(..., description="Paper title used for document title and output filename.")
    questions: List[ExportQuestion] = Field(
        default_factory=list,
        description="Question list to export, sorted by index.",
    )
    template_key: Optional[str] = Field(
        default=None,
        alias="templateKey",
        description="Optional template key mapped to a .docx file under templates.",
    )


class ExportTemplateInfo(BaseModel):
    key: str = Field(..., description="Template identifier, usually template filename without extension.")
    name: str = Field(..., description="Display name of template.")
    description: Optional[str] = Field(
        default=None,
        description="Optional template description.",
    )


class ExportTemplatesResponse(BaseModel):
    templates: List[ExportTemplateInfo] = Field(
        default_factory=list,
        description="Available Word export templates.",
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
    scope: TranslationScope = Field(TranslationScope.sentence, description="word=鍗曡瘝閲婁箟锛泂entence=鏁村彞缈昏瘧")


class TranslationLookupResponse(BaseModel):
    translation: Optional[str] = None
    word: Optional[TranslationWordPayload] = None
    quota: Optional[TranslationQuotaInfo] = None

