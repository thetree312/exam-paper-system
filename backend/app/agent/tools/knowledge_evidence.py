from __future__ import annotations

import base64
import json
from io import BytesIO
from pathlib import Path
from typing import Any

from PIL import Image

from ...services.kb.rag_service import RAGService
from .common import build_feedback, ctx_source_file_ids, normalize_int

_BACKEND_ROOT = Path(__file__).resolve().parents[3]

_DEFAULT_TOP_K = 3
_MAX_TOP_K = 6
_MAX_SNIPPET_CHARS = 180
_MAX_SNIPPETS_TO_MODEL = 2
_MAX_ASSET_REFS_TO_MODEL = 3

# Keep a single best image to control token + latency cost.
_INLINE_SIDES = (1024, 896, 768, 640, 512, 384)
_INLINE_QUALITIES = (68, 58, 48, 38, 30)
_TARGET_BASE64_CHARS = 90_000


def _safe_int(value: Any) -> int | None:
    try:
        if value is None:
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def _safe_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _chunk_ids_from_refs(refs: list[Any] | None) -> list[int]:
    chunk_ids: list[int] = []
    for item in refs or []:
        ref = str(item or "").strip()
        if not ref.startswith("chunk:"):
            continue
        try:
            chunk_id = int(ref.split(":", 1)[1])
        except (TypeError, ValueError):
            continue
        if chunk_id > 0:
            chunk_ids.append(chunk_id)
    return chunk_ids


def _row_modality(row: dict[str, Any]) -> str:
    metadata = row.get("metadata_json") if isinstance(row.get("metadata_json"), dict) else {}
    modality = str(metadata.get("modality") or "").strip().lower()
    chunk_type = str(row.get("chunk_type") or "").strip().lower()
    if modality:
        return "image" if modality == "image" else "text"
    return "image" if "image" in chunk_type else "text"


def _encode_asset_as_data_url(asset_rel_path: str) -> str | None:
    rel = str(asset_rel_path or "").strip()
    if not rel:
        return None

    path = (_BACKEND_ROOT / rel).resolve()
    try:
        if not path.exists() or not path.is_file():
            return None
        raw = path.read_bytes()
    except Exception:
        return None

    if not raw:
        return None

    try:
        with Image.open(BytesIO(raw)) as img:
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            elif img.mode == "L":
                img = img.convert("RGB")

            resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS")

            for side in _INLINE_SIDES:
                for quality in _INLINE_QUALITIES:
                    tmp = img.copy()
                    tmp.thumbnail((side, side), resampling)
                    buf = BytesIO()
                    tmp.save(buf, format="JPEG", quality=quality, optimize=True)
                    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
                    data_url = f"data:image/jpeg;base64,{encoded}"
                    if len(data_url) <= _TARGET_BASE64_CHARS:
                        return data_url

            tmp = img.copy()
            tmp.thumbnail((_INLINE_SIDES[-1], _INLINE_SIDES[-1]), resampling)
            buf = BytesIO()
            tmp.save(buf, format="JPEG", quality=_INLINE_QUALITIES[-1], optimize=True)
            encoded = base64.b64encode(buf.getvalue()).decode("ascii")
            return f"data:image/jpeg;base64,{encoded}"
    except Exception:
        return None


