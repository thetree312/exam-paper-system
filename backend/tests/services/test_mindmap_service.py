from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi import HTTPException

from app.services.mindmap.generation import (
    align_draft_to_outline,
    build_document_from_draft,
    build_expand_messages,
    build_expand_response_format,
    build_outline_generation_messages,
    evaluate_draft_hard_quality,
    parse_generated_draft,
    parse_generated_outline,
    parse_quality_report,
    render_block_source,
    render_question_source,
)
from app.services.mindmap.schemas import MindMapDocument
from app.services.mindmap.service import MindMapService
from app.services.bailian_file_service import BailianFileService
from app.services.qwen_client import QwenRequestError


def test_render_question_source_contains_question_metadata() -> None:
    source = render_question_source(
        "Algebra Notes",
        [{"id": 11, "sequence_index": 0, "page": 1, "content": "Solve x + 1 = 2."}],
    )
    assert "Algebra Notes" in source
    assert "Q1" in source
    assert "page=1" in source


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


def test_parse_generated_outline_normalizes_shape() -> None:
    raw = """
    {
      "title": "Physics Notes",
      "mode": "exam_review",
      "documentSummary": "A review-oriented physics outline.",
      "topics": [
        {
          "topic": "Mechanics",
          "summary": "Core mechanics themes",
          "subtopics": [
            {
              "topic": "Force Analysis",
              "summary": "Force decomposition and equilibrium",
              "evidenceHints": ["page 2", "question 4"]
            }
          ]
        }
      ]
    }
    """
    outline = parse_generated_outline(raw, fallback_title="Fallback", fallback_mode="knowledge_structure")
    assert outline.title == "Physics Notes"
    assert outline.mode == "exam_review"
    assert outline.topics[0].subtopics[0].evidenceHints == ["page 2", "question 4"]


def test_outline_messages_include_mode_specific_instruction() -> None:
    messages = build_outline_generation_messages(
        title="Physics Notes",
        source_text="Some source text",
        source_type="exam_document",
        source_id=1,
        mode="exam_review",
    )
    assert "exam/review map" in messages[0]["content"]
    assert '"mode": "exam_review"' in messages[0]["content"]


def test_expand_messages_include_budget_and_retry_feedback() -> None:
    outline = parse_generated_outline(
        """
        {
          "title": "Physics Notes",
          "mode": "knowledge_structure",
          "documentSummary": "Physics structure",
          "topics": [{"topic": "Mechanics", "summary": "Core mechanics", "subtopics": []}]
        }
        """,
        fallback_title="Fallback",
        fallback_mode="knowledge_structure",
    )
    messages = build_expand_messages(
        title="Physics Notes",
        outline=outline,
        source_type="uploaded_file",
        source_id=8,
        has_question_refs=False,
        mode="knowledge_structure",
        node_budget=72,
        retry_feedback="Improve sibling node consistency.",
    )
    assert "Physics Notes" in messages[1]["content"]
    assert "Mechanics" in messages[1]["content"]
    assert "approximately 72 total nodes" in messages[0]["content"]
    assert "Improve sibling node consistency." in messages[0]["content"]
    assert "The i-th outline topic must map to the i-th first-level branch." in messages[0]["content"]
    assert "Every outline subtopic must appear exactly once under its parent branch." in messages[0]["content"]


def test_expand_response_format_uses_json_schema() -> None:
    response_format = build_expand_response_format()
    assert response_format["type"] == "json_schema"
    schema = response_format["json_schema"]["schema"]
    assert schema["type"] == "object"
    assert schema["properties"]["root"]["$ref"] == "#/$defs/node"
    assert schema["$defs"]["node"]["properties"]["children"]["items"]["$ref"] == "#/$defs/node"


