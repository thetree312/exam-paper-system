from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.services.mindmap.binding import ReferenceBindingService
from app.services.mindmap.generation import (
    build_document_from_blocks,
    build_document_from_draft,
    build_document_from_questions,
    parse_generated_draft,
    render_block_source,
    render_question_source,
)
from app.services.mindmap.service import MindMapService


def test_build_document_from_questions_groups_by_page_and_creates_refs() -> None:
    doc = build_document_from_questions(
        title="Algebra Notes",
        source_type="exam_document",
        source_id=8,
        questions=[
            {
                "id": 11,
                "sequence_index": 0,
                "page": 1,
                "content": "Solve x + 1 = 2.",
            },
            {
                "id": 12,
                "sequence_index": 1,
                "page": 1,
                "content": "Factor x^2 - 1.",
            },
            {
                "id": 13,
                "sequence_index": 2,
                "page": 2,
                "content": "Find the parabola vertex.",
            },
        ],
    )

    assert doc["source"]["type"] == "exam_document"
    assert doc["source"]["id"] == 8
    assert doc["meta"]["hasQuestionRefs"] is True
    assert doc["root"]["topic"] == "Algebra Notes"
    assert len(doc["root"]["children"]) == 2
    assert doc["root"]["children"][0]["topic"] == "Page 1"
    assert doc["root"]["children"][1]["topic"] == "Page 2"

    question_node = doc["root"]["children"][0]["children"][0]
    assert question_node["questionRefs"] == [{"questionId": 11, "sequenceIndex": 0, "page": 1}]
    assert question_node["children"] == []


def test_build_document_from_blocks_creates_side_branches_without_question_refs() -> None:
    doc = build_document_from_blocks(
        title="Physics Source",
        source_type="uploaded_file",
        source_id=15,
        blocks=[
            {"page": 1, "text": "Kinematics formulas and velocity concepts."},
            {"page": 1, "text": "Acceleration examples and graph reading."},
            {"page": 2, "text": "Newton laws and force decomposition."},
        ],
    )

    assert doc["source"]["type"] == "uploaded_file"
    assert doc["source"]["id"] == 15
    assert doc["meta"]["hasQuestionRefs"] is False
    assert len(doc["root"]["children"]) == 2
    assert doc["root"]["children"][0]["children"][0]["summary"] == "Kinematics formulas and velocity concepts."
    assert doc["root"]["children"][0]["side"] in ("left", "right")


def test_render_question_source_contains_question_metadata() -> None:
    source = render_question_source(
        "Algebra Notes",
        [
            {"id": 11, "sequence_index": 0, "page": 1, "content": "Solve x + 1 = 2."},
        ],
    )
    assert "Algebra Notes" in source
    assert "Q1" in source
    assert "page=1" in source


def test_parse_generated_draft_normalizes_tree_shape() -> None:
    raw = """
    ```json
    {
      "root": {
        "topic": "圆锥曲线",
        "children": [
          {
            "topic": "核心模型",
            "summary": "统一几何与代数表达",
            "children": []
          }
        ]
      }
    }
    ```
    """
    draft = parse_generated_draft(
        raw,
        fallback_title="数学专题",
    )
    assert draft.title == "数学专题"
    assert draft.root.topic == "圆锥曲线"
    assert draft.root.children[0].topic == "核心模型"
    assert draft.root.children[0].children == []


def test_reference_binding_service_resolves_sequence_and_page_hints() -> None:
    binder = ReferenceBindingService(
        questions=[
            {
                "id": 101,
                "sequence_index": 6,
                "page": 2,
                "content": "Vector wind-speed problem about direction and magnitude.",
            },
            {
                "id": 102,
                "sequence_index": 16,
                "page": 5,
                "content": "Derivative application and monotonicity proof.",
            },
        ]
    )

    refs, unresolved = binder.bind(["Question 17 part 1", "page 2 vector wind-speed problem"])

    assert unresolved == 0
    assert refs == [
        {"questionId": 102, "sequenceIndex": 16, "page": 5},
        {"questionId": 101, "sequenceIndex": 6, "page": 2},
    ]


