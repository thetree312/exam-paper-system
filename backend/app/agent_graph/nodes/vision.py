from __future__ import annotations

import json

from ..runtime import logger
from ...services.qwen_client import QwenVisionClient
from ..types import AgentState


def vision_node(state: AgentState) -> AgentState:
    if state.get("skip_model"):
        return state

    focus_list = state.get("vision_focus_questions") or []
    vision_items: list[dict] = []

    if focus_list:
        for ctx in focus_list:
            if not isinstance(ctx, dict):
                continue
            raw_urls = ctx.get("legend_images") or []
            if not isinstance(raw_urls, list):
                continue
            urls = [str(u) for u in raw_urls if u]
            if not urls:
                continue
            display_idx = ctx.get("display_index")
            if display_idx is None:
                seq = ctx.get("sequence_index")
                if isinstance(seq, int):
                    display_idx = seq + 1
            vision_items.append(
                {
                    "index": display_idx,
                    "page": ctx.get("page"),
                    "content": (ctx.get("content") or "").strip(),
                    "urls": urls,
                    "question_id": ctx.get("question_id"),
                }
            )
    else:
        questions = state.get("snapshot_questions") or []
        if not questions:
            return state
        for idx, q in enumerate(questions, start=1):
            if not isinstance(q, dict):
                continue
            raw = q.get("legend_images")
            legend_urls: list[str] = []
            if isinstance(raw, list):
                legend_urls = [str(u) for u in raw if u]
            elif isinstance(raw, str):
                try:
                    parsed = json.loads(raw)
                    if isinstance(parsed, list):
                        legend_urls = [str(u) for u in parsed if u]
                except Exception:  # noqa: BLE001
                    legend_urls = []
            if not legend_urls:
                continue
            vision_items.append(
                {
                    "index": q.get("display_index") or idx,
                    "page": q.get("page"),
                    "content": (q.get("content") or "").strip(),
                    "urls": legend_urls,
                    "question_id": q.get("id"),
                }
            )

    if not vision_items:
        logger.info(
            "agent.graph.vision_no_items tenant=%s user=%s focus_list=%s snapshot_count=%s",
            state.get("tenant_id"),
            state.get("user_id"),
            bool(focus_list),
            len(state.get("snapshot_questions") or []),
        )
        return state

    logger.info(
        "agent.graph.vision.items tenant=%s user=%s vision_items=%s",
        state.get("tenant_id"),
        state.get("user_id"),
        vision_items,
    )

    try:
        vision_client = QwenVisionClient()
        summary = vision_client.describe_exam_images(vision_items, doc_title=state.get("document_title")).strip()
        logger.info(
            "agent.graph.vision_ok tenant=%s user=%s document_id=%s focus_count=%s use_focus_list=%s question_ids=%s",
            state.get("tenant_id"),
            state.get("user_id"),
            state.get("document_id"),
            len(vision_items),
            bool(focus_list),
            [item.get("question_id") for item in vision_items],
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "agent.graph.vision_failed tenant=%s user=%s document_id=%s error=%s",
            state.get("tenant_id"),
            state.get("user_id"),
            state.get("document_id"),
            exc,
        )
        summary = ""

    if not summary:
        logger.info(
            "agent.graph.vision_empty_summary tenant=%s user=%s document_id=%s vision_items=%s",
            state.get("tenant_id"),
            state.get("user_id"),
            state.get("document_id"),
            vision_items,
        )
        return state

    logger.info(
        "agent.graph.vision.summary tenant=%s user=%s summary=%s",
        state.get("tenant_id"),
        state.get("user_id"),
        summary,
    )

    new_state = dict(state)
    new_state["vision_summary"] = summary
    return new_state


__all__ = ["vision_node"]