def test_parse_quality_report_clamps_scores() -> None:
    report = parse_quality_report(
        """
        {
          "passed": false,
          "totalScore": 1.4,
          "coverageScore": -0.1,
          "duplicationScore": 0.8,
          "depthScore": 0.9,
          "granularityScore": 1.2,
          "modeAlignmentScore": 0.7,
          "issues": [{"code": "flat_tree", "severity": "high", "message": "Too flat"}],
          "retryPrompt": "Make the draft more layered."
        }
        """
    )
    assert report.totalScore == 1.0
    assert report.coverageScore == 0.0
    assert report.granularityScore == 1.0
    assert report.issues[0].code == "flat_tree"


def test_parse_quality_report_normalizes_nonstandard_severity_labels() -> None:
    report = parse_quality_report(
        """
        {
          "passed": false,
          "totalScore": 0.7,
          "coverageScore": 0.8,
          "duplicationScore": 0.7,
          "depthScore": 0.6,
          "granularityScore": 0.7,
          "modeAlignmentScore": 0.9,
          "issues": [
            {"code": "depth", "severity": "severe", "message": "Too shallow"},
            {"code": "other", "severity": "critical", "message": "Bad"},
            {"code": "misc", "severity": "unexpected", "message": "Fallback"}
          ],
          "retryPrompt": "Add more depth."
        }
        """
    )
    assert report.issues[0].severity == "high"
    assert report.issues[1].severity == "high"
    assert report.issues[2].severity == "medium"


def test_build_document_from_draft_binds_mode_and_multi_source_metadata() -> None:
    draft = parse_generated_draft(
        """
        {
          "title": "Physics Set",
          "root": {
            "topic": "Physics Core",
            "summary": "Main concepts",
            "children": [
              {
                "topic": "Mechanics",
                "summary": "Force and motion",
                "children": []
              }
            ]
          }
        }
        """,
        fallback_title="Physics Set",
    )
    document, stats = build_document_from_draft(
        draft=draft,
        title="Physics Set",
        source_type="uploaded_file",
        source_id=0,
        source_ids=[10, 11, 12],
        source_signature="uploaded_file:10,11,12",
        mode="exam_review",
        questions=[],
    )
    assert document.meta.generatedBy == "llm"
    assert document.meta.mode == "exam_review"
    assert document.source.ids == [10, 11, 12]
    assert document.source.signature == "uploaded_file:10,11,12"
    assert stats["node_count"] == 2


def test_align_draft_to_outline_locks_topic_and_subtopic_structure() -> None:
    outline = parse_generated_outline(
        """
        {
          "title": "Physics Notes",
          "mode": "knowledge_structure",
          "documentSummary": "Physics structure",
          "topics": [
            {
              "topic": "振动与波动",
              "summary": "波动结构",
              "subtopics": [
                {"topic": "受迫振动与共振", "summary": "共振条件", "evidenceHints": ["page 1"]},
                {"topic": "多普勒效应", "summary": "频率变化", "evidenceHints": ["page 1"]}
              ]
            }
          ]
        }
        """,
        fallback_title="Physics Notes",
        fallback_mode="knowledge_structure",
    )
    draft = parse_generated_draft(
        """
        {
          "title": "Physics Notes",
          "root": {
            "topic": "English Root",
            "summary": "English summary",
            "children": [
              {
                "topic": "Wave fundamentals",
                "summary": "Generated branch",
                "children": [
                  {"topic": "Resonance analysis", "summary": "Generated subtopic", "children": []},
                  {"topic": "Resonance applications", "summary": "Wrong split", "children": []}
                ]
              }
            ]
          }
        }
        """,
        fallback_title="Physics Notes",
    )

    aligned = align_draft_to_outline(title="Physics Notes.pdf", outline=outline, draft=draft)

    assert aligned.root.topic == "Physics Notes"
    assert [child.topic for child in aligned.root.children] == ["振动与波动"]
    assert [child.topic for child in aligned.root.children[0].children] == ["受迫振动与共振", "多普勒效应"]
    assert aligned.root.children[0].summary == "波动结构"
    assert aligned.root.children[0].children[0].summary == "共振条件"
    assert aligned.root.children[0].children[1].summary == "频率变化"
    assert len(aligned.root.children[0].children[0].children) == 0
    assert len(aligned.root.children[0].children[1].children) == 0


