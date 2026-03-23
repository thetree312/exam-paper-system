from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any
from uuid import uuid4

from .binding import ReferenceBindingService
from .schemas import DocOutline, MindMapDocument, MindMapDraft, MindMapDraftNode, MindMapMode, QualityReport


def _node_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:10]}"


def _clean_text(value: str | None, *, limit: int = 160) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(text) <= limit:
        return text
    return text[: limit - 3].rstrip() + "..."


def _branch_side(index: int) -> str:
    return "left" if index % 2 == 0 else "right"


def _strip_code_fence(text: str) -> str:
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw, count=1, flags=re.IGNORECASE)
        raw = re.sub(r"\s*```$", "", raw, count=1)
    return raw.strip()


def _extract_first_json_object(text: str) -> str:
    raw = _strip_code_fence(text)
    start = raw.find("{")
    if start < 0:
        raise ValueError("No JSON object found in LLM response")

    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(raw)):
        char = raw[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return raw[start : index + 1]
    raise ValueError("Incomplete JSON object in LLM response")


def render_question_source(title: str, questions: list[dict[str, Any]]) -> str:
    lines = [
        f"Document title: {title}",
        "Question material:",
    ]
    for item in questions[:40]:
        sequence_index = item.get("sequence_index")
        page = item.get("page")
        content = _clean_text(item.get("content"), limit=320)
        lines.append(
            f"- Question Q{(sequence_index or 0) + 1} | page={page or '?'} | id={item.get('id')}: {content}"
        )
    return "\n".join(lines)


def render_block_source(title: str, blocks: list[dict[str, Any]]) -> str:
    grouped: dict[int | None, list[str]] = {}
    for item in blocks[:48]:
        text = _clean_text(item.get("text"), limit=240)
        if not text:
            continue
        grouped.setdefault(item.get("page"), []).append(text)

    lines = [
        f"Document title: {title}",
        "Source snippets:",
    ]
    for page in sorted(grouped.keys(), key=lambda value: (value is None, value or 0)):
        lines.append(f"## Page {page or '?'}")
        for snippet in grouped[page][:4]:
            lines.append(f"- {snippet}")
    return "\n".join(lines)


def build_outline_generation_messages(
    *,
    title: str,
    source_text: str,
    source_type: str,
    source_id: int,
    mode: MindMapMode,
) -> list[dict[str, str]]:
    mode_label = "knowledge structure map" if mode == "knowledge_structure" else "exam/review map"
    title_json = json.dumps(title, ensure_ascii=False)
    system_prompt = f"""
You are preparing a high-quality {mode_label}.

Do not output the final mindmap yet.
First extract a compact document outline that captures the real semantic structure of the material.

Return JSON only. No prose, no markdown, no comments.

Use exactly this shape:
{{
  "title": {title_json},
  "mode": {json.dumps(mode)},
  "documentSummary": "high-level synthesis of the document",
  "topics": [
    {{
      "topic": "top-level topic",
      "summary": "why this topic matters",
      "subtopics": [
        {{
          "topic": "refined subtopic",
          "summary": "what this subtopic covers",
          "evidenceHints": ["page 2", "question 4"]
        }}
      ]
    }}
  ]
}}

Rules:
1. Topics must be semantic topics, not page labels or snippets.
2. Prefer 4 to 8 top-level topics when the source supports it.
3. Keep the outline compact and merge overlapping ideas.
4. If mode is exam_review, bias topics toward tested themes, methods, and traps.
5. If mode is knowledge_structure, bias topics toward concepts, principles, and hierarchy.
6. Do not output ids, database fields, or questionRefs.
7. Source metadata: source_type={json.dumps(source_type)}, source_id={source_id}
""".strip()
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": source_text},
    ]


