from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db import get_db
from ..schemas import (
    WorkroomArtifactOut,
    WorkroomArtifactUpdateRequest,
    WorkroomCurrentResponse,
    WorkroomRuntimeStateOut,
    WorkroomRuntimeStateUpdateRequest,
    WorkroomSourceBindRequest,
    WorkroomSourceBindingOut,
)
from ..services.workroom import WorkroomService


router = APIRouter(prefix="/api/workrooms", tags=["workrooms"])


def _runtime_to_schema(payload: dict) -> WorkroomRuntimeStateOut:
    return WorkroomRuntimeStateOut(
        active_file_id=payload.get("active_file_id"),
        active_session_id=payload.get("active_session_id"),
        active_tab_index=int(payload.get("active_tab_index") or 0),
        active_studio_document_id=payload.get("active_studio_document_id"),
        active_agent_session_id=payload.get("active_agent_session_id"),
        active_extraction_session_id=payload.get("active_extraction_session_id"),
        left_panel_state_json=payload.get("left_panel_state_json") or {},
        center_panel_state_json=payload.get("center_panel_state_json") or {},
        right_panel_state_json=payload.get("right_panel_state_json") or {},
    )


@router.get("/current", response_model=WorkroomCurrentResponse)
def get_current_workroom(tenant_id: int, user_id: int, db: Session = Depends(get_db)) -> WorkroomCurrentResponse:
    payload = WorkroomService(db).get_current_payload(tenant_id=tenant_id, user_id=user_id)
    return WorkroomCurrentResponse(
        workroom=payload["workroom"],
        runtime_state=_runtime_to_schema(payload["runtime_state"]),
        sources=[WorkroomSourceBindingOut(**item) for item in payload["sources"]],
        artifacts=[WorkroomArtifactOut(**item) for item in payload["artifacts"]],
    )


@router.get("/{workroom_id}/state", response_model=WorkroomRuntimeStateOut)
def get_workroom_state(workroom_id: int, tenant_id: int, user_id: int, db: Session = Depends(get_db)) -> WorkroomRuntimeStateOut:
    payload = WorkroomService(db).get_current_payload(tenant_id=tenant_id, user_id=user_id)
    return _runtime_to_schema(payload["runtime_state"])


@router.put("/{workroom_id}/state", response_model=WorkroomRuntimeStateOut)
def put_workroom_state(
    workroom_id: int,
    payload: WorkroomRuntimeStateUpdateRequest,
    db: Session = Depends(get_db),
) -> WorkroomRuntimeStateOut:
    row = WorkroomService(db).update_runtime_state(
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=workroom_id,
        values=payload.dict(exclude={"tenant_id", "user_id"}, exclude_none=True),
    )
    return _runtime_to_schema(row)


@router.get("/{workroom_id}/sources", response_model=list[WorkroomSourceBindingOut])
def list_workroom_sources(workroom_id: int, tenant_id: int, user_id: int, db: Session = Depends(get_db)) -> list[WorkroomSourceBindingOut]:
    rows = WorkroomService(db).list_sources(tenant_id=tenant_id, user_id=user_id, workroom_id=workroom_id)
    return [WorkroomSourceBindingOut(**row) for row in rows]


@router.post("/{workroom_id}/sources", response_model=WorkroomSourceBindingOut)
def bind_workroom_source(
    workroom_id: int,
    payload: WorkroomSourceBindRequest,
    db: Session = Depends(get_db),
) -> WorkroomSourceBindingOut:
    row = WorkroomService(db).bind_source_file(
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=workroom_id,
        file_id=payload.file_id,
    )
    return WorkroomSourceBindingOut(**row)


@router.put("/{workroom_id}/artifacts/{artifact_type}/{artifact_ref_id}", response_model=WorkroomArtifactOut)
def put_workroom_artifact(
    workroom_id: int,
    artifact_type: str,
    artifact_ref_id: str,
    payload: WorkroomArtifactUpdateRequest,
    db: Session = Depends(get_db),
) -> WorkroomArtifactOut:
    row = WorkroomService(db).upsert_artifact(
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        workroom_id=workroom_id,
        artifact_type=artifact_type,
        artifact_ref_id=artifact_ref_id,
        source_file_id=payload.source_file_id,
        studio_document_id=payload.studio_document_id,
        payload_json=payload.payload_json,
    )
    return WorkroomArtifactOut(**row)