def test_evaluate_draft_hard_quality_passes_for_outline_locked_two_level_tree() -> None:
    outline = parse_generated_outline(
        """
        {
          "title": "Physics Notes",
          "mode": "knowledge_structure",
          "documentSummary": "Physics structure",
          "topics": [
            {
              "topic": "振动与波动",
              "summary": "波动结构",
              "subtopics": [
                {"topic": "受迫振动与共振", "summary": "共振条件", "evidenceHints": ["page 1"]},
                {"topic": "多普勒效应", "summary": "频率变化", "evidenceHints": ["page 1"]}
              ]
            }
          ]
        }
        """,
        fallback_title="Physics Notes",
        fallback_mode="knowledge_structure",
    )
    draft = align_draft_to_outline(
        title="Physics Notes.pdf",
        outline=outline,
        draft=parse_generated_draft(
            """
            {
              "title": "Physics Notes",
              "root": {
                "topic": "Physics Notes",
                "summary": "Physics structure",
                "children": [
                  {
                    "topic": "振动与波动",
                    "summary": "波动结构",
                    "children": [
                      {"topic": "受迫振动与共振", "summary": "共振条件", "children": []},
                      {"topic": "多普勒效应", "summary": "频率变化", "children": []}
                    ]
                  }
                ]
              }
            }
            """,
            fallback_title="Physics Notes",
        ),
    )
    report = evaluate_draft_hard_quality(outline=outline, draft=draft)
    assert report.passed is True
    assert report.coverageScore == 1.0
    assert report.depthScore == 1.0
    assert not report.issues


def test_expand_generation_uses_local_alignment_without_runtime_quality_review() -> None:
    service = MindMapService(MagicMock())
    service._persist_debug_artifact = MagicMock()
    outline = parse_generated_outline(
        """
        {
          "title": "Physics Notes",
          "mode": "knowledge_structure",
          "documentSummary": "Physics structure",
          "topics": [
            {
              "topic": "振动与波动",
              "summary": "波动结构",
              "subtopics": [
                {"topic": "受迫振动与共振", "summary": "共振条件", "evidenceHints": ["page 1"]}
              ]
            }
          ]
        }
        """,
        fallback_title="Physics Notes",
        fallback_mode="knowledge_structure",
    )
    invalid_draft_reply = """
        {
          "title": "Physics Notes",
          "root": {
            "topic": "Physics Notes",
            "summary": "Physics structure",
            "children": [
              {
                "topic": "振动与波动",
                "summary": "波动结构",
                "children": [
                  {
                    "topic": "受迫振动与共振",
                    "summary": "共振条件",
                    "children": [
                      {"topic": "额外层级", "summary": "不应该存在", "children": []}
                    ]
                  }
                ]
              }
            ]
          }
        }
        """
    replies = iter([invalid_draft_reply])
    mock_client = MagicMock()
    mock_client.chat.side_effect = lambda *args, **kwargs: (next(replies), 123)

    with patch("app.services.mindmap.service.QwenClient", return_value=mock_client):
        payload = service._expand_outline_with_quality_gate(
            title="Physics Notes",
            outline=outline,
            source_type="exam_document",
            source_id=1,
            source_ids=[],
            source_signature=None,
            mode="knowledge_structure",
            has_question_refs=False,
            questions=[],
            source_count=1,
            expand_model="qwen-flash",
        )

    assert payload["root"]["children"][0]["topic"] == "振动与波动"
    assert payload["root"]["children"][0]["children"][0]["topic"] == "受迫振动与共振"
    assert payload["root"]["children"][0]["children"][0]["children"] == []
    assert mock_client.chat.call_count == 1