def build_file_outline_generation_messages(
    *,
    title: str,
    bailian_file_id: str,
    source_type: str,
    source_id: int,
    mode: MindMapMode,
) -> list[dict[str, str]]:
    mode_label = "knowledge structure map" if mode == "knowledge_structure" else "exam/review map"
    title_json = json.dumps(title, ensure_ascii=False)
    system_prompt = f"""
You are preparing a high-quality {mode_label} from the uploaded document.

Do not output the final mindmap yet.
First extract a compact document outline that captures the real semantic structure of the document.

Return JSON only. No prose, no markdown, no comments.

Use exactly this shape:
{{
  "title": {title_json},
  "mode": {json.dumps(mode)},
  "documentSummary": "high-level synthesis of the document",
  "topics": [
    {{
      "topic": "top-level topic",
      "summary": "why this topic matters",
      "subtopics": [
        {{
          "topic": "refined subtopic",
          "summary": "what this subtopic covers",
          "evidenceHints": ["page 2", "question 4"]
        }}
      ]
    }}
  ]
}}

Rules:
1. Topics must be semantic topics, not page labels or snippets.
2. Prefer 4 to 8 top-level topics when the source supports it.
3. Keep the outline compact and merge overlapping ideas.
4. If mode is exam_review, bias topics toward tested themes, methods, and traps.
5. If mode is knowledge_structure, bias topics toward concepts, principles, and hierarchy.
6. Do not output ids, database fields, or questionRefs.
7. Source metadata: source_type={json.dumps(source_type)}, source_id={source_id}
""".strip()
    return [
        {"role": "system", "content": system_prompt},
        {"role": "system", "content": f"fileid://{bailian_file_id}"},
        {"role": "user", "content": "Read the uploaded document and extract the outline now."},
    ]


def build_expand_messages(
    *,
    title: str,
    outline: DocOutline,
    source_type: str,
    source_id: int,
    has_question_refs: bool,
    mode: MindMapMode,
    node_budget: int | None = None,
    retry_feedback: str | None = None,
) -> list[dict[str, str]]:
    title_json = json.dumps(title, ensure_ascii=False)
    outline_json = json.dumps(outline.model_dump(mode="json"), ensure_ascii=False, indent=2)
    mode_instructions = (
        "Focus on concepts, principles, and hierarchy. Avoid question-style wording."
        if mode == "knowledge_structure"
        else "Focus on exam themes, methods, common traps, and high-yield review structure."
    )
    node_budget_rule = (
        f"Keep the final tree within approximately {node_budget} total nodes unless the source is clearly smaller."
        if node_budget and node_budget > 0
        else "Keep the final tree between 12 and 36 nodes when the material supports it."
    )
    retry_rule = f"11. Fix these specific quality issues from the previous attempt: {retry_feedback}" if retry_feedback else None
    system_prompt = f"""
You are an expert at expanding a compact outline into a high-quality semantic mindmap.

You are not reading the original source directly in this step. You are expanding from the validated outline below.

Return JSON that strictly matches the requested schema. No prose, no markdown, no comments.

Return a semantic draft, not the final storage schema.
Use exactly this shape:
{{
  "title": {title_json},
  "root": {{
    "topic": "the central idea of the material",
    "summary": "a short high-level synthesis",
    "referenceHints": [],
    "children": [
      {{
        "topic": "an abstract branch topic",
        "summary": "what this branch means",
        "side": "left",
        "referenceHints": ["Question 17 part 1", "page 2 vector problem"],
        "children": [
          {{
            "topic": "a refined subtopic",
            "summary": "why it matters",
            "referenceHints": [],
            "children": []
          }}
        ]
      }}
    ]
  }}
}}

Rules:
1. Use the outline as the source of truth. Do not invent major topics not supported by it.
2. The number of first-level branches under root must equal the number of outline topics.
3. The i-th outline topic must map to the i-th first-level branch. Preserve order.
4. Every outline subtopic must appear exactly once under its parent branch. Do not merge distinct subtopics together.
5. Each mapped subtopic node must itself contain at least one child node when the subtopic can be refined; otherwise keep an empty children list and preserve the subtopic itself exactly.
6. {mode_instructions}
7. {node_budget_rule}
8. Each summary should add meaning, not repeat the topic.
9. Never output questionRefs, questionId, sequenceIndex, page, node ids, version fields, or database identifiers.
10. side may only be "left" or "right". Source metadata: source_type={json.dumps(source_type)}, source_id={source_id}, has_question_refs={json.dumps(has_question_refs)}
""".strip()
    if retry_rule:
        system_prompt += f"\n{retry_rule}"
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": outline_json},
    ]


