from __future__ import annotations

from typing import Any

from .types import ToolDefinition
from .knowledge_evidence import tool_read_kb_evidence, tool_read_kb_snippets, tool_search_kb_candidates
from .studio_sources import tool_list_studio_sources
from .studio_environment import (
    tool_get_studio_resource_summary,
    tool_resolve_question_card_candidates,
    tool_read_studio_question_card,
)


def tool_definitions() -> list[ToolDefinition]:
    return [
        ToolDefinition(
            name="list_studio_sources",
            description="Inspect which objects currently exist in the center studio, including question cards, flashcards, and mindmap nodes.",
            parameters={"type": "object", "properties": {}, "additionalProperties": False},
            handler=tool_list_studio_sources,
        ),
        ToolDefinition(
            name="get_studio_resource_summary",
            description="Read a neutral summary of current studio objects and counts.",
            parameters={"type": "object", "properties": {}, "additionalProperties": False},
            handler=tool_get_studio_resource_summary,
        ),
        ToolDefinition(
            name="resolve_question_card_candidates",
            description="Locate possible studio question-card objects that may match the user's query.",
            parameters={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "top_k": {"type": "integer", "minimum": 1, "maximum": 10, "default": 3},
                },
                "required": ["query"],
                "additionalProperties": False,
            },
            handler=tool_resolve_question_card_candidates,
        ),
        ToolDefinition(
            name="read_studio_question_card",
            description="Read one already-identified studio question card by question_id or sequence_index.",
            parameters={
                "type": "object",
                "properties": {
                    "question_id": {"type": "integer", "minimum": 1},
                    "sequence_index": {"type": "integer", "minimum": 1},
                },
                "additionalProperties": False,
            },
            handler=tool_read_studio_question_card,
        ),
        ToolDefinition(
            name="read_kb_evidence",
            description="Read evidence objects from the knowledge base for the current query, including snippets and asset references.",
            parameters={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "top_k": {"type": "integer", "minimum": 1, "maximum": 6, "default": 3},
                },
                "required": ["query"],
                "additionalProperties": False,
            },
            handler=tool_read_kb_evidence,
        ),
        ToolDefinition(
            name="search_kb_candidates",
            description="Locate candidate knowledge-base references related to the current query without fully reading their content.",
            parameters={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "top_k": {"type": "integer", "minimum": 1, "maximum": 6, "default": 3},
                },
                "required": ["query"],
                "additionalProperties": False,
            },
            handler=tool_search_kb_candidates,
        ),
        ToolDefinition(
            name="read_kb_snippets",
            description="Read text snippets from already-located knowledge-base references or directly from a query.",
            parameters={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "source_refs": {"type": "array", "items": {"type": "string"}},
                    "candidate_refs": {"type": "array", "items": {"type": "string"}},
                    "top_k": {"type": "integer", "minimum": 1, "maximum": 6, "default": 3},
                },
                "additionalProperties": False,
            },
            handler=tool_read_kb_snippets,
        ),
    ]


def build_tool_schemas() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": td.name,
                "description": td.description,
                "parameters": td.parameters,
            },
        }
        for td in tool_definitions()
    ]


def execute_tool_call(name: str, arguments: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    for td in tool_definitions():
        if td.name == name:
            return td.handler(arguments, ctx)
    return {"error": "unknown_tool", "tool_name": name}