def test_generate_uses_mode_scoped_kind_and_source_signature() -> None:
    db = MagicMock()
    service = MindMapService(db)
    service.repo = MagicMock()
    service.repo.get_active_map.return_value = None
    generated = MindMapDocument.model_validate(
        {
            "id": 0,
            "version": 1,
            "source": {
                "type": "uploaded_file",
                "id": 0,
                "ids": [15, 16],
                "signature": "uploaded_file:15,16",
            },
            "kind": "knowledge",
            "title": "Merged Physics",
            "root": {
                "id": "node_root",
                "topic": "Physics",
                "summary": "Merged topics",
                "children": [],
            },
            "relations": [],
            "summaries": [],
            "meta": {
                "hasQuestionRefs": False,
                "generatedBy": "llm",
                "mode": "exam_review",
                "updatedAt": "2026-03-22T00:00:00",
            },
        }
    )
    service._build_from_source = MagicMock(return_value=generated)
    record = SimpleNamespace(id=88, version=3, graph_json=generated.model_dump(mode="json"))
    service.repo.create_map_version.return_value = record

    result = service.generate(
        tenant_id=2,
        user_id=9,
        workroom_id=22,
        source_type="uploaded_file",
        source_id=15,
        source_ids=[16, 15],
        kind="knowledge",
        mode="exam_review",
        force=True,
    )

    assert result.meta.mode == "exam_review"
    assert service.repo.create_map_version.call_args.kwargs["kind"] == "knowledge:exam_review"
    assert service.repo.create_map_version.call_args.kwargs["source_id"] == 0
    assert service.repo.create_map_version.call_args.kwargs["source_signature"] == "uploaded_file:15,16"


def test_single_document_two_stage_generation_uses_outline_expand_and_quality_gate() -> None:
    service = MindMapService(MagicMock())
    service._persist_debug_artifact = MagicMock()
    service.bailian_files = MagicMock()

    outline_reply = """
    {
      "title": "Physics Notes",
      "mode": "knowledge_structure",
      "documentSummary": "Physics structure",
      "topics": [
        {
          "topic": "Mechanics",
          "summary": "Core mechanics",
          "subtopics": [{"topic": "Dynamics", "summary": "Force and motion", "evidenceHints": ["page 2"]}]
        }
      ]
    }
    """
    draft_reply = """
    {
      "title": "Physics Notes",
      "root": {
        "topic": "Physics Knowledge Structure",
        "summary": "A compact map of physics concepts.",
        "children": [
          {
            "topic": "Mechanics",
            "summary": "Force, motion, and dynamics.",
            "children": [
              {
                "topic": "Dynamics",
                "summary": "How forces change motion.",
                "referenceHints": ["page 2"],
                "children": []
              }
            ]
          }
        ]
      }
    }
    """
    replies = iter([outline_reply, draft_reply])
    mock_client = MagicMock()
    mock_client.chat.side_effect = lambda *args, **kwargs: (next(replies), 123)

    with patch("app.services.mindmap.service.QwenClient", return_value=mock_client):
        payload = service._generate_two_stage_for_document(
            tenant_id=2,
            local_file_id=None,
            title="Physics Notes",
            source_type="exam_document",
            source_id=1,
            source_ids=[],
            source_signature=None,
            mode="knowledge_structure",
            source_text="Document title: Physics Notes",
            has_question_refs=False,
            questions=[],
            source_count=1,
        )

    assert payload["meta"]["generatedBy"] == "llm"
    assert payload["meta"]["mode"] == "knowledge_structure"
    assert payload["root"]["topic"] == "Physics Notes"
    assert mock_client.chat.call_count == 2
    expand_call_kwargs = mock_client.chat.call_args_list[1].kwargs
    assert expand_call_kwargs["temperature"] == 0.0
    assert expand_call_kwargs["top_p"] == 0.3
    assert expand_call_kwargs["response_format"]["type"] == "json_schema"


