from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


MindMapSourceType = Literal["exam_document", "uploaded_file"]
MindMapMode = Literal["knowledge_structure", "exam_review"]


class MindMapQuestionRef(BaseModel):
    questionId: Optional[int] = None
    sequenceIndex: Optional[int] = None
    page: Optional[int] = None


class MindMapDraftNode(BaseModel):
    topic: str
    summary: Optional[str] = None
    side: Optional[Literal["left", "right"]] = None
    referenceHints: list[str] = Field(default_factory=list)
    children: list["MindMapDraftNode"] = Field(default_factory=list)


class MindMapDraft(BaseModel):
    title: Optional[str] = None
    root: MindMapDraftNode


class DocOutlineLeaf(BaseModel):
    topic: str
    summary: Optional[str] = None
    evidenceHints: list[str] = Field(default_factory=list)


class DocOutlineTopic(BaseModel):
    topic: str
    summary: Optional[str] = None
    subtopics: list[DocOutlineLeaf] = Field(default_factory=list)


class DocOutline(BaseModel):
    title: Optional[str] = None
    mode: MindMapMode = "knowledge_structure"
    documentSummary: Optional[str] = None
    topics: list[DocOutlineTopic] = Field(default_factory=list)


class QualityIssue(BaseModel):
    code: str
    severity: Literal["low", "medium", "high"] = "medium"
    message: str


class QualityReport(BaseModel):
    passed: bool = False
    totalScore: float = 0.0
    coverageScore: float = 0.0
    duplicationScore: float = 0.0
    depthScore: float = 0.0
    granularityScore: float = 0.0
    modeAlignmentScore: float = 0.0
    issues: list[QualityIssue] = Field(default_factory=list)
    retryPrompt: Optional[str] = None


class MindMapNodeTree(BaseModel):
    id: str
    topic: str
    summary: Optional[str] = None
    expanded: bool = True
    side: Optional[Literal["left", "right"]] = None
    questionRefs: list[MindMapQuestionRef] = Field(default_factory=list)
    children: list["MindMapNodeTree"] = Field(default_factory=list)


class MindMapRelation(BaseModel):
    id: str
    from_: str = Field(alias="from")
    to: str
    label: Optional[str] = None

    model_config = {"populate_by_name": True}


class MindMapSummaryStyle(BaseModel):
    stroke: Optional[str] = None
    labelColor: Optional[str] = None


class MindMapSummary(BaseModel):
    id: str
    label: str
    parent: str
    start: int
    end: int
    style: Optional[MindMapSummaryStyle] = None


class MindMapMeta(BaseModel):
    hasQuestionRefs: bool = False
    generatedBy: Literal["llm", "manual", "system"] = "system"
    mode: MindMapMode = "knowledge_structure"
    updatedAt: datetime


class MindMapSource(BaseModel):
    type: MindMapSourceType
    id: int
    ids: list[int] = Field(default_factory=list)
    signature: Optional[str] = None


class MindMapDocument(BaseModel):
    id: int
    version: int
    source: MindMapSource
    kind: str = "knowledge"
    title: Optional[str] = None
    root: MindMapNodeTree
    relations: list[MindMapRelation] = Field(default_factory=list)
    summaries: list[MindMapSummary] = Field(default_factory=list)
    meta: MindMapMeta


class MindMapGenerateRequest(BaseModel):
    tenant_id: int
    user_id: int
    workroom_id: int
    source_type: MindMapSourceType
    source_id: int
    source_ids: list[int] = Field(default_factory=list)
    kind: str = "knowledge"
    mode: MindMapMode = "knowledge_structure"
    force: bool = False


class MindMapCurrentQuery(BaseModel):
    tenant_id: int
    user_id: int
    workroom_id: int
    source_type: MindMapSourceType
    source_id: int
    source_ids: list[int] = Field(default_factory=list)
    kind: str = "knowledge"
    mode: MindMapMode = "knowledge_structure"


class MindMapSaveRequest(BaseModel):
    tenant_id: int
    user_id: int
    workroom_id: int
    document: MindMapDocument


def dump_document_json(document: MindMapDocument) -> dict[str, Any]:
    return document.model_dump(by_alias=True, mode="json")


MindMapNodeTree.model_rebuild()
MindMapDraftNode.model_rebuild()
