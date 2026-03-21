from __future__ import annotations

import base64
import json
from functools import lru_cache
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


def _unit_ids_from_refs(refs: list[Any] | None) -> list[int]:
    unit_ids: list[int] = []
    for item in refs or []:
        ref = str(item or "").strip()
        if not ref.startswith("unit:"):
            continue
        try:
            unit_id = int(ref.split(":", 1)[1])
        except (TypeError, ValueError):
            continue
        if unit_id > 0:
            unit_ids.append(unit_id)
    return unit_ids


def _row_modality(row: dict[str, Any]) -> str:
    metadata = row.get("metadata_json") if isinstance(row.get("metadata_json"), dict) else {}
    modality = str(metadata.get("modality") or "").strip().lower()
    chunk_type = str(row.get("chunk_type") or "").strip().lower()
    if modality:
        return "image" if modality == "image" else "text"
    return "image" if "image" in chunk_type else "text"


@lru_cache(maxsize=256)
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


def _build_model_message_content(
    *,
    text_payload: dict[str, Any],
    image_data_url: str | None = None,
) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = [{"type": "text", "text": json.dumps(text_payload, ensure_ascii=False)}]
    if image_data_url:
        content.append({"type": "image_url", "image_url": {"url": str(image_data_url)}})
    return content


def _replace_model_text_payload(
    content: Any,
    *,
    text_payload: dict[str, Any],
) -> list[dict[str, Any]]:
    return _build_model_message_content(
        text_payload=text_payload,
        image_data_url=_extract_first_image_data_url(content),
    )


def _extract_first_image_data_url(content: Any) -> str | None:
    if not isinstance(content, list):
        return None
    for item in content:
        if not isinstance(item, dict):
            continue
        if str(item.get("type") or "").strip().lower() != "image_url":
            continue
        image_obj = item.get("image_url") if isinstance(item.get("image_url"), dict) else {}
        url = str(image_obj.get("url") or "").strip()
        if url.startswith("data:image/"):
            return url
    return None