def test_build_document_from_draft_binds_reference_hints_into_canonical_refs() -> None:
    draft = parse_generated_draft(
        """
        {
          "title": "全国卷数学",
          "root": {
            "topic": "高考数学核心知识体系",
            "summary": "围绕函数、几何、概率与代数的综合结构",
            "children": [
              {
                "topic": "导数应用",
                "summary": "借助导数研究单调性与最值",
                "referenceHints": ["Question 17 part 1"],
                "children": []
              }
            ]
          }
        }
        """,
        fallback_title="全国卷数学",
    )

    document, stats = build_document_from_draft(
        draft=draft,
        title="全国卷数学",
        source_type="exam_document",
        source_id=9,
        questions=[
            {
                "id": 201,
                "sequence_index": 16,
                "page": 5,
                "content": "Use derivatives to analyze monotonicity and extrema.",
            }
        ],
    )

    assert document.meta.generatedBy == "llm"
    assert document.meta.hasQuestionRefs is True
    assert document.root.children[0].questionRefs[0].questionId == 201
    assert stats["bound_ref_count"] == 1
    assert stats["unresolved_hint_count"] == 0


def test_render_block_source_groups_by_page() -> None:
    source = render_block_source(
        "Physics Notes",
        [
            {"page": 1, "text": "Kinematics formulas."},
            {"page": 2, "text": "Momentum conservation."},
        ],
    )

    assert "Physics Notes" in source
    assert "## Page 1" in source
    assert "Momentum conservation." in source


def test_uploaded_file_source_uses_file_generation_path_only() -> None:
    service = MindMapService(MagicMock())
    service.repo = MagicMock()
    service.repo.get_file.return_value = SimpleNamespace(id=15, original_name="source.pdf")
    service.repo.list_file_blocks.return_value = []
    payload = build_document_from_blocks(
        title="source.pdf",
        source_type="uploaded_file",
        source_id=15,
        blocks=[],
    )
    payload["meta"]["generatedBy"] = "llm"
    service._generate_with_llm_from_file = MagicMock(return_value=payload)
    service._generate_with_llm = MagicMock(side_effect=AssertionError("text fallback should not run"))

    document = service._build_from_source(tenant_id=9, source_type="uploaded_file", source_id=15)

    assert document.meta.generatedBy == "llm"
    service._generate_with_llm_from_file.assert_called_once()
    service._generate_with_llm.assert_not_called()


def test_uploaded_file_generation_failure_is_raised_instead_of_hidden() -> None:
    service = MindMapService(MagicMock())
    service.repo = MagicMock()
    service.repo.get_file.return_value = SimpleNamespace(id=15, original_name="source.pdf")
    service.repo.list_file_blocks.return_value = []
    service._generate_with_llm_from_file = MagicMock(
        side_effect=HTTPException(status_code=502, detail="Mindmap generation from uploaded file failed")
    )
    service._generate_with_llm = MagicMock(side_effect=AssertionError("text fallback should not run"))

    with pytest.raises(HTTPException) as exc_info:
        service._build_from_source(tenant_id=9, source_type="uploaded_file", source_id=15)

    assert exc_info.value.status_code == 502
    service._generate_with_llm.assert_not_called()


def test_generate_with_llm_executes_text_path_for_non_empty_source() -> None:
    service = MindMapService(MagicMock())
    service._persist_debug_artifact = MagicMock()
    reply = """
    {
      "title": "Algebra Notes",
      "root": {
        "topic": "Algebra Core Structure",
        "summary": "A compact map of equations and functions.",
        "children": [
          {
            "topic": "Equations",
            "summary": "Solving linear equations and transformations.",
            "children": []
          }
        ]
      }
    }
    """
    mock_client = MagicMock()
    mock_client.chat.return_value = (reply, 123)

    with patch("app.services.mindmap.service.QwenClient", return_value=mock_client):
        payload = service._generate_with_llm(
            title="Algebra Notes",
            source_type="exam_document",
            source_id=8,
            source_text="Question material: Solve x + 1 = 2.",
            has_question_refs=False,
            questions=[],
        )

    assert payload is not None
    assert payload["meta"]["generatedBy"] == "llm"
    assert payload["root"]["topic"] == "Algebra Core Structure"
    mock_client.chat.assert_called_once()
