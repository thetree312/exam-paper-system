from __future__ import annotations

import json
import re
from typing import Any

from sqlalchemy import text

from ...db import SessionLocal
from .common import build_feedback, normalize_int

_DEFAULT_TOP_K = 5
_MAX_TOP_K = 10
_MAX_CANDIDATE_SCAN = 300
_MAX_PREVIEW_CHARS = 160


def _studio_surface(ctx: dict[str, Any]) -> dict[str, Any]:
    env = ctx.get("environment") if isinstance(ctx.get("environment"), dict) else {}
    surfaces = env.get("surfaces") if isinstance(env.get("surfaces"), dict) else {}
    return surfaces.get("studio") if isinstance(surfaces.get("studio"), dict) else {}


def _studio_document_id(ctx: dict[str, Any]) -> int | None:
    studio_surface = _studio_surface(ctx)
    candidate = studio_surface.get("studio_document_id")
    if candidate is None:
        candidate = ctx.get("studio_document_id")
    try:
        value = int(candidate)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _extract_question_number(query: str) -> int | None:
    text_query = str(query or "")
    patterns = (
        r"第\s*(\d+)\s*题",
        r"question\s*(\d+)",
        r"\bq(?:uestion)?\s*(\d+)\b",
    )
    for pat in patterns:
        m = re.search(pat, text_query, flags=re.IGNORECASE)
        if not m:
            continue
        try:
            value = int(str(m.group(1) or "").strip())
        except (TypeError, ValueError):
            continue
        if value > 0:
            return value
    return None


