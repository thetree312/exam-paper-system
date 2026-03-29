from __future__ import annotations

import json
from typing import Any

from ..tools import build_tool_schemas, execute_tool_call, parse_tool_arguments


def build_unknown_tool_output(tool_name: str) -> dict[str, Any]:
    available_tools = [
        str(x.get("function", {}).get("name") or "")
        for x in build_tool_schemas()
        if str(x.get("function", {}).get("name") or "").strip()
    ]
    attempted = str(tool_name or "").strip() or "<empty>"
    message = f"工具不存在: {attempted}"
    feedback = {
        "error_type": "unknown_tool",
        "message": message,
        "status": "error",
        "attempted_tool": str(tool_name or ""),
        "available_tools": available_tools,
        "hint": "请改用 available_tools 中的工具，或先向用户澄清目标对象。",
        "missing_information": ["tool_name"],
    }
    return {
        "error": message,
        "error_type": "unknown_tool",
        "attempted_tool": str(tool_name or ""),
        "available_tools": available_tools,
        "hint": feedback["hint"],
        "feedback": feedback,
        "model_message_content": feedback,
    }


def tool_result_to_trace(tool_name: str, args: dict[str, Any], output: dict[str, Any], *, ok: bool, tool_call_id: str) -> dict[str, Any]:
    source_refs: list[str] = []
    evidence_items: list[dict[str, Any]] = []
    if isinstance(output.get("source_refs"), list):
        source_refs = [str(x) for x in (output.get("source_refs") or []) if str(x).strip()]
    elif isinstance(output.get("results"), list):
        for row in output.get("results") or []:
            if not isinstance(row, dict):
                continue
            chunk_id = row.get("chunk_id")
            file_id = row.get("file_id")
            if chunk_id:
                source_refs.append(f"chunk:{chunk_id}")
            elif file_id:
                source_refs.append(f"file:{file_id}")

    for ref in source_refs[:5]:
        evidence_items.append({"source_ref": ref})

    feedback = output.get("feedback") if isinstance(output.get("feedback"), dict) else {}
    summary = "成功" if ok else "失败"
    if output.get("error"):
        summary = str(output.get("error"))
    elif isinstance(feedback, dict) and str(feedback.get("message") or "").strip():
        summary = str(feedback.get("message") or "").strip()
    elif isinstance(feedback, dict) and str(feedback.get("reason") or "").strip():
        summary = str(feedback.get("reason") or "").strip()
    elif output.get("evidence_summary"):
        summary_obj = output.get("evidence_summary") or {}
        if isinstance(summary_obj, dict):
            summary = f"返回了 {int(summary_obj.get('evidence_count') or 0)} 条证据对象"
    elif output.get("results"):
        summary = f"返回了 {len(output.get('results') or [])} 条证据项"
    elif output.get("sources"):
        summary = f"返回了 {len(output.get('sources') or [])} 条来源"
    elif output.get("excerpt"):
        summary = "返回了摘录片段"

    compact_output: dict[str, Any] = {}
    if output.get("error") is not None:
        compact_output["error"] = output.get("error")
    if output.get("error_type") is not None:
        compact_output["error_type"] = output.get("error_type")
    if output.get("attempted_tool") is not None:
        compact_output["attempted_tool"] = output.get("attempted_tool")
    if isinstance(output.get("available_tools"), list):
        compact_output["available_tools"] = output.get("available_tools")
    if output.get("hint") is not None:
        compact_output["hint"] = output.get("hint")
    if isinstance(output.get("feedback"), dict):
        compact_output["feedback"] = output.get("feedback")
    if isinstance(output.get("evidence_summary"), dict):
        compact_output["evidence_summary"] = output.get("evidence_summary")
    if output.get("answerability") is not None:
        compact_output["answerability"] = output.get("answerability")
    if output.get("insufficiency") is not None:
        compact_output["insufficiency"] = output.get("insufficiency")
    if output.get("target_resolution") is not None:
        compact_output["target_resolution"] = output.get("target_resolution")
    if output.get("doc_coverage") is not None:
        compact_output["doc_coverage"] = output.get("doc_coverage")
    if output.get("question_anchor_match") is not None:
        compact_output["question_anchor_match"] = output.get("question_anchor_match")
    if isinstance(output.get("best_asset_ref"), dict):
        compact_output["best_asset_ref"] = output.get("best_asset_ref")
    if isinstance(output.get("citation_candidates"), list):
        compact_output["citation_candidates"] = output.get("citation_candidates")
    if isinstance(output.get("source_refs"), list):
        compact_output["source_refs"] = output.get("source_refs")

    return {
        "tool_name": tool_name,
        "tool_call_id": tool_call_id,
        "status": "ok" if ok else "error",
        "arguments": args,
        "observation": {
            "query": str(args.get("query") or ""),
            "summary": summary,
            "outcome": str(feedback.get("status") or feedback.get("outcome") or ("ok" if ok else "error")),
        },
        "state_delta": {"evidence_items": evidence_items},
        "source_refs": source_refs,
        "output": compact_output,
    }

__all__ = [
    "build_tool_schemas",
    "execute_tool_call",
    "parse_tool_arguments",
    "build_unknown_tool_output",
    "tool_result_to_trace",
]