def test_uploaded_file_source_uses_two_stage_file_path_without_text_fallback() -> None:
    service = MindMapService(MagicMock())
    service.repo = MagicMock()
    service.repo.get_file.return_value = SimpleNamespace(id=15, original_name="source.pdf")
    service._generate_with_llm_from_file = MagicMock(
        return_value={
            "id": 0,
            "version": 1,
            "source": {"type": "uploaded_file", "id": 15, "ids": [], "signature": None},
            "kind": "knowledge",
            "title": "source.pdf",
            "root": {"id": "root", "topic": "Source", "summary": "Summary", "children": []},
            "relations": [],
            "summaries": [],
            "meta": {
                "hasQuestionRefs": False,
                "generatedBy": "llm",
                "mode": "knowledge_structure",
                "updatedAt": "2026-03-22T00:00:00",
            },
        }
    )

    document = service._build_from_source(
        tenant_id=9,
        source_type="uploaded_file",
        source_id=15,
        source_ids=[],
        source_signature=None,
        mode="knowledge_structure",
    )

    assert document.meta.generatedBy == "llm"
    service._generate_with_llm_from_file.assert_called_once()


def test_multi_file_generation_releases_remote_mapping_after_each_outline() -> None:
    service = MindMapService(MagicMock())
    service.repo = MagicMock()
    service.bailian_files = MagicMock()
    service._persist_debug_artifact = MagicMock()
    service._generate_outline_from_uploaded_file = MagicMock(
        side_effect=[
            (
                '{"title":"A.pdf","mode":"knowledge_structure","documentSummary":"A","topics":[{"topic":"Alpha","summary":"A","subtopics":[]}]}',
                parse_generated_outline(
                    '{"title":"A.pdf","mode":"knowledge_structure","documentSummary":"A","topics":[{"topic":"Alpha","summary":"A","subtopics":[]}]}',
                    fallback_title="A.pdf",
                    fallback_mode="knowledge_structure",
                ),
                {"local_file_id": 21, "bailian_file_id": "file-a"},
            ),
            (
                '{"title":"B.pdf","mode":"knowledge_structure","documentSummary":"B","topics":[{"topic":"Beta","summary":"B","subtopics":[]}]}',
                parse_generated_outline(
                    '{"title":"B.pdf","mode":"knowledge_structure","documentSummary":"B","topics":[{"topic":"Beta","summary":"B","subtopics":[]}]}',
                    fallback_title="B.pdf",
                    fallback_mode="knowledge_structure",
                ),
                {"local_file_id": 22, "bailian_file_id": "file-b"},
            ),
        ]
    )
    merged_outline = parse_generated_outline(
        '{"title":"A / B","mode":"knowledge_structure","documentSummary":"Merged","topics":[{"topic":"Unified","summary":"Merged","subtopics":[]}]}',
        fallback_title="A / B",
        fallback_mode="knowledge_structure",
    )
    service._merge_outline_batches = MagicMock(return_value=("A / B", merged_outline, [21, 22]))
    service._expand_outline_with_quality_gate = MagicMock(
        return_value={
            "id": 0,
            "version": 1,
            "source": {"type": "uploaded_file", "id": 0, "ids": [21, 22], "signature": "uploaded_file:21,22"},
            "kind": "knowledge",
            "title": "A / B",
            "root": {"id": "root", "topic": "Unified Physics", "summary": "Merged structure", "children": []},
            "relations": [],
            "summaries": [],
            "meta": {
                "hasQuestionRefs": False,
                "generatedBy": "llm",
                "mode": "knowledge_structure",
                "updatedAt": "2026-03-22T00:00:00",
            },
        }
    )

    service.repo.get_file.side_effect = [
        SimpleNamespace(id=21, original_name="A.pdf"),
        SimpleNamespace(id=22, original_name="B.pdf"),
    ]

    payload = service._generate_multi_file_mindmap(
        tenant_id=2,
        file_ids=[21, 22],
        source_type="uploaded_file",
        source_signature="uploaded_file:21,22",
        mode="knowledge_structure",
    )

    assert payload["source"]["ids"] == [21, 22]
    assert payload["source"]["signature"] == "uploaded_file:21,22"
    assert service._generate_outline_from_uploaded_file.call_count == 2


