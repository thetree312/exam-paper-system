from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from .repository import WorkroomRepository


class WorkroomService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.repo = WorkroomRepository(db)

    def get_or_create_current_workroom(self, *, tenant_id: int, user_id: int) -> dict[str, Any]:
        current = self.repo.get_current_workroom(tenant_id=tenant_id, user_id=user_id)
        if current:
            return current
        created = self.repo.create_workroom(
            tenant_id=tenant_id,
            user_id=user_id,
            name="未命名工作间",
        )
        self.db.commit()
        return created

    def get_current_payload(self, *, tenant_id: int, user_id: int) -> dict[str, Any]:
        workroom = self.get_or_create_current_workroom(tenant_id=tenant_id, user_id=user_id)
        runtime = self.repo.get_runtime_state(
            tenant_id=tenant_id,
            user_id=user_id,
            workroom_id=int(workroom["id"]),
        )
        if runtime is None:
            runtime = self.repo.upsert_runtime_state(
                tenant_id=tenant_id,
                user_id=user_id,
                workroom_id=int(workroom["id"]),
                values={},
            )
            self.db.commit()
        sources = self.repo.list_sources(
            tenant_id=tenant_id,
            user_id=user_id,
            workroom_id=int(workroom["id"]),
        )
        artifacts = self.repo.list_artifacts(
            tenant_id=tenant_id,
            user_id=user_id,
            workroom_id=int(workroom["id"]),
        )
        return {
            "workroom": workroom,
            "runtime_state": runtime,
            "sources": sources,
            "artifacts": artifacts,
        }

    def update_runtime_state(
        self,
        *,
        tenant_id: int,
        user_id: int,
        workroom_id: int,
        values: dict[str, Any],
    ) -> dict[str, Any]:
        row = self.repo.upsert_runtime_state(
            tenant_id=tenant_id,
            user_id=user_id,
            workroom_id=workroom_id,
            values=values,
        )
        self.db.commit()
        return row

    def bind_source_file(
        self,
        *,
        tenant_id: int,
        user_id: int,
        workroom_id: int,
        file_id: int,
    ) -> dict[str, Any]:
        row = self.repo.bind_source_file(
            tenant_id=tenant_id,
            user_id=user_id,
            workroom_id=workroom_id,
            file_id=file_id,
        )
        self.db.commit()
        return row

    def list_sources(self, *, tenant_id: int, user_id: int, workroom_id: int) -> list[dict[str, Any]]:
        return self.repo.list_sources(tenant_id=tenant_id, user_id=user_id, workroom_id=workroom_id)

    def upsert_artifact(
        self,
        *,
        tenant_id: int,
        user_id: int,
        workroom_id: int,
        artifact_type: str,
        artifact_ref_id: str,
        source_file_id: int | None,
        studio_document_id: int | None,
        payload_json: dict[str, Any],
    ) -> dict[str, Any]:
        row = self.repo.upsert_artifact(
            tenant_id=tenant_id,
            user_id=user_id,
            workroom_id=workroom_id,
            artifact_type=artifact_type,
            artifact_ref_id=artifact_ref_id,
            source_file_id=source_file_id,
            studio_document_id=studio_document_id,
            payload_json=payload_json,
        )
        self.db.commit()
        return row