def tool_get_studio_resource_summary(_args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    studio_surface = _studio_surface(ctx)
    summary = studio_surface.get("resource_summary") if isinstance(studio_surface.get("resource_summary"), dict) else {}
    payload = {
        "studio_document_id": _studio_document_id(ctx),
        "studio_view": studio_surface.get("studio_view"),
        "question_card_count": int(summary.get("question_card_count") or 0),
        "flashcard_count": int(summary.get("flashcard_count") or 0),
        "mindmap_node_count": int(summary.get("mindmap_node_count") or 0),
        "mindmap_edge_count": int(summary.get("mindmap_edge_count") or 0),
        "ocr_item_count": int(summary.get("ocr_item_count") or 0),
    }
    has_summary = any(
        int(payload.get(k) or 0) > 0
        for k in ("question_card_count", "flashcard_count", "mindmap_node_count", "mindmap_edge_count", "ocr_item_count")
    )
    target_resolution = "bound" if payload.get("studio_document_id") is not None else "unbound"
    if not has_summary and payload.get("studio_document_id") is None:
        return {
            "studio_summary": payload,
            "target_resolution": target_resolution,
            "answerability": "insufficient_context",
            "evidence_modality": "none",
            "feedback": build_feedback(
                status="insufficient",
                outcome="studio_context_missing",
                reason="studio_unbound",
                message="Current studio has no bound studio document; cannot build resource summary.",
                missing_information=["studio_document_id"],
            ),
            "model_input": payload,
        }

    return {
        "studio_summary": payload,
        "target_resolution": target_resolution,
        "answerability": "context_only",
        "evidence_modality": "none",
        "feedback": build_feedback(
            status="success",
            outcome="studio_context_available",
            reason="studio_summary_read",
            message=(
                f"Studio summary: question cards {payload['question_card_count']}, "
                f"flashcards {payload['flashcard_count']}, mindmap nodes {payload['mindmap_node_count']}."
            ),
            missing_information=[],
        ),
        "model_input": payload,
    }


def tool_resolve_question_card_candidates(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    query = str(args.get("query") or "").strip()
    if not query:
        return {
            "error": "empty_query",
            "target_resolution": "unbound",
            "answerability": "insufficient_context",
            "evidence_modality": "none",
            "feedback": build_feedback(
                status="error",
                outcome="invalid_input",
                reason="empty_query",
                message="Cannot locate question card because query is empty.",
                missing_information=["query"],
            ),
            "model_input": {"query": query, "studio_document_id": None},
        }

    studio_document_id = _studio_document_id(ctx)
    if studio_document_id is None:
        return {
            "query": query,
            "studio_document_id": None,
            "candidates": [],
            "candidate_count": 0,
            "target_resolution": "unbound",
            "answerability": "insufficient_context",
            "evidence_modality": "none",
            "source_refs": [],
            "feedback": build_feedback(
                status="insufficient",
                outcome="studio_context_missing",
                reason="studio_document_unbound",
                message="Current studio is not bound to a studio document; cannot resolve question candidates.",
                missing_information=["studio_document_id"],
            ),
            "model_input": {"query": query, "studio_document_id": None, "candidate_count": 0},
        }

    top_k = normalize_int(args.get("top_k"), _DEFAULT_TOP_K, min_v=1, max_v=_MAX_TOP_K)
    tenant_id = int(ctx["tenant_id"])
    question_no = _extract_question_number(query)
    query_lower = query.lower()
    keyword_terms = [w for w in re.findall(r"[A-Za-z0-9\u4e00-\u9fff]{2,}", query_lower) if w]

    db = SessionLocal()
    try:
        rows = db.execute(
            text(
                """
                SELECT id, sequence_index, page, content
                FROM questions
                WHERE tenant_id = :tenant_id
                  AND document_id = :document_id
                ORDER BY sequence_index ASC, id ASC
                LIMIT :scan_limit
                """
            ),
            {
                "tenant_id": tenant_id,
                "document_id": int(studio_document_id),
                "scan_limit": int(_MAX_CANDIDATE_SCAN),
            },
        ).fetchall()
    finally:
        db.close()

    scored: list[tuple[float, dict[str, Any]]] = []
    for row in rows:
        question_id = int(row[0])
        sequence_index = int(row[1] or 0)
        page_no = int(row[2]) if row[2] is not None else None
        content = str(row[3] or "")
        content_lower = content.lower()

        score = 0.0
        if question_no is not None and sequence_index == question_no:
            score += 100.0
        if question_no is not None and str(question_no) in content_lower:
            score += 8.0
        if query_lower and query_lower in content_lower:
            score += 16.0
        for term in keyword_terms[:8]:
            if term in content_lower:
                score += 2.0
        if ("图例" in query or "legend" in query_lower) and ("图例" in content or "legend" in content_lower):
            score += 6.0

        if score <= 0 and question_no is None:
            continue
        scored.append(
            (
                score,
                {
                    "question_id": question_id,
                    "sequence_index": sequence_index,
                    "page_no": page_no,
                    "preview": content[:_MAX_PREVIEW_CHARS],
                },
            )
        )

    scored.sort(key=lambda item: (-item[0], int(item[1].get("sequence_index") or 0), int(item[1].get("question_id") or 0)))
    candidates = [item[1] for item in scored[:top_k]]
    if not candidates and question_no is not None:
        candidates = [
            {
                "question_id": int(row[0]),
                "sequence_index": int(row[1] or 0),
                "page_no": int(row[2]) if row[2] is not None else None,
                "preview": str(row[3] or "")[:_MAX_PREVIEW_CHARS],
            }
            for row in rows[:top_k]
        ]

    target_resolution = "bound" if len(candidates) == 1 else ("ambiguous" if candidates else "unbound")
    source_refs = [f"question:{int(item['question_id'])}" for item in candidates if item.get("question_id")]
    if target_resolution == "bound":
        feedback = build_feedback(
            status="success",
            outcome="question_candidate_bound",
            reason="question_candidates_found",
            message="Resolved to exactly one question candidate.",
            missing_information=[],
        )
    elif target_resolution == "ambiguous":
        feedback = build_feedback(
            status="partial",
            outcome="question_candidates_ambiguous",
            reason="question_candidates_found",
            message=f"Resolved {len(candidates)} candidates; exact target still needs confirmation.",
            missing_information=["question_binding"],
        )
    else:
        feedback = build_feedback(
            status="insufficient",
            outcome="question_candidates_missing",
            reason="question_candidates_not_found",
            message="No question candidates found from current query and context.",
            missing_information=["question_binding"],
        )

    return {
        "query": query,
        "studio_document_id": studio_document_id,
        "candidates": candidates,
        "candidate_count": len(candidates),
        "target_resolution": target_resolution,
        "answerability": "candidate_only" if candidates else "insufficient_evidence",
        "evidence_modality": "none",
        "source_refs": source_refs,
        "feedback": feedback,
        "model_input": {
            "query": query,
            "studio_document_id": studio_document_id,
            "candidate_count": len(candidates),
            "target_resolution": target_resolution,
            "candidates": candidates,
        },
    }


def tool_read_studio_question_card(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    studio_document_id = _studio_document_id(ctx)
    if studio_document_id is None:
        return {
            "error": "studio_document_unbound",
            "target_resolution": "unbound",
            "answerability": "insufficient_context",
            "evidence_modality": "none",
            "feedback": build_feedback(
                status="error",
                outcome="missing_context",
                reason="studio_document_unbound",
                message="Failed to read question card: current studio has no bound studio document.",
                missing_information=["studio_document_id"],
            ),
        }

    question_id = args.get("question_id")
    sequence_index = args.get("sequence_index")
    resolved_question_id = None
    resolved_sequence_index = None
    try:
        if question_id is not None:
            resolved_question_id = int(question_id)
    except (TypeError, ValueError):
        resolved_question_id = None
    try:
        if sequence_index is not None:
            resolved_sequence_index = int(sequence_index)
    except (TypeError, ValueError):
        resolved_sequence_index = None

    if resolved_question_id is None and resolved_sequence_index is None:
        return {
            "error": "missing_question_selector",
            "target_resolution": "unbound",
            "answerability": "insufficient_context",
            "evidence_modality": "none",
            "feedback": build_feedback(
                status="error",
                outcome="invalid_input",
                reason="missing_question_selector",
                message="Failed to read question card: missing question_id or sequence_index.",
                missing_information=["question_id_or_sequence_index"],
            ),
        }

    tenant_id = int(ctx["tenant_id"])
    db = SessionLocal()
    try:
        if resolved_question_id is not None:
            row = db.execute(
                text(
                    """
                    SELECT id, sequence_index, page, content, legend_images
                    FROM questions
                    WHERE tenant_id = :tenant_id
                      AND document_id = :document_id
                      AND id = :question_id
                    LIMIT 1
                    """
                ),
                {
                    "tenant_id": tenant_id,
                    "document_id": int(studio_document_id),
                    "question_id": int(resolved_question_id),
                },
            ).fetchone()
        else:
            row = db.execute(
                text(
                    """
                    SELECT id, sequence_index, page, content, legend_images
                    FROM questions
                    WHERE tenant_id = :tenant_id
                      AND document_id = :document_id
                      AND sequence_index = :sequence_index
                    ORDER BY id ASC
                    LIMIT 1
                    """
                ),
                {
                    "tenant_id": tenant_id,
                    "document_id": int(studio_document_id),
                    "sequence_index": int(resolved_sequence_index),
                },
            ).fetchone()
    finally:
        db.close()

    if not row:
        return {
            "question_card": None,
            "target_resolution": "unbound",
            "answerability": "insufficient_evidence",
            "evidence_modality": "none",
            "feedback": build_feedback(
                status="insufficient",
                outcome="question_not_found",
                reason="question_not_found",
                message="No matching question card found.",
                missing_information=["question_binding"],
            ),
            "model_input": {
                "studio_document_id": studio_document_id,
                "question_id": resolved_question_id,
                "sequence_index": resolved_sequence_index,
            },
        }

    legend_images_raw = str(row[4] or "").strip()
    legend_images: Any = []
    if legend_images_raw:
        try:
            parsed = json.loads(legend_images_raw)
            legend_images = parsed if isinstance(parsed, list) else []
        except Exception:
            legend_images = []

    card = {
        "question_id": int(row[0]),
        "sequence_index": int(row[1] or 0),
        "page_no": int(row[2]) if row[2] is not None else None,
        "content": str(row[3] or ""),
        "legend_image_count": len(legend_images) if isinstance(legend_images, list) else 0,
    }
    source_refs = [f"question:{card['question_id']}"]

    return {
        "studio_document_id": studio_document_id,
        "question_card": card,
        "source_refs": source_refs,
        "target_resolution": "bound",
        "answerability": "answerable",
        "evidence_modality": "text",
        "feedback": build_feedback(
            status="success",
            outcome="question_card_readable",
            reason="question_card_read",
            message=f"Question card loaded: Q{card['sequence_index']} (ID={card['question_id']}).",
            missing_information=[],
        ),
        "model_input": {
            "studio_document_id": studio_document_id,
            "question_card": card,
            "source_refs": source_refs,
        },
    }

