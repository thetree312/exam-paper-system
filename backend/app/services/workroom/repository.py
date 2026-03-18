from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session


def _json_normalized(value: Any) -> str:
    return json.dumps(value or {}, ensure_ascii=False, sort_keys=True)


class WorkroomRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_current_workroom(self, *, tenant_id: int, user_id: int) -> dict[str, Any] | None:
        row = self.db.execute(
            text(
                """
                SELECT *
                FROM workrooms
                WHERE tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND status = 'active'
                ORDER BY updated_at DESC, id DESC
                LIMIT 1
                """
            ),
            {"tenant_id": tenant_id, "user_id": user_id},
        ).mappings().first()
        return dict(row) if row else None

    def create_workroom(self, *, tenant_id: int, user_id: int, name: str) -> dict[str, Any]:
        now = datetime.utcnow()
        row = self.db.execute(
            text(
                """
                INSERT INTO workrooms (tenant_id, user_id, name, status, created_at, updated_at)
                VALUES (:tenant_id, :user_id, :name, 'active', :now, :now)
                RETURNING *
                """
            ),
            {"tenant_id": tenant_id, "user_id": user_id, "name": name, "now": now},
        ).mappings().one()
        return dict(row)

    def get_runtime_state(self, *, tenant_id: int, user_id: int, workroom_id: int) -> dict[str, Any] | None:
        row = self.db.execute(
            text(
                """
                SELECT *
                FROM workroom_runtime_states
                WHERE tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND workroom_id = :workroom_id
                ORDER BY updated_at DESC, id DESC
                LIMIT 1
                """
            ),
            {"tenant_id": tenant_id, "user_id": user_id, "workroom_id": workroom_id},
        ).mappings().first()
        return dict(row) if row else None

    def upsert_runtime_state(
        self,
        *,
        tenant_id: int,
        user_id: int,
        workroom_id: int,
        values: dict[str, Any],
    ) -> dict[str, Any]:
        current = self.get_runtime_state(tenant_id=tenant_id, user_id=user_id, workroom_id=workroom_id)
        now = datetime.utcnow()
        merged = {
            "active_file_id": None,
            "active_session_id": None,
            "active_tab_index": 0,
            "active_studio_document_id": None,
            "active_agent_session_id": None,
            "active_extraction_session_id": None,
            "left_panel_state_json": {},
            "center_panel_state_json": {},
            "right_panel_state_json": {},
        }
        if current:
            merged.update(current)
        merged.update({k: v for k, v in values.items() if v is not None})
        params = {
            "tenant_id": tenant_id,
            "user_id": user_id,
            "workroom_id": workroom_id,
            "active_file_id": merged.get("active_file_id"),
            "active_session_id": merged.get("active_session_id"),
            "active_tab_index": int(merged.get("active_tab_index") or 0),
            "active_studio_document_id": merged.get("active_studio_document_id"),
            "active_agent_session_id": merged.get("active_agent_session_id"),
            "active_extraction_session_id": merged.get("active_extraction_session_id"),
            "left_panel_state_json": json.dumps(merged.get("left_panel_state_json") or {}, ensure_ascii=False),
            "center_panel_state_json": json.dumps(merged.get("center_panel_state_json") or {}, ensure_ascii=False),
            "right_panel_state_json": json.dumps(merged.get("right_panel_state_json") or {}, ensure_ascii=False),
            "updated_at": now,
        }
        if current:
            unchanged = (
                current.get("active_file_id") == params["active_file_id"]
                and current.get("active_session_id") == params["active_session_id"]
                and int(current.get("active_tab_index") or 0) == params["active_tab_index"]
                and current.get("active_studio_document_id") == params["active_studio_document_id"]
                and current.get("active_agent_session_id") == params["active_agent_session_id"]
                and current.get("active_extraction_session_id") == params["active_extraction_session_id"]
                and _json_normalized(current.get("left_panel_state_json"))
                == _json_normalized(merged.get("left_panel_state_json"))
                and _json_normalized(current.get("center_panel_state_json"))
                == _json_normalized(merged.get("center_panel_state_json"))
                and _json_normalized(current.get("right_panel_state_json"))
                == _json_normalized(merged.get("right_panel_state_json"))
            )
            if unchanged:
                return dict(current)

            row = self.db.execute(
                text(
                    """
                    UPDATE workroom_runtime_states
                    SET active_file_id = :active_file_id,
                        active_session_id = :active_session_id,
                        active_tab_index = :active_tab_index,
                        active_studio_document_id = :active_studio_document_id,
                        active_agent_session_id = :active_agent_session_id,
                        active_extraction_session_id = :active_extraction_session_id,
                        left_panel_state_json = CAST(:left_panel_state_json AS jsonb),
                        center_panel_state_json = CAST(:center_panel_state_json AS jsonb),
                        right_panel_state_json = CAST(:right_panel_state_json AS jsonb),
                        updated_at = :updated_at
                    WHERE id = :id
                    RETURNING *
                    """
                ),
                {**params, "id": current["id"]},
            ).mappings().one()
        else:
            row = self.db.execute(
                text(
                    """
                    INSERT INTO workroom_runtime_states (
                        tenant_id, user_id, workroom_id, active_file_id, active_session_id, active_tab_index,
                        created_at, updated_at, active_studio_document_id, active_agent_session_id,
                        active_extraction_session_id, left_panel_state_json, center_panel_state_json, right_panel_state_json
                    ) VALUES (
                        :tenant_id, :user_id, :workroom_id, :active_file_id, :active_session_id, :active_tab_index,
                        :updated_at, :updated_at, :active_studio_document_id, :active_agent_session_id,
                        :active_extraction_session_id, CAST(:left_panel_state_json AS jsonb),
                        CAST(:center_panel_state_json AS jsonb), CAST(:right_panel_state_json AS jsonb)
                    )
                    RETURNING *
                    """
                ),
                params,
            ).mappings().one()
        return dict(row)

    def list_sources(self, *, tenant_id: int, user_id: int, workroom_id: int) -> list[dict[str, Any]]:
        rows = self.db.execute(
            text(
                """
                SELECT *
                FROM workroom_source_bindings
                WHERE tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND workroom_id = :workroom_id
                  AND is_active = TRUE
                ORDER BY updated_at DESC, id DESC
                """
            ),
            {"tenant_id": tenant_id, "user_id": user_id, "workroom_id": workroom_id},
        ).mappings().all()
        return [dict(row) for row in rows]

    def bind_source_file(
        self,
        *,
        tenant_id: int,
        user_id: int,
        workroom_id: int,
        file_id: int,
    ) -> dict[str, Any]:
        existing = self.db.execute(
            text(
                """
                SELECT *
                FROM workroom_source_bindings
                WHERE tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND workroom_id = :workroom_id
                  AND file_id = :file_id
                ORDER BY id DESC
                LIMIT 1
                """
            ),
            {"tenant_id": tenant_id, "user_id": user_id, "workroom_id": workroom_id, "file_id": file_id},
        ).mappings().first()
        now = datetime.utcnow()
        if existing:
            row = self.db.execute(
                text(
                    """
                    UPDATE workroom_source_bindings
                    SET is_active = TRUE,
                        updated_at = :updated_at
                    WHERE id = :id
                    RETURNING *
                    """
                ),
                {"id": existing["id"], "updated_at": now},
            ).mappings().one()
            return dict(row)
        row = self.db.execute(
            text(
                """
                INSERT INTO workroom_source_bindings (
                    workroom_id, tenant_id, user_id, file_id, source_id, is_active, created_at, updated_at
                ) VALUES (
                    :workroom_id, :tenant_id, :user_id, :file_id, NULL, TRUE, :now, :now
                )
                RETURNING *
                """
            ),
            {"workroom_id": workroom_id, "tenant_id": tenant_id, "user_id": user_id, "file_id": file_id, "now": now},
        ).mappings().one()
        return dict(row)

    def list_artifacts(self, *, tenant_id: int, user_id: int, workroom_id: int) -> list[dict[str, Any]]:
        rows = self.db.execute(
            text(
                """
                SELECT *
                FROM workroom_panel_artifacts
                WHERE tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND workroom_id = :workroom_id
                ORDER BY updated_at DESC, id DESC
                """
            ),
            {"tenant_id": tenant_id, "user_id": user_id, "workroom_id": workroom_id},
        ).mappings().all()
        return [dict(row) for row in rows]

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
        existing = self.db.execute(
            text(
                """
                SELECT *
                FROM workroom_panel_artifacts
                WHERE tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND workroom_id = :workroom_id
                  AND artifact_type = :artifact_type
                  AND artifact_ref_id = :artifact_ref_id
                ORDER BY id DESC
                LIMIT 1
                """
            ),
            {
                "tenant_id": tenant_id,
                "user_id": user_id,
                "workroom_id": workroom_id,
                "artifact_type": artifact_type,
                "artifact_ref_id": artifact_ref_id,
            },
        ).mappings().first()
        now = datetime.utcnow()
        params = {
            "tenant_id": tenant_id,
            "user_id": user_id,
            "workroom_id": workroom_id,
            "artifact_type": artifact_type,
            "artifact_ref_id": artifact_ref_id,
            "source_file_id": source_file_id,
            "studio_document_id": studio_document_id,
            "payload_json": json.dumps(payload_json or {}, ensure_ascii=False),
            "updated_at": now,
        }
        if existing:
            row = self.db.execute(
                text(
                    """
                    UPDATE workroom_panel_artifacts
                    SET source_file_id = :source_file_id,
                        studio_document_id = :studio_document_id,
                        payload_json = CAST(:payload_json AS jsonb),
                        updated_at = :updated_at
                    WHERE id = :id
                    RETURNING *
                    """
                ),
                {**params, "id": existing["id"]},
            ).mappings().one()
        else:
            row = self.db.execute(
                text(
                    """
                    INSERT INTO workroom_panel_artifacts (
                        tenant_id, user_id, workroom_id, artifact_type, artifact_ref_id,
                        source_file_id, studio_document_id, payload_json, created_at, updated_at
                    ) VALUES (
                        :tenant_id, :user_id, :workroom_id, :artifact_type, :artifact_ref_id,
                        :source_file_id, :studio_document_id, CAST(:payload_json AS jsonb), :updated_at, :updated_at
                    )
                    RETURNING *
                    """
                ),
                params,
            ).mappings().one()
        return dict(row)

