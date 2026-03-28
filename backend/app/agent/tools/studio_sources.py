from __future__ import annotations

from typing import Any

from .common import build_feedback
from .studio_environment import _studio_resource_summary


def tool_list_studio_sources(_args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    payload = _studio_resource_summary(ctx)
    studio_document_id = payload.get("studio_document_id")

    if not any(
        int(payload.get(key) or 0) > 0
        for key in ("question_card_count", "flashcard_count", "mindmap_node_count", "mindmap_edge_count", "ocr_item_count")
    ):
        return {
            "studio_summary": {},
            "sources": {},
            "target_resolution": "unbound",
            "answerability": "insufficient_context",
            "evidence_modality": "none",
            "feedback": build_feedback(
                status="insufficient",
                outcome="studio_context_missing",
                reason="no_studio_summary",
                message="Current studio context has no readable source summary yet.",
                missing_information=["studio_summary"],
                evidence_count=0,
            ),
        }
    return {
        "studio_summary": payload,
        "sources": payload,
        "target_resolution": "bound" if studio_document_id is not None else "unbound",
        "answerability": "context_only",
        "evidence_modality": "none",
        "feedback": build_feedback(
            status="success",
            outcome="studio_context_available",
            reason="studio_summary_listed",
            message=(
                f"Workspace sources loaded: question cards {payload['question_card_count']}, "
                f"flashcards {payload['flashcard_count']}, mindmap nodes {payload['mindmap_node_count']}."
            ),
            missing_information=[],
            evidence_count=1,
        ),
    }

