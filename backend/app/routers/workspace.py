from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from ..db import get_db
from ..schemas import (
    WorkspaceCreateRequest,
    WorkspaceLaunchResponse,
    WorkspaceOut,
    WorkroomArtifactOut,
    WorkroomCurrentResponse,
    WorkroomOut,
    WorkroomRuntimeStateOut,
    WorkroomSourceBindingOut,
)
from ..services.workspace import WorkspaceService


router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])


@router.get("", response_model=list[WorkspaceOut])
def list_workspaces(tenant_id: int, user_id: int, db: Session = Depends(get_db)) -> list[WorkspaceOut]:
    rows = WorkspaceService(db).list_workspaces(tenant_id=tenant_id, user_id=user_id)
    return [WorkspaceOut(**row) for row in rows]


@router.post("", response_model=WorkspaceLaunchResponse)
def create_workspace(payload: WorkspaceCreateRequest, db: Session = Depends(get_db)) -> WorkspaceLaunchResponse:
    result = WorkspaceService(db).create_workspace_with_workroom(
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        name=payload.name,
        topic=payload.topic,
    )
    return WorkspaceLaunchResponse(
        workspace=WorkspaceOut(**result["workspace"]),
        workroom=WorkroomOut(**result["workroom"]),
    )


@router.get("/{workspace_id}/launch", response_model=WorkroomCurrentResponse)
def launch_workspace(
    workspace_id: int,
    tenant_id: int,
    user_id: int,
    db: Session = Depends(get_db),
) -> WorkroomCurrentResponse:
    try:
        result = WorkspaceService(db).launch_workspace(
            tenant_id=tenant_id,
            user_id=user_id,
            workspace_id=workspace_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return WorkroomCurrentResponse(
        workroom=WorkroomOut(**result["workroom"]),
        runtime_state=WorkroomRuntimeStateOut(**result["runtime_state"]),
        sources=[WorkroomSourceBindingOut(**item) for item in result["sources"]],
        artifacts=[WorkroomArtifactOut(**item) for item in result["artifacts"]],
    )


@router.delete("/{workspace_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_workspace(
    workspace_id: int,
    tenant_id: int,
    user_id: int,
    db: Session = Depends(get_db),
) -> Response:
    try:
        WorkspaceService(db).delete_workspace(
            tenant_id=tenant_id,
            user_id=user_id,
            workspace_id=workspace_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)