def _build_evidence_from_rows(query: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    snippets: list[dict[str, Any]] = []
    asset_refs: list[dict[str, Any]] = []
    evidence_objects: list[dict[str, Any]] = []
    source_refs: list[str] = []

    for row in rows:
        content = str(row.get("content") or "")
        preview = content[:_MAX_SNIPPET_CHARS]
        metadata = row.get("metadata_json") if isinstance(row.get("metadata_json"), dict) else {}
        modality = _row_modality(row)

        file_id = _safe_int(row.get("file_id"))
        page_no = _safe_int(metadata.get("page_no") or row.get("page_start"))
        preview_url = (
            f"/api/files/preview/{file_id}?page={page_no if page_no and page_no > 0 else 1}"
            if file_id
            else None
        )

        chunk_id = _safe_int(row.get("chunk_id")) or 0
        distance = _safe_float(row.get("distance"))
        title = str(row.get("title") or "")
        source_ref = f"chunk:{chunk_id}" if chunk_id > 0 else None
        if source_ref:
            source_refs.append(source_ref)

        if modality == "image":
            item = {
                "chunk_id": chunk_id,
                "file_id": file_id,
                "title": title,
                "preview_url": preview_url,
                "page_no": page_no,
                "asset_kind": str(metadata.get("asset_kind") or ""),
                "asset_rel_path": str(metadata.get("asset_rel_path") or ""),
                "distance": distance,
            }
            asset_refs.append(item)
            evidence_objects.append(
                {
                    "kind": "asset_ref",
                    "source_ref": source_ref,
                    "distance": distance,
                    "payload": {"file_id": file_id, "page_no": page_no, "preview_url": preview_url},
                }
            )
        else:
            item = {
                "chunk_id": chunk_id,
                "file_id": file_id,
                "title": title,
                "page_start": row.get("page_start"),
                "page_end": row.get("page_end"),
                "content": preview,
                "distance": distance,
            }
            snippets.append(item)
            evidence_objects.append(
                {
                    "kind": "snippet",
                    "source_ref": source_ref,
                    "distance": distance,
                    "payload": {
                        "file_id": file_id,
                        "page_start": row.get("page_start"),
                        "page_end": row.get("page_end"),
                        "content": preview,
                    },
                }
            )

    evidence_count = len(snippets) + len(asset_refs)
    if snippets and asset_refs:
        evidence_modality = "mixed"
    elif snippets:
        evidence_modality = "text"
    elif asset_refs:
        evidence_modality = "visual"
    else:
        evidence_modality = "none"
    answerability = "evidence_available" if evidence_count > 0 else "insufficient_evidence"
    insufficiency = None if evidence_count > 0 else "no_semantic_evidence_found"

    file_hits: dict[int, dict[str, Any]] = {}
    for row in rows:
        file_id = _safe_int(row.get("file_id"))
        if file_id is None:
            continue
        distance = _safe_float(row.get("distance"))
        hit = file_hits.setdefault(file_id, {"file_id": file_id, "hit_count": 0, "best_distance": None})
        hit["hit_count"] = int(hit["hit_count"]) + 1
        best = hit.get("best_distance")
        if best is None or distance < float(best):
            hit["best_distance"] = distance

    doc_coverage = sorted(
        file_hits.values(),
        key=lambda x: (float(x.get("best_distance") or 9999), -int(x.get("hit_count") or 0)),
    )

    unique_files = [int(item.get("file_id")) for item in doc_coverage if item.get("file_id") is not None]
    if evidence_count <= 0:
        target_resolution = "unbound"
    elif len(unique_files) == 1:
        target_resolution = "bound"
    else:
        target_resolution = "ambiguous"

    summary = {
        "evidence_count": evidence_count,
        "snippet_count": len(snippets),
        "asset_ref_count": len(asset_refs),
        "target_resolution": target_resolution,
        "evidence_modality": evidence_modality,
    }

    best_asset_ref = asset_refs[0] if asset_refs else None
    vision_asset_inline: dict[str, Any] | None = None
    if best_asset_ref:
        data_url = _encode_asset_as_data_url(str(best_asset_ref.get("asset_rel_path") or ""))
        if data_url:
            vision_asset_inline = {
                "chunk_id": best_asset_ref.get("chunk_id"),
                "file_id": best_asset_ref.get("file_id"),
                "page_no": best_asset_ref.get("page_no"),
                "data_url": data_url,
            }

    model_asset_refs = [
        {
            "chunk_id": item.get("chunk_id"),
            "file_id": item.get("file_id"),
            "page_no": item.get("page_no"),
            "asset_kind": item.get("asset_kind"),
            "distance": item.get("distance"),
        }
        for item in asset_refs[:_MAX_ASSET_REFS_TO_MODEL]
    ]

    model_evidence_objects: list[dict[str, Any]] = []
    for obj in evidence_objects:
        payload = obj.get("payload") if isinstance(obj.get("payload"), dict) else {}
        model_evidence_objects.append(
            {
                "kind": obj.get("kind"),
                "source_ref": obj.get("source_ref"),
                "distance": obj.get("distance"),
                "payload": {
                    "file_id": payload.get("file_id"),
                    "page_no": payload.get("page_no"),
                    "page_start": payload.get("page_start"),
                    "page_end": payload.get("page_end"),
                    "content": payload.get("content"),
                },
            }
        )

    model_text_payload = {
        "query": query,
        "evidence_objects": model_evidence_objects,
        "snippets": snippets[:_MAX_SNIPPETS_TO_MODEL],
        "asset_refs": model_asset_refs,
        "best_asset_ref": (
            {
                "chunk_id": best_asset_ref.get("chunk_id"),
                "file_id": best_asset_ref.get("file_id"),
                "page_no": best_asset_ref.get("page_no"),
                "asset_kind": best_asset_ref.get("asset_kind"),
                "distance": best_asset_ref.get("distance"),
            }
            if best_asset_ref
            else None
        ),
        "evidence_summary": summary,
        "answerability": answerability,
        "insufficiency": insufficiency,
        "target_resolution": target_resolution,
        "evidence_modality": evidence_modality,
        "doc_coverage": doc_coverage,
        "retrieval_stats": {
            "ranked_candidate_count": len(rows),
            "candidate_asset_count": len(asset_refs),
        },
    }

    model_message_content: list[dict[str, Any]] = [
        {"type": "text", "text": json.dumps(model_text_payload, ensure_ascii=False)}
    ]
    if vision_asset_inline and vision_asset_inline.get("data_url"):
        model_message_content.append(
            {"type": "image_url", "image_url": {"url": str(vision_asset_inline.get("data_url") or "")}}
        )

    return {
        "query": query,
        "snippets": snippets,
        "asset_refs": asset_refs,
        "evidence_objects": evidence_objects,
        "best_asset_ref": best_asset_ref,
        "evidence_summary": summary,
        "answerability": answerability,
        "insufficiency": insufficiency,
        "target_resolution": target_resolution,
        "evidence_modality": evidence_modality,
        "doc_coverage": doc_coverage,
        "source_refs": source_refs,
        "candidate_asset_count": len(asset_refs),
        "vision_asset_inline": (
            {
                "chunk_id": vision_asset_inline.get("chunk_id"),
                "file_id": vision_asset_inline.get("file_id"),
                "page_no": vision_asset_inline.get("page_no"),
            }
            if vision_asset_inline
            else None
        ),
        "model_message_content": model_message_content,
        "model_input": model_text_payload,
    }


def _derive_read_kb_evidence_semantics(
    *,
    query: str,
    target_resolution: str,
    evidence_modality: str,
    snippet_count: int,
    asset_ref_count: int,
) -> tuple[str, dict[str, Any]]:
    evidence_count = int(snippet_count) + int(asset_ref_count)
    if evidence_count <= 0:
        return "insufficient_evidence", build_feedback(
            status="insufficient",
            outcome="no_evidence",
            reason="no_evidence_found",
            message="No semantic evidence was found for the current query.",
            missing_information=["query"],
            evidence_count=0,
            snippet_count=0,
            asset_ref_count=0,
        )

    if target_resolution == "ambiguous":
        return "ambiguous_target", build_feedback(
            status="partial",
            outcome="target_ambiguous",
            reason="multiple_documents_matched",
            message="Evidence was found, but it spans multiple documents and the target is still ambiguous.",
            missing_information=["target_binding"],
            evidence_count=evidence_count,
            snippet_count=snippet_count,
            asset_ref_count=asset_ref_count,
        )

    if evidence_modality == "visual":
        return "visual_evidence_only", build_feedback(
            status="partial",
            outcome="visual_evidence_found",
            reason="visual_only_evidence",
            message="Only visual evidence was found. Text evidence is still unavailable.",
            missing_information=["visual_interpretation"],
            evidence_count=evidence_count,
            snippet_count=snippet_count,
            asset_ref_count=asset_ref_count,
        )

    if target_resolution != "bound":
        return "insufficient_context", build_feedback(
            status="partial",
            outcome="target_unbound",
            reason="target_not_bound",
            message="Evidence was found, but the target object is not fully bound yet.",
            missing_information=["target_binding"],
            evidence_count=evidence_count,
            snippet_count=snippet_count,
            asset_ref_count=asset_ref_count,
        )

    return "answerable", build_feedback(
        status="success",
        outcome="readable_evidence_found",
        reason="evidence_found",
        message="Readable evidence was found for the current target.",
        missing_information=[],
        evidence_count=evidence_count,
        snippet_count=snippet_count,
        asset_ref_count=asset_ref_count,
    )


def _derive_search_candidate_semantics(
    *,
    target_resolution: str,
    candidate_refs: list[str],
    evidence_modality: str,
) -> tuple[str, dict[str, Any]]:
    if not candidate_refs:
        return "insufficient_evidence", build_feedback(
            status="insufficient",
            outcome="no_candidate_refs",
            reason="candidate_refs_missing",
            message="No candidate evidence references were found.",
            missing_information=["query"],
        )

    missing_information = ["readable_evidence"]
    if target_resolution != "bound":
        missing_information.append("target_binding")

    return "candidate_only", build_feedback(
        status="partial",
        outcome="candidate_refs_found",
        reason="candidate_refs_ranked",
        message=f"Found {len(candidate_refs)} candidate evidence references. Further reading is still required.",
        missing_information=missing_information,
        candidate_ref_count=len(candidate_refs),
        evidence_modality=evidence_modality,
    )


def _derive_snippet_semantics(
    *,
    target_resolution: str,
    evidence_modality: str,
    snippet_count: int,
    asset_ref_count: int,
) -> tuple[str, dict[str, Any]]:
    if snippet_count > 0 and target_resolution == "ambiguous":
        return "ambiguous_target", build_feedback(
            status="partial",
            outcome="target_ambiguous",
            reason="multiple_documents_matched",
            message="Text evidence was read, but it still maps to multiple candidate documents.",
            missing_information=["target_binding"],
            snippet_count=snippet_count,
            asset_ref_count=asset_ref_count,
        )

    if snippet_count > 0:
        return "answerable", build_feedback(
            status="success",
            outcome="text_evidence_found",
            reason="snippets_read",
            message=f"Read {snippet_count} text evidence snippet(s).",
            missing_information=[],
            snippet_count=snippet_count,
            asset_ref_count=asset_ref_count,
        )

    if asset_ref_count > 0 or evidence_modality == "visual":
        return "text_evidence_unavailable", build_feedback(
            status="insufficient",
            outcome="text_evidence_missing",
            reason="visual_only_evidence",
            message="Evidence references resolved, but no readable text snippets were available.",
            missing_information=["text_evidence"],
            snippet_count=0,
            asset_ref_count=asset_ref_count,
        )

    return "insufficient_evidence", build_feedback(
        status="insufficient",
        outcome="no_evidence",
        reason="no_evidence_found",
        message="No readable text evidence was found.",
        missing_information=["query"],
        snippet_count=0,
        asset_ref_count=0,
    )


def tool_read_kb_evidence(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
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
                message="KB evidence lookup failed because query is empty.",
                missing_information=["query"],
            ),
        }

    top_k = normalize_int(args.get("top_k"), _DEFAULT_TOP_K, min_v=1, max_v=_MAX_TOP_K)
    rag = RAGService()
    rows = rag.search_chunks(
        tenant_id=int(ctx["tenant_id"]),
        user_id=int(ctx["user_id"]),
        workroom_id=int(ctx["workroom_id"]) if ctx.get("workroom_id") is not None else None,
        query_text=query,
        limit=max(top_k, _DEFAULT_TOP_K),
        source_file_ids=ctx_source_file_ids(ctx),
    )

    ranked_rows = sorted(rows, key=lambda row: _safe_float(row.get("distance")))[:top_k]
    built = _build_evidence_from_rows(query=query, rows=ranked_rows)
    snippet_count = len(built.get("snippets") or [])
    asset_ref_count = len(built.get("asset_refs") or [])
    answerability, feedback = _derive_read_kb_evidence_semantics(
        query=query,
        target_resolution=str(built.get("target_resolution") or "unbound"),
        evidence_modality=str(built.get("evidence_modality") or "none"),
        snippet_count=snippet_count,
        asset_ref_count=asset_ref_count,
    )

    return {
        **built,
        "answerability": answerability,
        "feedback": feedback,
    }


