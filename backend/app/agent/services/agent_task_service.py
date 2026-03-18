from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session


@dataclass
class AgentTaskRef:
    task_id: str
    tenant_id: int
    session_id: int
    status: str = "created"
    input_message_id: int | None = None
    output_message_id: int | None = None
    interrupt_id: str | None = None
    interrupt_reason_code: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    meta: dict[str, Any] = field(default_factory=dict)


class AgentTaskService:
    """Task facade backed by existing profile_events table (no new runtime tables)."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def _insert_profile_event(
        self,
        *,
        tenant_id: int,
        user_id: int,
        session_id: int,
        document_id: int | None,
        event_type: str,
        payload: dict[str, Any],
    ) -> None:
        self.db.execute(
            text(
                """
                INSERT INTO profile_events (
                  tenant_id, user_id, session_id, document_id, event_type, payload, processed, created_at
                ) VALUES (
                  :tenant_id, :user_id, :session_id, :document_id, :event_type, :payload, 0, CURRENT_TIMESTAMP
                )
                """
            ),
            {
                "tenant_id": tenant_id,
                "user_id": user_id,
                "session_id": session_id,
                "document_id": document_id,
                "event_type": event_type,
                "payload": json.dumps(payload, ensure_ascii=False),
            },
        )

    def append_event(self, *, task: AgentTaskRef, event_type: str, payload: dict[str, Any]) -> None:
        merged = {"task_id": task.task_id, **payload}
        self._insert_profile_event(
            tenant_id=task.tenant_id,
            user_id=int(task.meta.get("user_id") or 0),
            session_id=task.session_id,
            document_id=task.meta.get("document_id"),
            event_type=event_type,
            payload=merged,
        )

    def create_task(
        self,
        *,
        tenant_id: int,
        user_id: int,
        session_id: int,
        document_id: int | None = None,
        input_message_id: int | None = None,
    ) -> AgentTaskRef:
        task = AgentTaskRef(
            task_id=f"task_{uuid.uuid4().hex}",
            tenant_id=tenant_id,
            session_id=session_id,
            input_message_id=input_message_id,
            meta={"user_id": user_id, "document_id": document_id},
        )
        self.append_event(task=task, event_type="task_created", payload={"session_id": session_id})
        self.db.commit()
        return task

    def mark_running(self, task: AgentTaskRef) -> AgentTaskRef:
        task.status = "running"
        task.started_at = task.started_at or datetime.utcnow()
        self.append_event(task=task, event_type="task_running", payload={})
        self.db.commit()
        return task

    def mark_interrupted(
        self,
        *,
        task: AgentTaskRef,
        interrupt_id: str,
        reason_code: str,
    ) -> AgentTaskRef:
        task.status = "interrupted"
        task.interrupt_id = interrupt_id
        task.interrupt_reason_code = reason_code
        self.append_event(
            task=task,
            event_type="task_interrupted",
            payload={"interrupt_id": interrupt_id, "reason_code": reason_code},
        )
        self.db.commit()
        return task

    def mark_completed(self, *, task: AgentTaskRef, output_message_id: int | None) -> AgentTaskRef:
        task.status = "completed"
        task.output_message_id = output_message_id
        task.finished_at = datetime.utcnow()
        self.append_event(task=task, event_type="task_completed", payload={"output_message_id": output_message_id})
        self.db.commit()
        return task

    def mark_failed(self, *, task: AgentTaskRef, error_code: str, error_message: str) -> AgentTaskRef:
        task.status = "failed"
        task.error_code = error_code
        task.error_message = error_message
        task.finished_at = datetime.utcnow()
        self.append_event(
            task=task,
            event_type="task_failed",
            payload={"error_code": error_code, "error_message": error_message},
        )
        self.db.commit()
        return task

    def mark_cancelled(self, *, task: AgentTaskRef) -> AgentTaskRef:
        task.status = "cancelled"
        task.finished_at = datetime.utcnow()
        self.append_event(task=task, event_type="task_cancelled", payload={})
        self.db.commit()
        return task

    def attach_message_refs(
        self,
        *,
        task: AgentTaskRef,
        input_message_id: int | None,
        output_message_id: int | None,
    ) -> AgentTaskRef:
        if input_message_id is not None:
            task.input_message_id = input_message_id
        if output_message_id is not None:
            task.output_message_id = output_message_id
        self.append_event(
            task=task,
            event_type="task_message_refs_updated",
            payload={"input_message_id": task.input_message_id, "output_message_id": task.output_message_id},
        )
        self.db.commit()
        return task

    def find_interrupted_task(
        self,
        *,
        tenant_id: int,
        user_id: int,
        session_id: int,
        interrupt_id: str | None,
        document_id: int | None = None,
    ) -> AgentTaskRef:
        rows = self.db.execute(
            text(
                """
                SELECT event_type, payload, created_at
                FROM profile_events
                WHERE tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND session_id = :session_id
                  AND event_type IN ('task_created', 'task_interrupted')
                ORDER BY id DESC
                LIMIT 200
                """
            ),
            {
                "tenant_id": tenant_id,
                "user_id": user_id,
                "session_id": session_id,
            },
        ).fetchall()

        latest_task_id: str | None = None
        latest_interrupt: str | None = None
        latest_reason: str | None = None

        for event_type, payload_raw, _created_at in rows:
            payload: dict[str, Any]
            if isinstance(payload_raw, dict):
                payload = payload_raw
            else:
                try:
                    payload = json.loads(str(payload_raw or "{}"))
                except Exception:
                    payload = {}
            task_id = str(payload.get("task_id") or "").strip()
            if not task_id:
                continue

            if event_type == "task_interrupted":
                intr = str(payload.get("interrupt_id") or "").strip()
                if interrupt_id and intr != interrupt_id:
                    continue
                latest_task_id = task_id
                latest_interrupt = intr or None
                latest_reason = str(payload.get("reason_code") or "required_missing")
                break
            if event_type == "task_created" and latest_task_id is None:
                latest_task_id = task_id

        if not latest_task_id:
            raise HTTPException(status_code=404, detail="Interrupted task not found for this session")

        task = AgentTaskRef(
            task_id=latest_task_id,
            tenant_id=tenant_id,
            session_id=session_id,
            status="interrupted",
            interrupt_id=latest_interrupt,
            interrupt_reason_code=latest_reason,
            meta={"user_id": user_id, "document_id": document_id},
        )
        return task


__all__ = ["AgentTaskService", "AgentTaskRef"]
