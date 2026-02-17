from __future__ import annotations

from typing import List

from ...services.question_vector_service import QuestionVectorService
from ..runtime import logger
from ..state import AgentState
from .question_focus import _DEF_MAX_ACTIVE, _DEF_MAX_RECENT


_svc = QuestionVectorService()


def question_vector_expand_node(state: AgentState) -> AgentState:
    """基于 pgvector 按当前 active_question_ids 扩展少量相关题目。

    约束：
    - 只在同一 tenant/document 范围内检索；
    - 仅返回当前 snapshot_items 中存在的题目；
    - 最终 active_question_ids 仍然保持常数级（_DEF_MAX_ACTIVE）。
    """

    tenant_id = state.get("tenant_id")
    document_id = state.get("document_id")
    if not tenant_id or not document_id:
        return state

    raw_active = state.get("active_question_ids") or []
    if not isinstance(raw_active, list) or not raw_active:
        return state

    base_ids: list[int] = []
    for q in raw_active:
        try:
            base_ids.append(int(q))
        except (TypeError, ValueError):
            continue
    if not base_ids:
        return state

    # 从 question_vectors 中取相似题 ID 列表
    try:
        similar_ids = _svc.get_similar_questions(
            tenant_id=int(tenant_id),
            document_id=int(document_id),
            base_question_ids=base_ids,
            per_base_limit=4,
            max_total=8,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "assistant.question_vector_expand.query_failed tenant=%s document=%s base_ids=%s error=%s",
            tenant_id,
            document_id,
            base_ids,
            exc,
        )
        return state

    if not similar_ids:
        return state

    # 只保留当前 snapshot_items 中存在的题目，避免跨文档/脏数据
    snapshot_items = state.get("snapshot_items") or []
    valid_ids: set[int] = set()
    for item in snapshot_items:
        if not isinstance(item, dict) or item.get("type") != "question":
            continue
        qid = item.get("id")
        try:
            q_int = int(qid)
        except (TypeError, ValueError):
            continue
        valid_ids.add(q_int)

    candidates: list[int] = []
    for qid in similar_ids:
        try:
            q_int = int(qid)
        except (TypeError, ValueError):
            continue
        if q_int not in valid_ids:
            continue
        if q_int in base_ids:
            continue
        if q_int not in candidates:
            candidates.append(q_int)

    if not candidates:
        return state

    # 合并到新的 active 集合，保留原有顺序，补充若干相似题，仍限制最大数量
    new_active: list[int] = []
    for q in base_ids:
        if q not in new_active:
            new_active.append(q)

    for qid in candidates:
        if len(new_active) >= _DEF_MAX_ACTIVE:
            break
        if qid not in new_active:
            new_active.append(qid)

    # recent 集：在原有基础上补充新的 active
    raw_recent = state.get("recent_question_ids") or []
    new_recent: list[int] = []
    if isinstance(raw_recent, list):
        for q in raw_recent:
            try:
                q_int = int(q)
            except (TypeError, ValueError):
                continue
            if q_int not in new_recent:
                new_recent.append(q_int)
    for qid in new_active:
        if qid not in new_recent:
            new_recent.append(qid)
    if len(new_recent) > _DEF_MAX_RECENT:
        new_recent = new_recent[-_DEF_MAX_RECENT:]

    logger.info(
        "assistant.question_vector_expand.ok tenant=%s document=%s base_ids=%s candidates=%s active=%s recent=%s",
        tenant_id,
        document_id,
        base_ids,
        candidates,
        new_active,
        new_recent,
    )

    new_state: AgentState = dict(state)
    new_state["active_question_ids"] = new_active
    new_state["recent_question_ids"] = new_recent
    return new_state


__all__ = ["question_vector_expand_node"]