def _read_kb_snippets_from_refs(refs: list[str], query: str, ctx: dict[str, Any]) -> dict[str, Any]:
    chunk_ids = _chunk_ids_from_refs(refs)
    if not chunk_ids:
        return {
            "error": "empty_refs",
            "target_resolution": "unbound",
            "answerability": "insufficient_context",
            "evidence_modality": "none",
            "feedback": build_feedback(
                status="error",
                outcome="invalid_input",
                reason="empty_refs",
                message="Snippet reading failed because no valid source references were provided.",
                missing_information=["source_refs"],
            ),
        }

    rag = RAGService()
    rows = rag.get_chunks_by_ids(
        tenant_id=int(ctx["tenant_id"]),
        user_id=int(ctx["user_id"]),
        chunk_ids=chunk_ids,
    )
    built = _build_evidence_from_rows(query=query, rows=rows)
    snippets = built.get("snippets") if isinstance(built.get("snippets"), list) else []
    asset_refs = built.get("asset_refs") if isinstance(built.get("asset_refs"), list) else []
    answerability, feedback = _derive_snippet_semantics(
        target_resolution=str(built.get("target_resolution") or "unbound"),
        evidence_modality=str(built.get("evidence_modality") or "none"),
        snippet_count=len(snippets),
        asset_ref_count=len(asset_refs),
    )

    return {
        "query": query,
        "snippets": snippets,
        "asset_refs": asset_refs,
        "source_refs": built.get("source_refs") if isinstance(built.get("source_refs"), list) else refs,
        "doc_coverage": built.get("doc_coverage") if isinstance(built.get("doc_coverage"), list) else [],
        "target_resolution": built.get("target_resolution"),
        "answerability": answerability,
        "evidence_modality": built.get("evidence_modality"),
        "feedback": feedback,
        "model_input": {
            "query": query,
            "snippets": snippets[:_MAX_SNIPPETS_TO_MODEL],
            "source_refs": refs,
            "target_resolution": built.get("target_resolution"),
            "answerability": answerability,
            "evidence_modality": built.get("evidence_modality"),
            "doc_coverage": built.get("doc_coverage"),
        },
    }


