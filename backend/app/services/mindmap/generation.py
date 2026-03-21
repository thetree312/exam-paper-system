from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any
from uuid import uuid4

from .binding import ReferenceBindingService
from .schemas import MindMapDocument, MindMapDraft, MindMapDraftNode


def _node_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:10]}"


def _clean_text(value: str | None, *, limit: int = 160) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(text) <= limit:
        return text
    return text[: limit - 3].rstrip() + "..."


def _page_topic(page: int | None) -> str:
    return f"Page {page}" if isinstance(page, int) and page > 0 else "Page Unknown"


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


def build_generation_messages(
    *,
    title: str,
    source_text: str,
    source_type: str,
    source_id: int,
    has_question_refs: bool,
) -> list[dict[str, str]]:
    title_json = json.dumps(title, ensure_ascii=False)
    source_type_json = json.dumps(source_type)
    system_prompt = f"""
You are an expert at building compact, concept-driven mindmaps from study material.

Your job is not to copy source text and not to group material mechanically by page.
Your job is to extract the core knowledge structure and express it as a readable semantic tree.

Return JSON only. No prose, no markdown, no comments.

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
1. The root and branch topics must be summarized concepts, not raw snippets.
2. Do not use placeholder names like "Snippet 1", "Page 1", "Paragraph 1", "Original text", or similar.
3. Prefer 4 to 8 first-level branches unless the material is clearly smaller.
4. Each summary should explain the concept briefly instead of repeating the topic.
5. If the source contains questions, you may use referenceHints as human-readable hints only.
6. Never output questionRefs, questionId, sequenceIndex, page, node ids, version fields, or database identifiers.
7. side may only be "left" or "right".
8. Keep the full tree between 12 and 36 nodes when the material supports it.
9. Source metadata: source_type={source_type_json}, source_id={source_id}, has_question_refs={json.dumps(has_question_refs)}
""".strip()
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": source_text},
    ]


def build_file_generation_messages(
    *,
    title: str,
    bailian_file_id: str,
    source_type: str,
    source_id: int,
    has_question_refs: bool,
) -> list[dict[str, str]]:
    title_json = json.dumps(title, ensure_ascii=False)
    source_type_json = json.dumps(source_type)
    system_prompt = f"""
You are an expert at building compact, concept-driven mindmaps from full documents.

Read the uploaded file and extract its real knowledge structure.
Do not summarize by page order unless the document itself is explicitly organized that way.

Return JSON only. No prose, no markdown, no comments.

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
1. The root and branch topics must be summarized concepts, not raw snippets.
2. Use enough depth to reflect the document structure; avoid a shallow one-level topic list when the source is rich.
3. Prefer 4 to 8 first-level branches unless the document is clearly smaller.
4. Each summary should explain the concept briefly instead of repeating the topic.
5. If the source contains questions, you may use referenceHints as human-readable hints only.
6. Never output questionRefs, questionId, sequenceIndex, page, node ids, version fields, or database identifiers.
7. side may only be "left" or "right".
8. Keep the full tree between 12 and 36 nodes when the material supports it.
9. Source metadata: source_type={source_type_json}, source_id={source_id}, has_question_refs={json.dumps(has_question_refs)}
""".strip()
    return [
        {"role": "system", "content": system_prompt},
        {"role": "system", "content": f"fileid://{bailian_file_id}"},
        {"role": "user", "content": "Read the uploaded document and generate the semantic mindmap draft now."},
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


def build_document_from_draft(
    *,
    draft: MindMapDraft,
    title: str,
    source_type: str,
    source_id: int,
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
        "source": {"type": source_type, "id": source_id},
        "kind": "knowledge",
        "title": draft.title or title,
        "root": root_node,
        "relations": [],
        "meta": {
            "hasQuestionRefs": _tree_has_question_refs(root_node),
            "generatedBy": "llm",
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


def build_document_from_questions(
    *,
    title: str,
    source_type: str,
    source_id: int,
    questions: list[dict[str, Any]],
) -> dict[str, Any]:
    root_id = _node_id("root")
    by_page: dict[int | None, list[dict[str, Any]]] = {}
    for question in questions:
        by_page.setdefault(question.get("page"), []).append(question)

    children: list[dict[str, Any]] = []
    for branch_index, page in enumerate(sorted(by_page.keys(), key=lambda value: (value is None, value or 0))):
        question_children: list[dict[str, Any]] = []
        for item in sorted(by_page[page], key=lambda q: (q.get("sequence_index") or 0, q.get("id") or 0)):
            sequence_index = item.get("sequence_index")
            question_children.append(
                {
                    "id": _node_id("question"),
                    "topic": f"Q{(sequence_index or 0) + 1}",
                    "summary": _clean_text(item.get("content")),
                    "questionRefs": [
                        {
                            "questionId": item.get("id"),
                            "sequenceIndex": sequence_index,
                            "page": item.get("page"),
                        }
                    ],
                    "children": [],
                }
            )

        children.append(
            {
                "id": _node_id("page"),
                "topic": _page_topic(page),
                "summary": f"{len(question_children)} question nodes",
                "side": _branch_side(branch_index),
                "questionRefs": [],
                "children": question_children,
            }
        )

    now = datetime.utcnow().isoformat()
    return {
        "id": 0,
        "version": 1,
        "source": {"type": source_type, "id": source_id},
        "kind": "knowledge",
        "title": title,
        "root": {
            "id": root_id,
            "topic": title or "Untitled Mindmap",
            "summary": f"{len(questions)} linked questions",
            "questionRefs": [],
            "children": children,
        },
        "relations": [],
        "meta": {
            "hasQuestionRefs": bool(questions),
            "generatedBy": "system",
            "updatedAt": now,
        },
    }


def build_document_from_blocks(
    *,
    title: str,
    source_type: str,
    source_id: int,
    blocks: list[dict[str, Any]],
) -> dict[str, Any]:
    root_id = _node_id("root")
    by_page: dict[int | None, list[dict[str, Any]]] = {}
    for block in blocks:
        text = _clean_text(block.get("text"), limit=220)
        if not text:
            continue
        by_page.setdefault(block.get("page"), []).append({"page": block.get("page"), "text": text})

    children: list[dict[str, Any]] = []
    for branch_index, page in enumerate(sorted(by_page.keys(), key=lambda value: (value is None, value or 0))):
        snippets = by_page[page][:8]
        page_children = [
            {
                "id": _node_id("snippet"),
                "topic": f"Snippet {snippet_index + 1}",
                "summary": snippet["text"],
                "questionRefs": [],
                "children": [],
            }
            for snippet_index, snippet in enumerate(snippets)
        ]
        children.append(
            {
                "id": _node_id("page"),
                "topic": _page_topic(page),
                "summary": f"{len(page_children)} source snippets",
                "side": _branch_side(branch_index),
                "questionRefs": [],
                "children": page_children,
            }
        )

    now = datetime.utcnow().isoformat()
    return {
        "id": 0,
        "version": 1,
        "source": {"type": source_type, "id": source_id},
        "kind": "knowledge",
        "title": title,
        "root": {
            "id": root_id,
            "topic": title or "Untitled Mindmap",
            "summary": f"{len(blocks)} source blocks",
            "questionRefs": [],
            "children": children,
        },
        "relations": [],
        "meta": {
            "hasQuestionRefs": False,
            "generatedBy": "system",
            "updatedAt": now,
        },
    }
