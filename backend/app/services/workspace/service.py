from __future__ import annotations

from sqlalchemy.orm import Session

from ..workroom.repository import WorkroomRepository
from .repository import WorkspaceRepository


class WorkspaceService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.repo = WorkspaceRepository(db)
        self.workroom_repo = WorkroomRepository(db)

    def list_workspaces(self, *, tenant_id: int, user_id: int) -> list[dict]:
        return self.repo.list_workspaces(tenant_id=tenant_id, user_id=user_id)

    def create_workspace_with_workroom(
        self,
        *,
        tenant_id: int,
        user_id: int,
        name: str,
        topic: str | None,
    ) -> dict:
        workspace = self.repo.create_workspace(
            tenant_id=tenant_id,
            user_id=user_id,
            name=name,
            topic=topic,
        )
        workroom = self.repo.create_initial_workroom(
            workspace_id=int(workspace["id"]),
            tenant_id=tenant_id,
            user_id=user_id,
            name=f"{name} 工作台",
        )
        self.db.commit()
        return {"workspace": workspace, "workroom": workroom}

    def launch_workspace(
        self,
        *,
        tenant_id: int,
        user_id: int,
        workspace_id: int,
    ) -> dict:
        workspace = self.repo.get_workspace(
            tenant_id=tenant_id,
            user_id=user_id,
            workspace_id=workspace_id,
        )
        if workspace is None:
            raise ValueError("workspace_not_found")

        workroom = self.repo.get_latest_workroom_for_workspace(
            tenant_id=tenant_id,
            user_id=user_id,
            workspace_id=workspace_id,
        )
        if workroom is None:
            workroom = self.repo.create_initial_workroom(
                workspace_id=workspace_id,
                tenant_id=tenant_id,
                user_id=user_id,
                name=f'{workspace["name"]} 工作台',
            )

        runtime = self.workroom_repo.get_runtime_state(
            tenant_id=tenant_id,
            user_id=user_id,
            workroom_id=int(workroom["id"]),
        )
        if runtime is None:
            runtime = self.workroom_repo.upsert_runtime_state(
                tenant_id=tenant_id,
                user_id=user_id,
                workroom_id=int(workroom["id"]),
                values={},
            )

        self.db.commit()
        return {
            "workspace": workspace,
            "workroom": workroom,
            "runtime_state": runtime,
            "sources": self.workroom_repo.list_sources(
                tenant_id=tenant_id,
                user_id=user_id,
                workroom_id=int(workroom["id"]),
            ),
            "artifacts": self.workroom_repo.list_artifacts(
                tenant_id=tenant_id,
                user_id=user_id,
                workroom_id=int(workroom["id"]),
            ),
        }

    def delete_workspace(
        self,
        *,
        tenant_id: int,
        user_id: int,
        workspace_id: int,
    ) -> None:
        deleted = self.repo.delete_workspace(
            tenant_id=tenant_id,
            user_id=user_id,
            workspace_id=workspace_id,
        )
        if not deleted:
            raise ValueError("workspace_not_found")
        self.db.commit()