def tool_search_kb_candidates(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    raw = tool_read_kb_evidence(args, ctx)
    if raw.get("error"):
        return raw

    candidate_refs = [str(x) for x in (raw.get("source_refs") or []) if str(x).strip()]
    doc_coverage = raw.get("doc_coverage") if isinstance(raw.get("doc_coverage"), list) else []
    target_resolution = str(raw.get("target_resolution") or "unbound")
    evidence_modality = str(raw.get("evidence_modality") or "none")
    answerability, feedback = _derive_search_candidate_semantics(
        target_resolution=target_resolution,
        candidate_refs=candidate_refs,
        evidence_modality=evidence_modality,
    )

    return {
        "query": raw.get("query"),
        "candidate_refs": candidate_refs,
        "doc_coverage": doc_coverage,
        "target_resolution": target_resolution,
        "answerability": answerability,
        "evidence_modality": evidence_modality,
        "feedback": feedback,
        "model_input": {
            "query": raw.get("query"),
            "candidate_refs": candidate_refs,
            "doc_coverage": doc_coverage,
            "target_resolution": target_resolution,
            "answerability": answerability,
            "evidence_modality": evidence_modality,
        },
        "source_refs": candidate_refs,
    }


def tool_read_kb_snippets(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    refs = args.get("source_refs") if isinstance(args.get("source_refs"), list) else []
    if not refs and isinstance(args.get("candidate_refs"), list):
        refs = args.get("candidate_refs") or []

    normalized_refs = [str(x).strip() for x in refs if str(x).strip()]
    query = str(args.get("query") or "").strip()

    if normalized_refs:
        return _read_kb_snippets_from_refs(normalized_refs, query=query, ctx=ctx)

    raw = tool_read_kb_evidence(args, ctx)
    if raw.get("error"):
        return raw

    snippets = raw.get("snippets") if isinstance(raw.get("snippets"), list) else []
    asset_refs = raw.get("asset_refs") if isinstance(raw.get("asset_refs"), list) else []
    answerability, feedback = _derive_snippet_semantics(
        target_resolution=str(raw.get("target_resolution") or "unbound"),
        evidence_modality=str(raw.get("evidence_modality") or "none"),
        snippet_count=len(snippets),
        asset_ref_count=len(asset_refs),
    )

    return {
        "query": raw.get("query"),
        "snippets": snippets,
        "asset_refs": asset_refs,
        "source_refs": raw.get("source_refs") if isinstance(raw.get("source_refs"), list) else [],
        "doc_coverage": raw.get("doc_coverage") if isinstance(raw.get("doc_coverage"), list) else [],
        "target_resolution": raw.get("target_resolution"),
        "answerability": answerability,
        "evidence_modality": raw.get("evidence_modality"),
        "feedback": feedback,
        "model_input": {
            "query": raw.get("query"),
            "snippets": snippets[:_MAX_SNIPPETS_TO_MODEL],
            "target_resolution": raw.get("target_resolution"),
            "answerability": answerability,
            "evidence_modality": raw.get("evidence_modality"),
            "doc_coverage": raw.get("doc_coverage"),
        },
    }