def build_expand_response_format() -> dict[str, Any]:
    node_schema: dict[str, Any] = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "topic": {"type": "string"},
            "summary": {"type": ["string", "null"]},
            "side": {"type": ["string", "null"], "enum": ["left", "right", None]},
            "referenceHints": {
                "type": "array",
                "items": {"type": "string"},
            },
            "children": {
                "type": "array",
                "items": {"$ref": "#/$defs/node"},
            },
        },
        "required": ["topic", "summary", "side", "referenceHints", "children"],
    }
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "mindmap_expand_draft",
            "schema": {
                "type": "object",
                "additionalProperties": False,
                "$defs": {
                    "node": node_schema,
                },
                "properties": {
                    "title": {"type": ["string", "null"]},
                    "root": {"$ref": "#/$defs/node"},
                },
                "required": ["title", "root"],
            },
        },
    }


def build_outline_merge_messages(
    *,
    title: str,
    outlines: list[DocOutline],
    source_type: str,
    source_ids: list[int],
    mode: MindMapMode,
) -> list[dict[str, str]]:
    title_json = json.dumps(title, ensure_ascii=False)
    outlines_json = json.dumps([item.model_dump(mode="json") for item in outlines], ensure_ascii=False, indent=2)
    mode_instruction = (
        "Preserve conceptual hierarchy and merge overlapping concepts."
        if mode == "knowledge_structure"
        else "Preserve high-yield review structure, merge overlapping exam themes, methods, and traps."
    )
    system_prompt = f"""
You are merging multiple validated document outlines into one unified outline for a single mindmap.

Return JSON only. No prose, no markdown, no comments.

Use exactly this shape:
{{
  "title": {title_json},
  "mode": {json.dumps(mode)},
  "documentSummary": "high-level synthesis across the document set",
  "topics": [
    {{
      "topic": "merged top-level topic",
      "summary": "why it matters across the document set",
      "subtopics": [
        {{
          "topic": "merged subtopic",
          "summary": "what it covers",
          "evidenceHints": ["file 12", "file 18"]
        }}
      ]
    }}
  ]
}}

Rules:
1. Merge overlapping topics instead of stacking duplicates.
2. Keep top-level topics between 4 and 10 when supported by the source set.
3. Maintain consistent granularity within the same level.
4. {mode_instruction}
5. Do not output page labels, snippet labels, ids, or database fields.
6. Source metadata: source_type={json.dumps(source_type)}, source_ids={json.dumps(source_ids)}
""".strip()
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": outlines_json},
    ]


def build_quality_review_messages(
    *,
    title: str,
    outline: DocOutline,
    draft: MindMapDraft,
    mode: MindMapMode,
    source_count: int,
    node_budget: int,
    minimum_score: float,
) -> list[dict[str, str]]:
    payload = {
        "title": title,
        "mode": mode,
        "sourceCount": source_count,
        "nodeBudget": node_budget,
        "outline": outline.model_dump(mode="json"),
        "draft": draft.model_dump(mode="json"),
    }
    system_prompt = f"""
You are reviewing a generated mindmap draft for structural quality.

Return JSON only. No prose, no markdown, no comments.

Use exactly this shape:
{{
  "passed": true,
  "totalScore": 0.0,
  "coverageScore": 0.0,
  "duplicationScore": 0.0,
  "depthScore": 0.0,
  "granularityScore": 0.0,
  "modeAlignmentScore": 0.0,
  "issues": [
    {{
      "code": "short_machine_code",
      "severity": "medium",
      "message": "human-readable issue"
    }}
  ],
  "retryPrompt": "one concise instruction block for regenerating a better draft"
}}

Scoring rules:
1. Each score must be between 0 and 1.
2. totalScore must reflect the overall mindmap quality.
3. passed must be true only when totalScore >= {minimum_score} and there are no severe structural problems.
4. coverageScore evaluates whether the draft covers the main outline topics.
5. duplicationScore evaluates duplication and overlap across sibling branches.
6. depthScore evaluates whether the tree is sufficiently layered instead of flat.
7. granularityScore evaluates whether nodes at the same level have consistent abstraction.
8. modeAlignmentScore evaluates whether the draft matches mode={json.dumps(mode)}.
9. retryPrompt must be actionable and compact. If passed is true, retryPrompt may be null.
""".strip()
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False, indent=2)},
    ]


def parse_generated_draft(
    raw_text: str,
    *,
    fallback_title: str,
) -> MindMapDraft:
    data = json.loads(_extract_first_json_object(raw_text))
    if not isinstance(data, dict):
        raise ValueError("Mindmap draft JSON must be an object")
    data["title"] = str(data.get("title") or fallback_title)
    draft = MindMapDraft.model_validate(data)
    _normalize_draft_node(draft.root, side_hint=None)
    return draft


