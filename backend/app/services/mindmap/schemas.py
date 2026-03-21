from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


MindMapSourceType = Literal["exam_document", "uploaded_file"]


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
    updatedAt: datetime


class MindMapSource(BaseModel):
    type: MindMapSourceType
    id: int


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
    kind: str = "knowledge"
    force: bool = False


class MindMapCurrentQuery(BaseModel):
    tenant_id: int
    user_id: int
    workroom_id: int
    source_type: MindMapSourceType
    source_id: int
    kind: str = "knowledge"


class MindMapSaveRequest(BaseModel):
    tenant_id: int
    user_id: int
    workroom_id: int
    document: MindMapDocument


def dump_document_json(document: MindMapDocument) -> dict[str, Any]:
    return document.model_dump(by_alias=True, mode="json")


MindMapNodeTree.model_rebuild()
MindMapDraftNode.model_rebuild()