def _build_doc_coverage(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    file_hits: dict[int, dict[str, Any]] = {}
    for row in rows:
        file_id = _safe_int(row.get("file_id"))
        if file_id is None:
            continue
        distance = _safe_float(row.get("distance"))
        modality = _row_modality(row)
        hit = file_hits.setdefault(
            file_id,
            {
                "file_id": file_id,
                "hit_count": 0,
                "text_hit_count": 0,
                "image_hit_count": 0,
                "best_distance": None,
            },
        )
        hit["hit_count"] = int(hit["hit_count"]) + 1
        if modality == "image":
            hit["image_hit_count"] = int(hit["image_hit_count"]) + 1
        else:
            hit["text_hit_count"] = int(hit["text_hit_count"]) + 1
        best = hit.get("best_distance")
        if best is None or distance < float(best):
            hit["best_distance"] = distance
    def _best_distance_sort_value(item: dict[str, Any]) -> float:
        raw = item.get("best_distance")
        if raw is None:
            return 9999.0
        try:
            return float(raw)
        except (TypeError, ValueError):
            return 9999.0

    return sorted(
        file_hits.values(),
        key=lambda x: (
            _best_distance_sort_value(x),
            -int(x.get("text_hit_count") or 0),
            -int(x.get("image_hit_count") or 0),
            -int(x.get("hit_count") or 0),
        ),
    )


def _resolve_bound_file_id(doc_coverage: list[dict[str, Any]]) -> int | None:
    if not doc_coverage:
        return None
    file_id = _safe_int(doc_coverage[0].get("file_id"))
    return file_id if file_id is not None and file_id > 0 else None


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

    doc_coverage = _build_doc_coverage(rows)

    unique_files = [int(item.get("file_id")) for item in doc_coverage if item.get("file_id") is not None]
    raw_evidence_count = len(snippets) + len(asset_refs)
    if raw_evidence_count <= 0:
        target_resolution_raw = "unbound"
    elif len(unique_files) == 1:
        target_resolution_raw = "bound"
    else:
        target_resolution_raw = "ambiguous"

    bound_file_id = _resolve_bound_file_id(doc_coverage)
    binding_applied = bool(
        bound_file_id is not None and target_resolution_raw == "ambiguous" and len(unique_files) > 1
    )
    if binding_applied and bound_file_id is not None:
        snippets = [item for item in snippets if _safe_int(item.get("file_id")) == bound_file_id]
        asset_refs = [item for item in asset_refs if _safe_int(item.get("file_id")) == bound_file_id]
        evidence_objects = [
            item
            for item in evidence_objects
            if _safe_int((item.get("payload") or {}).get("file_id")) == bound_file_id
        ]
        source_refs = [
            str(item.get("source_ref"))
            for item in evidence_objects
            if str(item.get("source_ref") or "").strip()
        ]

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
    target_resolution = "bound" if binding_applied and evidence_count > 0 else target_resolution_raw

    summary = {
        "evidence_count": evidence_count,
        "snippet_count": len(snippets),
        "asset_ref_count": len(asset_refs),
        "target_resolution": target_resolution,
        "target_resolution_raw": target_resolution_raw,
        "bound_file_id": bound_file_id,
        "binding_applied": binding_applied,
        "evidence_modality": evidence_modality,
    }
    snippet_file_ids = sorted(
        {
            int(file_id)
            for file_id in (_safe_int(item.get("file_id")) for item in snippets)
            if file_id is not None and int(file_id) > 0
        }
    )
    asset_file_ids = sorted(
        {
            int(file_id)
            for file_id in (_safe_int(item.get("file_id")) for item in asset_refs)
            if file_id is not None and int(file_id) > 0
        }
    )

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
        "target_resolution_raw": target_resolution_raw,
        "bound_file_id": bound_file_id,
        "binding_applied": binding_applied,
        "evidence_modality": evidence_modality,
        "doc_coverage": doc_coverage,
        "retrieval_stats": {
            "ranked_candidate_count": len(rows),
            "candidate_asset_count": len(asset_refs),
            "cross_file_mixed": target_resolution_raw == "ambiguous",
            "snippet_file_ids": snippet_file_ids,
            "asset_file_ids": asset_file_ids,
        },
    }

    model_message_content = _build_model_message_content(
        text_payload=model_text_payload,
        image_data_url=(str(vision_asset_inline.get("data_url") or "") if vision_asset_inline else None),
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
        "target_resolution_raw": target_resolution_raw,
        "bound_file_id": bound_file_id,
        "binding_applied": binding_applied,
        "evidence_modality": evidence_modality,
        "doc_coverage": doc_coverage,
        "source_refs": source_refs,
        "candidate_asset_count": len(asset_refs),
        "snippet_file_ids": snippet_file_ids,
        "asset_file_ids": asset_file_ids,
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


def _build_evidence_from_units(query: str, units: list[dict[str, Any]]) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for unit in units:
        unit_id = _safe_int(unit.get("unit_id")) or 0
        file_id = _safe_int(unit.get("file_id"))
        page_no_start = _safe_int(unit.get("page_no_start"))
        title = str(unit.get("title") or "")
        text_content = str(unit.get("text_content") or "").strip()
        primary_image_path = str(unit.get("primary_image_path") or "").strip()
        distance = _safe_float(unit.get("distance"))
        if primary_image_path:
            rows.append(
                {
                    "chunk_id": unit_id,
                    "distance": distance,
                    "chunk_type": "page_image",
                    "content": f"[unit image page {page_no_start or 1}]",
                    "metadata_json": {
                        "modality": "image",
                        "asset_rel_path": primary_image_path,
                        "page_no": page_no_start,
                    },
                    "file_id": file_id,
                    "document_id": unit.get("document_id"),
                    "page_start": page_no_start,
                    "page_end": _safe_int(unit.get("page_no_end")) or page_no_start,
                    "source_id": unit.get("source_id"),
                    "source_type": unit.get("source_type"),
                    "title": title,
                }
            )
        if text_content:
            rows.append(
                {
                    "chunk_id": unit_id,
                    "distance": distance,
                    "chunk_type": "unit_text",
                    "content": text_content,
                    "metadata_json": {"modality": "text", "unit_type": unit.get("unit_type"), "unit_key": unit.get("unit_key")},
                    "file_id": file_id,
                    "document_id": unit.get("document_id"),
                    "page_start": page_no_start,
                    "page_end": _safe_int(unit.get("page_no_end")) or page_no_start,
                    "source_id": unit.get("source_id"),
                    "source_type": unit.get("source_type"),
                    "title": title,
                }
            )
    built = _build_evidence_from_rows(query=query, rows=rows)
    source_refs: list[str] = []
    unit_ref_by_id: dict[int, str] = {}
    for unit in units:
        unit_id = _safe_int(unit.get("unit_id"))
        if unit_id is not None and unit_id > 0:
            ref = f"unit:{unit_id}"
            source_refs.append(ref)
            unit_ref_by_id[unit_id] = ref
    evidence_objects = built.get("evidence_objects") if isinstance(built.get("evidence_objects"), list) else []
    for obj in evidence_objects:
        if not isinstance(obj, dict):
            continue
        source_ref = str(obj.get("source_ref") or "")
        if not source_ref.startswith("chunk:"):
            continue
        try:
            ref_id = int(source_ref.split(":", 1)[1])
        except (TypeError, ValueError):
            continue
        if ref_id in unit_ref_by_id:
            obj["source_ref"] = unit_ref_by_id[ref_id]
    built["source_refs"] = source_refs
    built["evidence_units"] = [
        {
            "unit_id": _safe_int(unit.get("unit_id")),
            "unit_key": unit.get("unit_key"),
            "unit_type": unit.get("unit_type"),
            "file_id": _safe_int(unit.get("file_id")),
            "source_id": _safe_int(unit.get("source_id")),
            "page_no_start": _safe_int(unit.get("page_no_start")),
            "page_no_end": _safe_int(unit.get("page_no_end")),
            "title": unit.get("title"),
            "text_content": str(unit.get("text_content") or "")[:1200],
            "primary_image_path": unit.get("primary_image_path"),
            "distance": _safe_float(unit.get("distance")),
        }
        for unit in units
    ]
    model_input = built.get("model_input") if isinstance(built.get("model_input"), dict) else {}
    model_input["evidence_units"] = built.get("evidence_units")
    built["model_input"] = model_input
    return built


def _build_candidate_refs_from_units(query: str, units: list[dict[str, Any]]) -> dict[str, Any]:
    candidate_refs: list[str] = []
    doc_rows: list[dict[str, Any]] = []
    modality_kinds: set[str] = set()

    for unit in units:
        unit_id = _safe_int(unit.get("unit_id"))
        if unit_id is not None and unit_id > 0:
            candidate_refs.append(f"unit:{unit_id}")

        file_id = _safe_int(unit.get("file_id"))
        if file_id is not None:
            matched = unit.get("matched_embed_kinds")
            matched_kinds = matched if isinstance(matched, list) and matched else [unit.get("matched_embed_kind")]
            hit_count = len([kind for kind in matched_kinds if str(kind or "").strip()]) or 1
            text_hit_count = len([kind for kind in matched_kinds if str(kind or "").strip().lower() == "text"])
            image_hit_count = len([kind for kind in matched_kinds if str(kind or "").strip().lower() == "image"])
            doc_rows.append(
                {
                    "file_id": file_id,
                    "distance": _safe_float(unit.get("distance")),
                    "chunk_type": "page_image" if image_hit_count and not text_hit_count else "unit_text",
                    "metadata_json": {
                        "modality": "image" if image_hit_count and not text_hit_count else "text",
                    },
                }
            )
            for kind in matched_kinds:
                kind_text = str(kind or "").strip().lower()
                if kind_text:
                    modality_kinds.add(kind_text)

    doc_coverage = _build_doc_coverage(doc_rows)
    unique_files = [int(item.get("file_id")) for item in doc_coverage if item.get("file_id") is not None]
    if not candidate_refs:
        target_resolution = "unbound"
    elif len(unique_files) == 1:
        target_resolution = "bound"
    else:
        target_resolution = "ambiguous"

    if {"text", "image"} <= modality_kinds:
        evidence_modality = "mixed"
    elif "text" in modality_kinds:
        evidence_modality = "text"
    elif "image" in modality_kinds:
        evidence_modality = "visual"
    else:
        evidence_modality = "none"

    model_text_payload = {
        "query": query,
        "candidate_refs": candidate_refs,
        "doc_coverage": doc_coverage,
        "target_resolution": target_resolution,
        "answerability": "candidate_only",
        "evidence_modality": evidence_modality,
    }

    return {
        "query": query,
        "candidate_refs": candidate_refs,
        "source_refs": candidate_refs,
        "doc_coverage": doc_coverage,
        "target_resolution": target_resolution,
        "evidence_modality": evidence_modality,
        "model_message_content": _build_model_message_content(text_payload=model_text_payload),
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
            message="Visual evidence is available. Continue reasoning directly from the attached image evidence.",
            missing_information=[],
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

    return "partial_evidence", build_feedback(
        status="partial",
        outcome="readable_evidence_found",
        reason="evidence_requires_grounding",
        message="Readable evidence was found for the current target, but it still needs task-level grounding before answering or generating.",
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
        return "partial_evidence", build_feedback(
            status="partial",
            outcome="text_evidence_found",
            reason="text_evidence_requires_grounding",
            message=f"Read {snippet_count} text evidence snippet(s), but task-level grounding is still required before answering or generating.",
            missing_information=[],
            snippet_count=snippet_count,
            asset_ref_count=asset_ref_count,
        )

    if asset_ref_count > 0 or evidence_modality == "visual":
        return "visual_evidence_available", build_feedback(
            status="partial",
            outcome="visual_evidence_available",
            reason="visual_only_evidence",
            message="No readable text snippets were found, but visual evidence is attached and can be used directly.",
            missing_information=[],
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
    units = rag.search_units(
        tenant_id=int(ctx["tenant_id"]),
        user_id=int(ctx["user_id"]),
        workroom_id=int(ctx["workroom_id"]) if ctx.get("workroom_id") is not None else None,
        query_text=query,
        limit=max(top_k, _DEFAULT_TOP_K),
        source_file_ids=ctx_source_file_ids(ctx),
    )
    ranked_units = sorted(units, key=lambda row: _safe_float(row.get("distance")))[:top_k]
    built = _build_evidence_from_units(query=query, units=ranked_units)
    snippet_count = len(built.get("snippets") or [])
    asset_ref_count = len(built.get("asset_refs") or [])
    answerability, feedback = _derive_read_kb_evidence_semantics(
        query=query,
        target_resolution=str(built.get("target_resolution") or "unbound"),
        evidence_modality=str(built.get("evidence_modality") or "none"),
        snippet_count=snippet_count,
        asset_ref_count=asset_ref_count,
    )
    model_input = dict(built.get("model_input") or {})
    model_input["answerability"] = answerability
    model_input["feedback"] = feedback
    built["model_input"] = model_input
    built["model_message_content"] = _replace_model_text_payload(
        built.get("model_message_content"),
        text_payload=model_input,
    )

    return {
        **built,
        "answerability": answerability,
        "feedback": feedback,
    }


def _read_kb_snippets_from_refs(refs: list[str], query: str, ctx: dict[str, Any]) -> dict[str, Any]:
    unit_ids = _unit_ids_from_refs(refs)
    if unit_ids:
        rag = RAGService()
        units = rag.get_units_by_ids(
            tenant_id=int(ctx["tenant_id"]),
            user_id=int(ctx["user_id"]),
            unit_ids=unit_ids,
        )
        built = _build_evidence_from_units(query=query, units=units)
        snippets = built.get("snippets") if isinstance(built.get("snippets"), list) else []
        asset_refs = built.get("asset_refs") if isinstance(built.get("asset_refs"), list) else []
        answerability, feedback = _derive_snippet_semantics(
            target_resolution=str(built.get("target_resolution") or "unbound"),
            evidence_modality=str(built.get("evidence_modality") or "none"),
            snippet_count=len(snippets),
            asset_ref_count=len(asset_refs),
        )
        model_text_payload = {
            "query": query,
            "snippets": snippets[:_MAX_SNIPPETS_TO_MODEL],
            "asset_refs": [
                {
                    "chunk_id": item.get("chunk_id"),
                    "file_id": item.get("file_id"),
                    "page_no": item.get("page_no"),
                    "asset_kind": item.get("asset_kind"),
                    "distance": item.get("distance"),
                }
                for item in asset_refs[:_MAX_ASSET_REFS_TO_MODEL]
            ],
            "source_refs": refs,
            "target_resolution": built.get("target_resolution"),
            "answerability": answerability,
            "evidence_modality": built.get("evidence_modality"),
        }
        image_data_url = _extract_first_image_data_url(built.get("model_message_content"))
        return {
            "query": query,
            "snippets": snippets,
            "asset_refs": asset_refs,
            "evidence_units": built.get("evidence_units"),
            "source_refs": built.get("source_refs") if isinstance(built.get("source_refs"), list) else refs,
            "doc_coverage": built.get("doc_coverage") if isinstance(built.get("doc_coverage"), list) else [],
            "target_resolution": built.get("target_resolution"),
            "answerability": answerability,
            "evidence_modality": built.get("evidence_modality"),
            "feedback": feedback,
            "model_message_content": _build_model_message_content(
                text_payload=model_text_payload,
                image_data_url=image_data_url,
            ),
            "model_input": model_text_payload,
        }

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

    model_text_payload = {
        "query": query,
        "snippets": snippets[:_MAX_SNIPPETS_TO_MODEL],
        "asset_refs": [
            {
                "chunk_id": item.get("chunk_id"),
                "file_id": item.get("file_id"),
                "page_no": item.get("page_no"),
                "asset_kind": item.get("asset_kind"),
                "distance": item.get("distance"),
            }
            for item in asset_refs[:_MAX_ASSET_REFS_TO_MODEL]
        ],
        "source_refs": refs,
        "target_resolution": built.get("target_resolution"),
        "answerability": answerability,
        "evidence_modality": built.get("evidence_modality"),
        "visual_guidance": "If snippets are empty and an image is attached, use the image evidence directly.",
    }

    image_data_url = _extract_first_image_data_url(built.get("model_message_content"))

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
        "model_message_content": _build_model_message_content(
            text_payload=model_text_payload,
            image_data_url=image_data_url,
        ),
        "model_input": model_text_payload,
    }


def tool_search_kb_candidates(args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
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
                message="KB candidate search failed because query is empty.",
                missing_information=["query"],
            ),
        }

    top_k = normalize_int(args.get("top_k"), _DEFAULT_TOP_K, min_v=1, max_v=_MAX_TOP_K)
    rag = RAGService()
    units = rag.search_unit_refs(
        tenant_id=int(ctx["tenant_id"]),
        user_id=int(ctx["user_id"]),
        workroom_id=int(ctx["workroom_id"]) if ctx.get("workroom_id") is not None else None,
        query_text=query,
        limit=max(top_k, _DEFAULT_TOP_K),
        source_file_ids=ctx_source_file_ids(ctx),
    )
    ranked_units = sorted(units, key=lambda row: _safe_float(row.get("distance")))[:top_k]
    raw = _build_candidate_refs_from_units(query=query, units=ranked_units)

    candidate_refs = raw.get("candidate_refs") if isinstance(raw.get("candidate_refs"), list) else []
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
        "model_message_content": raw.get("model_message_content"),
        "model_input": raw.get("model_input"),
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

    model_text_payload = {
        "query": raw.get("query"),
        "snippets": snippets[:_MAX_SNIPPETS_TO_MODEL],
        "asset_refs": [
            {
                "chunk_id": item.get("chunk_id"),
                "file_id": item.get("file_id"),
                "page_no": item.get("page_no"),
                "asset_kind": item.get("asset_kind"),
                "distance": item.get("distance"),
            }
            for item in asset_refs[:_MAX_ASSET_REFS_TO_MODEL]
        ],
        "target_resolution": raw.get("target_resolution"),
        "answerability": answerability,
        "evidence_modality": raw.get("evidence_modality"),
        "visual_guidance": "If snippets are empty and an image is attached, use the image evidence directly.",
    }
    image_data_url = _extract_first_image_data_url(raw.get("model_message_content"))

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
        "model_message_content": _build_model_message_content(
            text_payload=model_text_payload,
            image_data_url=image_data_url,
        ),
        "model_input": model_text_payload,
    }