def parse_generated_outline(
    raw_text: str,
    *,
    fallback_title: str,
    fallback_mode: MindMapMode,
) -> DocOutline:
    data = json.loads(_extract_first_json_object(raw_text))
    if not isinstance(data, dict):
        raise ValueError("Mindmap outline JSON must be an object")
    data["title"] = str(data.get("title") or fallback_title)
    data["mode"] = data.get("mode") or fallback_mode
    outline = DocOutline.model_validate(data)
    for topic in outline.topics:
        topic.topic = _clean_text(topic.topic, limit=48)
        topic.summary = _clean_text(topic.summary, limit=220) or None
        normalized_subtopics = []
        for subtopic in topic.subtopics:
            subtopic.topic = _clean_text(subtopic.topic, limit=48)
            subtopic.summary = _clean_text(subtopic.summary, limit=220) or None
            subtopic.evidenceHints = [str(item).strip() for item in (subtopic.evidenceHints or []) if str(item).strip()]
            normalized_subtopics.append(subtopic)
        topic.subtopics = normalized_subtopics
    outline.documentSummary = _clean_text(outline.documentSummary, limit=220) or None
    return outline


def parse_quality_report(raw_text: str) -> QualityReport:
    data = json.loads(_extract_first_json_object(raw_text))
    if not isinstance(data, dict):
        raise ValueError("Mindmap quality report JSON must be an object")
    issues = data.get("issues")
    if isinstance(issues, list):
        normalized_issues: list[dict[str, Any]] = []
        for item in issues:
            if not isinstance(item, dict):
                continue
            cloned = dict(item)
            severity_raw = str(cloned.get("severity") or "medium").strip().lower()
            if severity_raw in {"severe", "critical"}:
                severity_raw = "high"
            elif severity_raw not in {"low", "medium", "high"}:
                severity_raw = "medium"
            cloned["severity"] = severity_raw
            normalized_issues.append(cloned)
        data["issues"] = normalized_issues
    report = QualityReport.model_validate(data)
    report.totalScore = max(0.0, min(1.0, float(report.totalScore)))
    report.coverageScore = max(0.0, min(1.0, float(report.coverageScore)))
    report.duplicationScore = max(0.0, min(1.0, float(report.duplicationScore)))
    report.depthScore = max(0.0, min(1.0, float(report.depthScore)))
    report.granularityScore = max(0.0, min(1.0, float(report.granularityScore)))
    report.modeAlignmentScore = max(0.0, min(1.0, float(report.modeAlignmentScore)))
    report.retryPrompt = _clean_text(report.retryPrompt, limit=320) or None
    return report


