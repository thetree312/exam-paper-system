from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from sqlalchemy import text

from ..db import engine
from .qwen_client import QwenEmbeddingClient


logger = logging.getLogger("conversation_memory")


class ConversationMemoryService:
    """对话摘要与原子事实的持久化服务。

    当前实现：
    - 将 summarizer_node 生成的摘要和 facts 以行的形式写入 PostgreSQL 表 conversation_snapshots；
    - 暂不计算 embedding，仅预留列，后续可由异步任务补齐向量。
    """

    def __init__(self) -> None:
        self._engine = engine

    def add_snapshot(
        self,
        *,
        tenant_id: int,
        user_id: int,
        session_id: int,
        thread_id: Optional[str],
        turn_index: int,
        summary: str,
        facts: Optional[List[str]] = None,
    ) -> None:
        summary_text = (summary or "").strip()
        if not summary_text:
            return

        facts_payload: Optional[str]
        if facts and isinstance(facts, list):
            safe_facts: List[str] = []
            for item in facts:
                if isinstance(item, str):
                    txt = item.strip()
                    if txt:
                        safe_facts.append(txt)
            facts_payload = json.dumps(safe_facts, ensure_ascii=False) if safe_facts else None
        else:
            facts_payload = None

        # 生成 embedding 文本表示，便于 pgvector 插入
        embedding_str: Optional[str] = None
        try:
            emb_client = QwenEmbeddingClient()
            vecs = emb_client.embed(summary_text)
            if vecs:
                vec = vecs[0]
                embedding_str = "[" + ",".join(f"{x:.6f}" for x in vec) + "]"
        except Exception as exc:  # noqa: BLE001
            logger.exception("conversation_memory.embedding_failed error=%s", exc)

        sql = text(
            """
            INSERT INTO conversation_snapshots
                (tenant_id, user_id, session_id, thread_id, turn_index, summary, facts, embedding)
            VALUES
                (:tenant_id, :user_id, :session_id, :thread_id, :turn_index, :summary, :facts, CAST(:embedding AS vector))
            """
        )

        try:
            with self._engine.begin() as conn:
                conn.execute(
                    sql,
                    {
                        "tenant_id": int(tenant_id),
                        "user_id": int(user_id),
                        "session_id": int(session_id),
                        "thread_id": thread_id,
                        "turn_index": int(turn_index),
                        "summary": summary_text,
                        "facts": facts_payload,
                        "embedding": embedding_str,
                    },
                )
        except Exception as exc:  # noqa: BLE001
            logger.exception("conversation_memory.add_snapshot_failed error=%s", exc)

    def search_similar_snapshots(
        self,
        *,
        tenant_id: int,
        user_id: int,
        session_id: Optional[int] = None,
        query_text: str,
        limit: int = 5,
    ) -> List[Dict[str, Any]]:
        query = (query_text or "").strip()
        if not query:
            return []

        try:
            emb_client = QwenEmbeddingClient()
            vecs = emb_client.embed(query)
        except Exception as exc:  # noqa: BLE001
            logger.exception("conversation_memory.search.embedding_failed error=%s", exc)
            return []

        if not vecs:
            return []

        vec = vecs[0]
        embedding_str = "[" + ",".join(f"{x:.6f}" for x in vec) + "]"

        if session_id is not None:
            sql = text(
                """
                SELECT id, session_id, thread_id, turn_index, summary, facts
                FROM conversation_snapshots
                WHERE tenant_id = :tenant_id AND user_id = :user_id AND session_id = :session_id AND embedding IS NOT NULL
                ORDER BY embedding <-> CAST(:embedding AS vector)
                LIMIT :limit
                """
            )
        else:
            sql = text(
                """
                SELECT id, session_id, thread_id, turn_index, summary, facts
                FROM conversation_snapshots
                WHERE tenant_id = :tenant_id AND user_id = :user_id AND embedding IS NOT NULL
                ORDER BY embedding <-> CAST(:embedding AS vector)
                LIMIT :limit
                """
            )

        results: List[Dict[str, Any]] = []
        with self._engine.connect() as conn:
            try:
                params: Dict[str, Any] = {
                    "tenant_id": int(tenant_id),
                    "user_id": int(user_id),
                    "embedding": embedding_str,
                    "limit": int(limit),
                }
                if session_id is not None:
                    params["session_id"] = int(session_id)
                rows = conn.execute(sql, params)
            except Exception as exc:  # noqa: BLE001
                logger.exception("conversation_memory.search_failed error=%s", exc)
                return []

            for row in rows:
                try:
                    row_id = int(row[0])
                except (TypeError, ValueError):
                    row_id = 0
                session_id = row[1]
                thread_id = row[2]
                turn_index = row[3]
                summary = row[4] or ""
                facts_val = row[5]
                facts_list: List[str] = []
                if isinstance(facts_val, list):
                    for item in facts_val:
                        if isinstance(item, str) and item.strip():
                            facts_list.append(item.strip())
                results.append(
                    {
                        "id": row_id,
                        "session_id": session_id,
                        "thread_id": thread_id,
                        "turn_index": turn_index,
                        "summary": summary,
                        "facts": facts_list,
                    }
                )

        logger.info(
            "conversation_memory.search_ok tenant=%s user=%s query_len=%s result_count=%s",
            tenant_id,
            user_id,
            len(query),
            len(results),
        )
        return results


__all__ = ["ConversationMemoryService"]
