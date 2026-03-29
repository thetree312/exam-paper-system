from __future__ import annotations

import re
from typing import Any


_INLINE_CITATION_RE = re.compile(r"\[(\d+)\]")
_RAG_CITATION_TOOLS = {"read_kb_evidence", "read_kb_snippets"}
_AUTO_CITATION_LIMIT = 2


def extract_inline_citation_indices(answer_text: str) -> list[int]:
    seen: set[int] = set()
    out: list[int] = []
    for match in _INLINE_CITATION_RE.finditer(str(answer_text or "")):
        try:
            idx = int(match.group(1))
        except (TypeError, ValueError):
            continue
        if idx <= 0 or idx in seen:
            continue
        seen.add(idx)
        out.append(idx)
    return out


def latest_rag_citation_candidates(tool_results: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    for item in reversed(list(tool_results or [])):
        if not isinstance(item, dict):
            continue
        if str(item.get("status") or "").strip().lower() != "ok":
            continue
        tool_name = str(item.get("tool_name") or "").strip()
        if tool_name not in _RAG_CITATION_TOOLS:
            continue
        output = item.get("output") if isinstance(item.get("output"), dict) else {}
        candidates = output.get("citation_candidates") if isinstance(output.get("citation_candidates"), list) else []
        normalized = [dict(candidate) for candidate in candidates if isinstance(candidate, dict)]
        if normalized:
            return normalized
    return []


def _candidate_map(candidates: list[dict[str, Any]] | None) -> dict[int, dict[str, Any]]:
    out: dict[int, dict[str, Any]] = {}
    for candidate in candidates or []:
        if not isinstance(candidate, dict):
            continue
        try:
            idx = int(candidate.get("citation_index"))
        except (TypeError, ValueError):
            continue
        if idx > 0 and idx not in out:
            out[idx] = dict(candidate)
    return out


def _format_inline_markers(indices: list[int]) -> str:
    return "".join(f"[{idx}]" for idx in indices if idx > 0)


def _inject_inline_citations(answer_text: str, indices: list[int]) -> str:
    text = str(answer_text or "").rstrip()
    markers = _format_inline_markers(indices)
    if not text or not markers:
        return text
    if text.endswith(markers):
        return text
    return f"{text}{markers}"


def build_final_answer_payload(answer_text: str, tool_results: list[dict[str, Any]] | None) -> dict[str, Any]:
    text = str(answer_text or "").strip()
    indices = extract_inline_citation_indices(text)
    if not text:
        return {
            "answer_text": "",
            "used_rag_evidence": False,
            "citation_status": "none",
            "citations": [],
            "cited_indices": [],
        }

    candidates = latest_rag_citation_candidates(tool_results)
    if not candidates:
        return {
            "answer_text": text,
            "used_rag_evidence": False,
            "citation_status": "none",
            "citations": [],
            "cited_indices": indices,
        }

    candidate_map = _candidate_map(candidates)
    if not candidate_map:
        return {
            "answer_text": text,
            "used_rag_evidence": False,
            "citation_status": "none",
            "citations": [],
            "cited_indices": indices,
        }

    resolved_indices = list(indices)
    if not resolved_indices:
        resolved_indices = sorted(candidate_map.keys())[:_AUTO_CITATION_LIMIT]
        text = _inject_inline_citations(text, resolved_indices)

    resolved = [dict(candidate_map[idx]) for idx in resolved_indices if idx in candidate_map]
    if not resolved:
        return {
            "answer_text": text,
            "used_rag_evidence": False,
            "citation_status": "none",
            "citations": [],
            "cited_indices": resolved_indices,
        }

    return {
        "answer_text": text,
        "used_rag_evidence": True,
        "citation_status": "complete" if len(resolved) == len(resolved_indices) else "partial",
        "citations": resolved,
        "cited_indices": resolved_indices,
    }


__all__ = [
    "build_final_answer_payload",
    "extract_inline_citation_indices",
    "latest_rag_citation_candidates",
]