def evaluate_draft_hard_quality(
    *,
    outline: DocOutline,
    draft: MindMapDraft,
) -> QualityReport:
    issues: list[dict[str, Any]] = []
    outline_topics = list(outline.topics or [])
    branch_nodes = list(draft.root.children or [])

    coverage_score = 1.0
    duplication_score = 1.0
    depth_score = 1.0
    granularity_score = 1.0
    mode_alignment_score = 1.0

    if len(branch_nodes) != len(outline_topics):
        issues.append(
            {
                "code": "branch_count_mismatch",
                "severity": "high",
                "message": f"Branch count mismatch: outline={len(outline_topics)} draft={len(branch_nodes)}",
            }
        )
        coverage_score = min(coverage_score, 0.4)
        granularity_score = min(granularity_score, 0.6)

    for topic_index, outline_topic in enumerate(outline_topics):
        branch = branch_nodes[topic_index] if topic_index < len(branch_nodes) else None
        if branch is None:
            issues.append(
                {
                    "code": "missing_branch",
                    "severity": "high",
                    "message": f"Missing branch for outline topic '{outline_topic.topic}'",
                }
            )
            coverage_score = min(coverage_score, 0.3)
            continue
        if branch.topic != outline_topic.topic:
            issues.append(
                {
                    "code": "branch_topic_mismatch",
                    "severity": "high",
                    "message": f"Branch topic mismatch at index {topic_index}: expected '{outline_topic.topic}', got '{branch.topic}'",
                }
            )
            coverage_score = min(coverage_score, 0.5)
            granularity_score = min(granularity_score, 0.7)
        if branch.side not in ("left", "right"):
            issues.append(
                {
                    "code": "invalid_side",
                    "severity": "medium",
                    "message": f"Branch '{branch.topic}' is missing a valid side assignment",
                }
            )
            mode_alignment_score = min(mode_alignment_score, 0.8)
        if any(child.children for child in branch.children or []):
            issues.append(
                {
                    "code": "excessive_depth",
                    "severity": "high",
                    "message": f"Subtopics under '{branch.topic}' exceed the supported 2-level structure",
                }
            )
            depth_score = min(depth_score, 0.3)

        expected_subtopics = list(outline_topic.subtopics or [])
        actual_subtopics = list(branch.children or [])
        expected_names = [item.topic for item in expected_subtopics]
        actual_names = [item.topic for item in actual_subtopics]
        if actual_names != expected_names:
            missing = [name for name in expected_names if name not in actual_names]
            extra = [name for name in actual_names if name not in expected_names]
            if missing:
                issues.append(
                    {
                        "code": "missing_subtopics",
                        "severity": "high",
                        "message": f"Branch '{branch.topic}' is missing subtopics: {', '.join(missing)}",
                    }
                )
                coverage_score = min(coverage_score, 0.5)
            if extra:
                issues.append(
                    {
                        "code": "extra_subtopics",
                        "severity": "medium",
                        "message": f"Branch '{branch.topic}' has unexpected subtopics: {', '.join(extra)}",
                    }
                )
                duplication_score = min(duplication_score, 0.7)
        if len(actual_names) != len(set(actual_names)):
            issues.append(
                {
                    "code": "duplicate_subtopics",
                    "severity": "high",
                    "message": f"Branch '{branch.topic}' contains duplicate subtopic nodes",
                }
            )
            duplication_score = min(duplication_score, 0.3)
        for subtopic_index, outline_subtopic in enumerate(expected_subtopics):
            if subtopic_index >= len(actual_subtopics):
                break
            subtopic_node = actual_subtopics[subtopic_index]
            if subtopic_node.topic != outline_subtopic.topic:
                granularity_score = min(granularity_score, 0.6)
            if subtopic_node.children:
                issues.append(
                    {
                        "code": "subtopic_depth_violation",
                        "severity": "high",
                        "message": f"Subtopic '{subtopic_node.topic}' should not have nested children",
                    }
                )
                depth_score = min(depth_score, 0.2)
            if not (subtopic_node.summary or "").strip():
                issues.append(
                    {
                        "code": "missing_subtopic_summary",
                        "severity": "medium",
                        "message": f"Subtopic '{subtopic_node.topic}' is missing summary content",
                    }
                )
                granularity_score = min(granularity_score, 0.7)

    total_score = round(
        (coverage_score * 0.35)
        + (duplication_score * 0.2)
        + (depth_score * 0.2)
        + (granularity_score * 0.15)
        + (mode_alignment_score * 0.1),
        3,
    )
    retry_messages = [item["message"] for item in issues[:3]]
    return QualityReport.model_validate(
        {
            "passed": not any(item["severity"] == "high" for item in issues),
            "totalScore": total_score,
            "coverageScore": coverage_score,
            "duplicationScore": duplication_score,
            "depthScore": depth_score,
            "granularityScore": granularity_score,
            "modeAlignmentScore": mode_alignment_score,
            "issues": issues,
            "retryPrompt": " ; ".join(retry_messages) if retry_messages else None,
        }
    )


def _normalize_draft_node(node: MindMapDraftNode, *, side_hint: str | None) -> None:
    node.topic = _clean_text(node.topic or "Untitled Topic", limit=48)
    node.summary = _clean_text(node.summary, limit=220) or None
    if side_hint in ("left", "right"):
        node.side = side_hint
    elif node.side not in ("left", "right"):
        node.side = None

    node.referenceHints = [str(item).strip() for item in (node.referenceHints or []) if str(item).strip()]
    normalized_children: list[MindMapDraftNode] = []
    for index, child in enumerate(node.children or []):
        child_side = child.side if child.side in ("left", "right") else (_branch_side(index) if node.side is None else None)
        _normalize_draft_node(child, side_hint=child_side)
        normalized_children.append(child)
    node.children = normalized_children