def test_uploaded_file_outline_reuploads_when_remote_file_is_invalid() -> None:
    service = MindMapService(MagicMock())
    service.bailian_files = MagicMock()

    stale_mapping = SimpleNamespace(bailian_file_id="file-stale", deleted_at=None, status="active")
    fresh_mapping = SimpleNamespace(bailian_file_id="file-fresh", deleted_at=None, status="active")
    service.bailian_files.ensure_uploaded.return_value = stale_mapping
    service.bailian_files.reupload_mapping.return_value = fresh_mapping

    outline_reply = """
    {
      "title": "Physics Notes",
      "mode": "knowledge_structure",
      "documentSummary": "Physics structure",
      "topics": [{"topic": "Mechanics", "summary": "Core mechanics", "subtopics": []}]
    }
    """
    invalid_exc = QwenRequestError(
        "Qwen request failed: status=400, body=Invalid file",
        response_text='{"error":{"message":"Invalid file [id:file-stale]"}}',
    )
    service._chat_messages = MagicMock(side_effect=[invalid_exc, outline_reply])

    reply, outline, extra_fields = service._generate_outline_from_uploaded_file(
        tenant_id=2,
        local_file_id=1068,
        title="Physics Notes",
        source_type="uploaded_file",
        source_id=1068,
        mode="knowledge_structure",
    )

    assert "Physics Notes" in reply
    assert outline.topics[0].topic == "Mechanics"
    assert extra_fields["bailian_file_id"] == "file-fresh"
    service.bailian_files.reupload_mapping.assert_called_once_with(record=stale_mapping)
    service.bailian_files.release_mapping.assert_called_once_with(record=fresh_mapping, remote_delete=True)


def test_bailian_ensure_uploaded_reuses_deleted_mapping_for_same_file_and_hash() -> None:
    db = MagicMock()
    service = BailianFileService(db)
    local_file = SimpleNamespace(id=1068, tenant_id=2, storage_path="uploads/demo.pdf", content_hash="same-hash")
    deleted_mapping = SimpleNamespace(
        id=7,
        tenant_id=2,
        local_file_id=1068,
        provider="dashscope",
        purpose="file-extract",
        content_hash="same-hash",
        bailian_file_id="file-old",
        status="deleted",
        deleted_at="2026-03-22T00:00:00",
        error_message="old",
        uploaded_at=None,
        last_used_at=None,
        updated_at=None,
    )

    service._get_local_file = MagicMock(return_value=local_file)
    service._resolve_content_hash = MagicMock(return_value="same-hash")
    service.get_active_mapping = MagicMock(return_value=None)
    service.get_mapping_by_scope_hash = MagicMock(return_value=deleted_mapping)
    mock_client = MagicMock()
    mock_client.upload_file.return_value = {"id": "file-new"}
    service._client = mock_client
    service.resolve_absolute_path = MagicMock(return_value="D:/Exam-paper/backend/uploads/demo.pdf")

    record = service.ensure_uploaded(tenant_id=2, local_file_id=1068, purpose="file-extract")

    assert record is deleted_mapping
    assert record.bailian_file_id == "file-new"
    assert record.status == "active"
    assert record.deleted_at is None
    assert record.error_message is None
    mock_client.upload_file.assert_called_once()
    db.flush.assert_called()


def test_uploaded_file_generation_failure_is_raised_instead_of_hidden() -> None:
    service = MindMapService(MagicMock())
    service.repo = MagicMock()
    service.repo.get_file.return_value = SimpleNamespace(id=15, original_name="source.pdf")
    service._generate_with_llm_from_file = MagicMock(
        side_effect=HTTPException(status_code=502, detail="Mindmap generation from uploaded file failed")
    )

    try:
        service._build_from_source(
            tenant_id=9,
            source_type="uploaded_file",
            source_id=15,
            source_ids=[],
            source_signature=None,
            mode="knowledge_structure",
        )
        assert False, "Expected HTTPException"
    except HTTPException as exc:
        assert exc.status_code == 502
