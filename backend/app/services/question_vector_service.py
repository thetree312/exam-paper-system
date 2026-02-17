from __future__ import annotations

from typing import Iterable, List

import logging
from sqlalchemy import text

from ..db import engine


logger = logging.getLogger("question_vectors")


class QuestionVectorService:
    def __init__(self) -> None:
        self._engine = engine

    def get_similar_questions(
        self,
        *,
        tenant_id: int,
        document_id: int,
        base_question_ids: Iterable[int],
        per_base_limit: int = 4,
        max_total: int = 8,
    ) -> List[int]:
        base_ids = [int(qid) for qid in base_question_ids if isinstance(qid, int) or str(qid).isdigit()]
        if not base_ids:
            return []

        seen: set[int] = set()
        results: List[int] = []

        with self._engine.connect() as conn:
            for base_qid in base_ids:
                if len(results) >= max_total:
                    break
                try:
                    rows = conn.execute(
                        text(
                            """
                            SELECT q2.question_id
                            FROM question_vectors AS q1
                            JOIN question_vectors AS q2
                              ON q1.tenant_id = q2.tenant_id
                            WHERE q1.tenant_id = :tenant_id
                              AND q1.question_id = :base_qid
                            ORDER BY q2.embedding <-> q1.embedding
                            LIMIT :limit
                            """
                        ),
                        {
                            "tenant_id": int(tenant_id),
                            "base_qid": int(base_qid),
                            "limit": int(per_base_limit),
                        },
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.exception(
                        "question_vectors.similar_query_failed tenant=%s document=%s base_qid=%s error=%s",
                        tenant_id,
                        document_id,
                        base_qid,
                        exc,
                    )
                    continue

                for row in rows:
                    try:
                        qid = int(row[0])
                    except (TypeError, ValueError):
                        continue
                    if qid in seen:
                        continue
                    seen.add(qid)
                    results.append(qid)
                    if len(results) >= max_total:
                        break

        logger.info(
            "question_vectors.similar_query_ok tenant=%s document=%s base_ids=%s result_count=%s",
            tenant_id,
            document_id,
            base_ids,
            len(results),
        )
        return results
