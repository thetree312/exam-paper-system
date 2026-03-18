from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session


class WorkspaceRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def list_workspaces(self, *, tenant_id: int, user_id: int) -> list[dict[str, Any]]:
        rows = self.db.execute(
            text(
                """
                SELECT *
                FROM workspaces
                WHERE tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND status = 'active'
                ORDER BY updated_at DESC, id DESC
                """
            ),
            {"tenant_id": tenant_id, "user_id": user_id},
        ).mappings().all()
        return [dict(row) for row in rows]

    def get_workspace(
        self,
        *,
        tenant_id: int,
        user_id: int,
        workspace_id: int,
    ) -> dict[str, Any] | None:
        row = self.db.execute(
            text(
                """
                SELECT *
                FROM workspaces
                WHERE id = :workspace_id
                  AND tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND status = 'active'
                LIMIT 1
                """
            ),
            {"workspace_id": workspace_id, "tenant_id": tenant_id, "user_id": user_id},
        ).mappings().first()
        return dict(row) if row else None

    def create_workspace(
        self,
        *,
        tenant_id: int,
        user_id: int,
        name: str,
        topic: str | None,
    ) -> dict[str, Any]:
        now = datetime.utcnow()
        row = self.db.execute(
            text(
                """
                INSERT INTO workspaces (tenant_id, user_id, name, topic, status, created_at, updated_at)
                VALUES (:tenant_id, :user_id, :name, :topic, 'active', :now, :now)
                RETURNING *
                """
            ),
            {
                "tenant_id": tenant_id,
                "user_id": user_id,
                "name": name,
                "topic": topic,
                "now": now,
            },
        ).mappings().one()
        return dict(row)

    def create_initial_workroom(
        self,
        *,
        workspace_id: int,
        tenant_id: int,
        user_id: int,
        name: str,
    ) -> dict[str, Any]:
        now = datetime.utcnow()
        row = self.db.execute(
            text(
                """
                INSERT INTO workrooms (workspace_id, tenant_id, user_id, name, status, created_at, updated_at)
                VALUES (:workspace_id, :tenant_id, :user_id, :name, 'active', :now, :now)
                RETURNING *
                """
            ),
            {
                "workspace_id": workspace_id,
                "tenant_id": tenant_id,
                "user_id": user_id,
                "name": name,
                "now": now,
            },
        ).mappings().one()
        return dict(row)

    def get_latest_workroom_for_workspace(
        self,
        *,
        tenant_id: int,
        user_id: int,
        workspace_id: int,
    ) -> dict[str, Any] | None:
        row = self.db.execute(
            text(
                """
                SELECT *
                FROM workrooms
                WHERE workspace_id = :workspace_id
                  AND tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND status = 'active'
                ORDER BY updated_at DESC, id DESC
                LIMIT 1
                """
            ),
            {"workspace_id": workspace_id, "tenant_id": tenant_id, "user_id": user_id},
        ).mappings().first()
        return dict(row) if row else None

    def delete_workspace(
        self,
        *,
        tenant_id: int,
        user_id: int,
        workspace_id: int,
    ) -> bool:
        exists_row = self.db.execute(
            text(
                """
                SELECT id
                FROM workspaces
                WHERE id = :workspace_id
                  AND tenant_id = :tenant_id
                  AND user_id = :user_id
                LIMIT 1
                """
            ),
            {
                "workspace_id": workspace_id,
                "tenant_id": tenant_id,
                "user_id": user_id,
            },
        ).mappings().first()
        if exists_row is None:
            return False

        scoped_workroom_sql = """
            SELECT id
            FROM workrooms
            WHERE workspace_id = :workspace_id
              AND tenant_id = :tenant_id
              AND user_id = :user_id
        """
        candidate_file_rows = self.db.execute(
            text(
                f"""
                SELECT DISTINCT file_id
                FROM (
                    SELECT b.file_id
                    FROM workroom_source_bindings b
                    WHERE b.tenant_id = :tenant_id
                      AND b.user_id = :user_id
                      AND b.workroom_id IN ({scoped_workroom_sql})
                    UNION
                    SELECT es.file_id
                    FROM extraction_sessions es
                    WHERE es.tenant_id = :tenant_id
                      AND es.user_id = :user_id
                      AND es.workroom_id IN ({scoped_workroom_sql})
                ) t
                WHERE file_id IS NOT NULL
                """
            ),
            {"workspace_id": workspace_id, "tenant_id": tenant_id, "user_id": user_id},
        ).fetchall()
        candidate_file_ids = [int(row[0]) for row in candidate_file_rows]

        # 1) KB 相关：先删作业、向量、分块、分页、来源
        self.db.execute(
            text(
                f"""
                DELETE FROM kb_ingest_jobs
                WHERE source_id IN (
                    SELECT s.id
                    FROM kb_sources s
                    WHERE s.tenant_id = :tenant_id
                      AND s.user_id = :user_id
                      AND s.workroom_id IN ({scoped_workroom_sql})
                )
                """
            ),
            {"workspace_id": workspace_id, "tenant_id": tenant_id, "user_id": user_id},
        )
        self.db.execute(
            text(
                f"""
                DELETE FROM kb_chunk_embeddings
                WHERE chunk_id IN (
                    SELECT c.id
                    FROM kb_chunks c
                    JOIN kb_sources s ON s.id = c.source_id
                    WHERE s.tenant_id = :tenant_id
                      AND s.user_id = :user_id
                      AND s.workroom_id IN ({scoped_workroom_sql})
                )
                """
            ),
            {"workspace_id": workspace_id, "tenant_id": tenant_id, "user_id": user_id},
        )
        self.db.execute(
            text(
                f"""
                DELETE FROM kb_chunks
                WHERE source_id IN (
                    SELECT s.id
                    FROM kb_sources s
                    WHERE s.tenant_id = :tenant_id
                      AND s.user_id = :user_id
                      AND s.workroom_id IN ({scoped_workroom_sql})
                )
                """
            ),
            {"workspace_id": workspace_id, "tenant_id": tenant_id, "user_id": user_id},
        )
        self.db.execute(
            text(
                f"""
                DELETE FROM kb_source_pages
                WHERE source_id IN (
                    SELECT s.id
                    FROM kb_sources s
                    WHERE s.tenant_id = :tenant_id
                      AND s.user_id = :user_id
                      AND s.workroom_id IN ({scoped_workroom_sql})
                )
                """
            ),
            {"workspace_id": workspace_id, "tenant_id": tenant_id, "user_id": user_id},
        )
        self.db.execute(
            text(
                f"""
                DELETE FROM kb_sources
                WHERE tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND workroom_id IN ({scoped_workroom_sql})
                """
            ),
            {"workspace_id": workspace_id, "tenant_id": tenant_id, "user_id": user_id},
        )

        # 2) Agent 会话与消息
        self.db.execute(
            text(
                f"""
                DELETE FROM agent_messages
                WHERE tenant_id = :tenant_id
                  AND session_id IN (
                      SELECT id
                      FROM agent_sessions
                      WHERE tenant_id = :tenant_id
                        AND user_id = :user_id
                        AND workroom_id IN ({scoped_workroom_sql})
                  )
                """
            ),
            {"workspace_id": workspace_id, "tenant_id": tenant_id, "user_id": user_id},
        )
        self.db.execute(
            text(
                f"""
                DELETE FROM agent_sessions
                WHERE tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND workroom_id IN ({scoped_workroom_sql})
                """
            ),
            {"workspace_id": workspace_id, "tenant_id": tenant_id, "user_id": user_id},
        )

        # 3) Workroom 运行态/绑定/面板产物
        self.db.execute(
            text(
                f"""
                DELETE FROM workroom_panel_artifacts
                WHERE tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND workroom_id IN ({scoped_workroom_sql})
                """
            ),
            {"workspace_id": workspace_id, "tenant_id": tenant_id, "user_id": user_id},
        )
        self.db.execute(
            text(
                f"""
                DELETE FROM workroom_runtime_states
                WHERE tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND workroom_id IN ({scoped_workroom_sql})
                """
            ),
            {"workspace_id": workspace_id, "tenant_id": tenant_id, "user_id": user_id},
        )
        self.db.execute(
            text(
                f"""
                DELETE FROM workroom_source_bindings
                WHERE tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND workroom_id IN ({scoped_workroom_sql})
                """
            ),
            {"workspace_id": workspace_id, "tenant_id": tenant_id, "user_id": user_id},
        )

        # 4) 文档相关
        self.db.execute(
            text(
                f"""
                DELETE FROM flashcard_generation_jobs
                WHERE tenant_id = :tenant_id
                  AND document_id IN (
                      SELECT id
                      FROM documents
                      WHERE tenant_id = :tenant_id
                        AND workroom_id IN ({scoped_workroom_sql})
                  )
                """
            ),
            {"workspace_id": workspace_id, "tenant_id": tenant_id, "user_id": user_id},
        )
        self.db.execute(
            text(
                f"""
                DELETE FROM question_catalogs
                WHERE tenant_id = :tenant_id
                  AND document_id IN (
                      SELECT id
                      FROM documents
                      WHERE tenant_id = :tenant_id
                        AND workroom_id IN ({scoped_workroom_sql})
                  )
                """
            ),
            {"workspace_id": workspace_id, "tenant_id": tenant_id, "user_id": user_id},
        )
        self.db.execute(
            text(
                f"""
                DELETE FROM documents
                WHERE tenant_id = :tenant_id
                  AND workroom_id IN ({scoped_workroom_sql})
                """
            ),
            {"workspace_id": workspace_id, "tenant_id": tenant_id, "user_id": user_id},
        )

        # 5) 抽取会话数据
        self.db.execute(
            text(
                f"""
                DELETE FROM extraction_sessions
                WHERE tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND workroom_id IN ({scoped_workroom_sql})
                """
            ),
            {"workspace_id": workspace_id, "tenant_id": tenant_id, "user_id": user_id},
        )

        # 6) 清理仅由该 workspace 使用的文件缓存与文件记录
        if candidate_file_ids:
            self.db.execute(
                text(
                    """
                    DELETE FROM file_ocr_cache foc
                    WHERE foc.tenant_id = :tenant_id
                      AND foc.file_id = ANY(:file_ids)
                      AND NOT EXISTS (
                          SELECT 1
                          FROM extraction_sessions es
                          WHERE es.file_id = foc.file_id
                      )
                      AND NOT EXISTS (
                          SELECT 1
                          FROM workroom_source_bindings wb
                          WHERE wb.file_id = foc.file_id
                      )
                    """
                ),
                {"tenant_id": tenant_id, "file_ids": candidate_file_ids},
            )
            self.db.execute(
                text(
                    """
                    DELETE FROM files f
                    WHERE f.tenant_id = :tenant_id
                      AND f.id = ANY(:file_ids)
                      AND NOT EXISTS (
                          SELECT 1
                          FROM extraction_sessions es
                          WHERE es.file_id = f.id
                      )
                      AND NOT EXISTS (
                          SELECT 1
                          FROM workroom_source_bindings wb
                          WHERE wb.file_id = f.id
                      )
                    """
                ),
                {"tenant_id": tenant_id, "file_ids": candidate_file_ids},
            )

        # 7) 删除 workroom / workspace 本体
        self.db.execute(
            text(
                """
                DELETE FROM workrooms
                WHERE workspace_id = :workspace_id
                  AND tenant_id = :tenant_id
                  AND user_id = :user_id
                """
            ),
            {
                "workspace_id": workspace_id,
                "tenant_id": tenant_id,
                "user_id": user_id,
            },
        )
        self.db.execute(
            text(
                """
                DELETE FROM workspaces
                WHERE id = :workspace_id
                  AND tenant_id = :tenant_id
                  AND user_id = :user_id
                """
            ),
            {
                "workspace_id": workspace_id,
                "tenant_id": tenant_id,
                "user_id": user_id,
            },
        )
        return True
