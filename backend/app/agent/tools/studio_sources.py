from __future__ import annotations

from typing import Any

from .common import build_feedback


def tool_list_studio_sources(_args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    env = ctx.get("environment") if isinstance(ctx.get("environment"), dict) else {}
    surfaces = env.get("surfaces") if isinstance(env.get("surfaces"), dict) else {}
    studio_surface = surfaces.get("studio") if isinstance(surfaces.get("studio"), dict) else {}
    summary = studio_surface.get("resource_summary") if isinstance(studio_surface.get("resource_summary"), dict) else {}
    studio_document_id = studio_surface.get("studio_document_id")
    studio_view = studio_surface.get("studio_view")

    if not summary:
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

    payload = {
        "studio_document_id": studio_document_id,
        "studio_view": studio_view,
        "question_card_count": int(summary.get("question_card_count") or 0),
        "flashcard_count": int(summary.get("flashcard_count") or 0),
        "mindmap_node_count": int(summary.get("mindmap_node_count") or 0),
        "mindmap_edge_count": int(summary.get("mindmap_edge_count") or 0),
        "ocr_item_count": int(summary.get("ocr_item_count") or 0),
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

