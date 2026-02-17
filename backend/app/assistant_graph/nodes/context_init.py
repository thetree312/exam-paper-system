from __future__ import annotations

from typing import List

from ..runtime import logger
from ..state import AgentMessageEntry, AgentState


def _build_dialogue_window(messages: List[AgentMessageEntry], limit_rounds: int = 12) -> List[AgentMessageEntry]:
    """简单按最近若干轮对话裁剪窗口，保持与旧实现行为类似但更轻量。"""

    if not messages:
        return []
    # 这里假设 messages 已按时间顺序给出，直接截取末尾若干条
    window = messages[-(limit_rounds * 2) :]
    return window


def context_init_node(state: AgentState) -> AgentState:
    """根据当前请求构建基础上下文：dialogue_window / snapshot_items / doc_context 等。

    - 复用入口注入的 snapshot_questions / document_title；
    - 构造统一的 snapshot_items 列表；
    - doc_context 仅保留紧凑的文档级元信息（例如标题），不再拼接题目预览，
      避免随题目数量线性增长的上下文膨胀。
    """

    messages = state.get("messages") or []

    prev_summary: str | None = state.get("history_summary")
    history_summary = prev_summary

    dialogue_window = _build_dialogue_window(messages)

    raw_snapshot = state.get("snapshot_questions") or []
    snapshot_items: list = []
    doc_context_lines: List[str] = []
    document_title: str | None = state.get("document_title")

    if isinstance(raw_snapshot, list):
        for q in raw_snapshot:
            if not isinstance(q, dict):
                continue
            item = {
                "type": "question",
                "id": q.get("id"),
                "sequence_index": q.get("sequence_index"),
                "page": q.get("page"),
                "content": q.get("content"),
                "legend_images": q.get("legend_images"),
                "vision_legend_images": q.get("vision_legend_images") or q.get("legend_images"),
                "has_legend_image": bool(q.get("has_legend_image") or q.get("vision_legend_images") or q.get("legend_images")),
            }
            snapshot_items.append(item)

    if document_title:
        doc_context_lines.append(f"当前文档标题：{document_title}")

    doc_context = "\n".join(doc_context_lines) if doc_context_lines else ""

    new_state: AgentState = dict(state)
    new_state["dialogue_window"] = dialogue_window
    new_state["snapshot_items"] = snapshot_items
    new_state["doc_context"] = doc_context
    new_state["document_title"] = document_title
    new_state["history_summary"] = history_summary

    # 题目工作集初始化：
    # - 仅从会话画像中恢复 active_question_ids / recent_question_ids；
    # - 若画像中不存在，则保持为空，让下游代理根据 latest_user + question_catalog 自主决定聚焦题目。
    profile = state.get("user_profile") or state.get("session_profile") or {}
    active_ids = []
    recent_ids = []
    vision_observations = []
    vision_evidence = []
    if isinstance(profile, dict):
        raw_active = profile.get("active_question_ids") or []
        raw_recent = profile.get("recent_question_ids") or []
        raw_vision = profile.get("vision_observations") or []
        raw_evidence = profile.get("vision_evidence") or []
        if isinstance(raw_active, list):
            for qid in raw_active:
                try:
                    q_int = int(qid)
                except (TypeError, ValueError):
                    continue
                if q_int not in active_ids:
                    active_ids.append(q_int)
        if isinstance(raw_recent, list):
            for qid in raw_recent:
                try:
                    q_int = int(qid)
                except (TypeError, ValueError):
                    continue
                if q_int not in recent_ids:
                    recent_ids.append(q_int)
        if isinstance(raw_vision, list):
            for item in raw_vision:
                if isinstance(item, dict):
                    vision_observations.append(item)
        if isinstance(raw_evidence, list):
            for item in raw_evidence:
                if isinstance(item, dict):
                    vision_evidence.append(item)

    # 兼容旧结构：当缺少结构化证据时，尝试从 vision_observations 迁移。
    if not vision_evidence and vision_observations:
        for item in vision_observations:
            if not isinstance(item, dict):
                continue
            summary = str(item.get("summary") or "").strip()
            if not summary:
                continue
            qids: list[int] = []
            raw_qids = item.get("question_ids")
            if isinstance(raw_qids, list):
                for qid in raw_qids:
                    try:
                        q_int = int(qid)
                    except (TypeError, ValueError):
                        continue
                    if q_int not in qids:
                        qids.append(q_int)
            if not qids:
                continue
            vision_evidence.append(
                {
                    "question_ids": qids,
                    "summary": summary,
                    "legend_fingerprint": "legacy",
                    "coverage": "partial",
                    "confidence": "unknown",
                }
            )

    new_state["active_question_ids"] = active_ids
    new_state["recent_question_ids"] = recent_ids
    if vision_observations:
        new_state["vision_observations"] = vision_observations[-8:]
    if vision_evidence:
        new_state["vision_evidence"] = vision_evidence[-12:]

    logger.info(
        "assistant.context_init.done tenant=%s user=%s document_id=%s snapshot_count=%s doc_ctx_len=%s",
        state.get("tenant_id"),
        state.get("user_id"),
        state.get("document_id"),
        len(snapshot_items),
        len(doc_context),
    )

    return new_state


__all__ = ["context_init_node"]