def align_draft_to_outline(
    *,
    title: str,
    outline: DocOutline,
    draft: MindMapDraft,
) -> MindMapDraft:
    root_topic = _clean_text(title.rsplit(".", 1)[0], limit=48) or _clean_text(title, limit=48) or "知识结构图"
    root_summary = _clean_text(outline.documentSummary or draft.root.summary, limit=220) or None
    root = MindMapDraftNode(
        topic=root_topic,
        summary=root_summary,
        referenceHints=[],
        children=[],
    )

    generated_branches = list(draft.root.children or [])
    for topic_index, outline_topic in enumerate(outline.topics or []):
        generated_branch = generated_branches[topic_index] if topic_index < len(generated_branches) else None
        branch_summary = _clean_text(outline_topic.summary or (generated_branch.summary if generated_branch else None), limit=220) or None
        branch_refs = list(generated_branch.referenceHints) if generated_branch else []
        branch = MindMapDraftNode(
            topic=outline_topic.topic,
            summary=branch_summary,
            side=_branch_side(topic_index),
            referenceHints=[str(item).strip() for item in branch_refs if str(item).strip()],
            children=[],
        )

        generated_subtopics = list(generated_branch.children or []) if generated_branch else []
        for subtopic_index, outline_subtopic in enumerate(outline_topic.subtopics or []):
            generated_subtopic = generated_subtopics[subtopic_index] if subtopic_index < len(generated_subtopics) else None
            merged_refs = []
            for item in list(outline_subtopic.evidenceHints or []) + list(generated_subtopic.referenceHints if generated_subtopic else []):
                text = str(item).strip()
                if text and text not in merged_refs:
                    merged_refs.append(text)

            subtopic_node = MindMapDraftNode(
                topic=outline_subtopic.topic,
                summary=_clean_text(outline_subtopic.summary or (generated_subtopic.summary if generated_subtopic else None), limit=220) or None,
                referenceHints=merged_refs,
                children=[],
            )
            branch.children.append(subtopic_node)

        root.children.append(branch)

    aligned = MindMapDraft(title=draft.title or title, root=root)
    _normalize_draft_node(aligned.root, side_hint=None)
    aligned.root.side = None
    aligned.root.referenceHints = []
    return aligned


def build_document_from_draft(
    *,
    draft: MindMapDraft,
    title: str,
    source_type: str,
    source_id: int,
    source_ids: list[int] | None = None,
    source_signature: str | None = None,
    mode: MindMapMode = "knowledge_structure",
    questions: list[dict[str, Any]] | None = None,
) -> tuple[MindMapDocument, dict[str, int]]:
    now = datetime.utcnow().isoformat()
    binding_service = ReferenceBindingService(questions=questions or [])
    stats = {
        "node_count": 0,
        "hinted_nodes": 0,
        "bound_ref_count": 0,
        "unresolved_hint_count": 0,
    }

    def build_node(node: MindMapDraftNode) -> dict[str, Any]:
        stats["node_count"] += 1
        if node.referenceHints:
            stats["hinted_nodes"] += 1
        bound_refs, unresolved_count = binding_service.bind(node.referenceHints or [])
        stats["bound_ref_count"] += len(bound_refs)
        stats["unresolved_hint_count"] += unresolved_count
        children = [build_node(child) for child in (node.children or [])]
        return {
            "id": _node_id("node"),
            "topic": _clean_text(node.topic, limit=48),
            "summary": _clean_text(node.summary, limit=220) or None,
            "side": node.side if node.side in ("left", "right") else None,
            "questionRefs": bound_refs,
            "children": children,
        }

    root_node = build_node(draft.root)
    payload = {
        "id": 0,
        "version": 1,
        "source": {"type": source_type, "id": source_id, "ids": list(source_ids or []), "signature": source_signature},
        "kind": "knowledge",
        "title": draft.title or title,
        "root": root_node,
        "relations": [],
        "meta": {
            "hasQuestionRefs": _tree_has_question_refs(root_node),
            "generatedBy": "llm",
            "mode": mode,
            "updatedAt": now,
        },
    }
    return MindMapDocument.model_validate(payload), stats


def _tree_has_question_refs(node: dict[str, Any]) -> bool:
    refs = node.get("questionRefs")
    if isinstance(refs, list) and refs:
        return True
    for child in node.get("children") or []:
        if isinstance(child, dict) and _tree_has_question_refs(child):
            return True
    return False
