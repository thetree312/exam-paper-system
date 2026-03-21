from __future__ import annotations

import json
from typing import Any


def test_resolve_questions_display_index_no_off_by_one(monkeypatch: Any) -> None:
    from app.agent.assistant_graph.nodes import question_tools

    class _Doc:
        workroom_id = 9

    class _Query:
        def filter(self, *_args: Any, **_kwargs: Any) -> "_Query":
            return self

        def first(self) -> _Doc:
            return _Doc()

    class _DB:
        def query(self, _model: Any) -> _Query:
            return _Query()

        def close(self) -> None:
            return None

    class _AgentSvc:
        def __init__(self, _db: Any) -> None:
            pass

        def get_question_catalog(
            self,
            *,
            tenant_id: int,
            document_id: int,
            limit: int,
            offset: int,
        ) -> dict:
            assert tenant_id == 2
            assert document_id == 725
            assert limit >= 1
            assert offset == 0
            return {
                "version": 1,
                "question_count": 1,
                "rows": [
                    {
                        "question_id": 101,
                        "sequence_index": 1,
                        "display_index": 1,
                        "content_preview": "Q1",
                    }
                ],
                "has_more": False,
            }

    class _QuestionSvc:
        def __init__(self, _db: Any) -> None:
            pass

        def get_question(self, *, tenant_id: int, question_id: int, include_legend: bool = True) -> dict:
            assert tenant_id == 2
            assert question_id == 101
            assert include_legend is True
            return {
                "id": 101,
                "sequence_index": 1,
                "page": 1,
                "content": "Q1",
                "legend_images": [],
            }

    class _VectorSvc:
        def get_similar_questions(self, **_kwargs: Any) -> list[int]:
            return []

    monkeypatch.setattr(question_tools, "SessionLocal", lambda: _DB())
    monkeypatch.setattr(question_tools, "AgentService", _AgentSvc)
    monkeypatch.setattr(question_tools, "QuestionService", _QuestionSvc)
    monkeypatch.setattr(question_tools, "QuestionVectorService", lambda: _VectorSvc())

    state = {
        "tenant_id": 2,
        "workroom_id": 9,
        "studio_document_id": 725,
        "snapshot_items": [],
        "question_index_map": {
            "display_to_id": {1: 101},
            "sequence_to_id": {1: 101},
        },
    }
    tool_calls = [
        {
            "id": "tc1",
            "function": {
                "name": "resolve_questions",
                "arguments": json.dumps({"display_indices": [1], "limit": 1}, ensure_ascii=False),
            },
        }
    ]

    msgs = question_tools.apply_question_retrieval_tool(state, tool_calls)
    assert msgs
    payload = json.loads(str(msgs[0].get("content") or "{}"))
    assert payload.get("resolved_question_ids") == [101]
    assert payload.get("primary_question_id") == 101
    delta = payload.get("state_delta") if isinstance(payload.get("state_delta"), dict) else {}
    assert delta.get("active_question_ids") == [101]
    questions = payload.get("questions") if isinstance(payload.get("questions"), list) else []
    assert questions and int(questions[0].get("id") or 0) == 101


def test_resolve_questions_prefers_display_index_as_primary_when_sequence_conflicts(monkeypatch: Any) -> None:
    from app.agent.assistant_graph.nodes import question_tools

    class _Doc:
        workroom_id = 9

    class _Query:
        def filter(self, *_args: Any, **_kwargs: Any) -> "_Query":
            return self

        def first(self) -> _Doc:
            return _Doc()

    class _DB:
        def query(self, _model: Any) -> _Query:
            return _Query()

        def close(self) -> None:
            return None

    class _AgentSvc:
        def __init__(self, _db: Any) -> None:
            pass

        def get_question_catalog(
            self,
            *,
            tenant_id: int,
            document_id: int,
            limit: int,
            offset: int,
        ) -> dict:
            assert tenant_id == 2
            assert document_id == 725
            assert limit >= 1
            assert offset == 0
            return {
                "version": 1,
                "question_count": 2,
                "rows": [
                    {"question_id": 3140, "sequence_index": 5, "display_index": 6, "content_preview": "Q6"},
                    {"question_id": 3141, "sequence_index": 6, "display_index": 7, "content_preview": "Q7"},
                ],
                "has_more": False,
            }

    class _QuestionSvc:
        def __init__(self, _db: Any) -> None:
            pass

        def get_question(self, *, tenant_id: int, question_id: int, include_legend: bool = True) -> dict:
            assert tenant_id == 2
            assert include_legend is True
            return {
                "id": question_id,
                "sequence_index": 5 if question_id == 3140 else 6,
                "page": 1,
                "content": f"Q{question_id}",
                "legend_images": [],
            }

    class _VectorSvc:
        def get_similar_questions(self, **_kwargs: Any) -> list[int]:
            return []

    monkeypatch.setattr(question_tools, "SessionLocal", lambda: _DB())
    monkeypatch.setattr(question_tools, "AgentService", _AgentSvc)
    monkeypatch.setattr(question_tools, "QuestionService", _QuestionSvc)
    monkeypatch.setattr(question_tools, "QuestionVectorService", lambda: _VectorSvc())

    state = {
        "tenant_id": 2,
        "workroom_id": 9,
        "studio_document_id": 725,
        "snapshot_items": [],
        "question_index_map": {
            "display_to_id": {6: 3140, 7: 3141},
            "sequence_to_id": {5: 3140, 6: 3141},
        },
    }
    tool_calls = [
        {
            "id": "tc1",
            "function": {
                "name": "resolve_questions",
                "arguments": json.dumps(
                    {"display_indices": [6], "sequence_indices": [6], "limit": 8},
                    ensure_ascii=False,
                ),
            },
        }
    ]

    msgs = question_tools.apply_question_retrieval_tool(state, tool_calls)
    payload = json.loads(str(msgs[0].get("content") or "{}"))
    assert payload.get("primary_question_id") == 3140
    assert payload.get("resolved_question_ids")[:2] == [3140, 3141]
    delta = payload.get("state_delta") if isinstance(payload.get("state_delta"), dict) else {}
    assert delta.get("active_question_ids") == [3140]


