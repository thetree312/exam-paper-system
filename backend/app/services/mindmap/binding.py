from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


FULLWIDTH_TRANSLATION = str.maketrans(
    {
        "\uFF08": "(",
        "\uFF09": ")",
        "\u3010": "[",
        "\u3011": "]",
        "\uFF1A": ":",
        "\uFF0C": ",",
        "\u3002": ".",
        "\uFF1F": "?",
        "\uFF1B": ";",
        "\u201C": '"',
        "\u201D": '"',
        "\u2018": "'",
        "\u2019": "'",
        "\u7B2C": " ",
        "\u9898": " ",
        "\u95EE": " ",
        "\u9875": " ",
    }
)


def _normalize_hint(value: str) -> str:
    normalized = str(value or "").strip().lower().translate(FULLWIDTH_TRANSLATION)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized


def _tokenize(value: str) -> set[str]:
    normalized = _normalize_hint(value)
    tokens = set(re.findall(r"[a-z0-9]+|[\u4e00-\u9fff]+", normalized))
    expanded: set[str] = set(tokens)
    for token in list(tokens):
        if re.fullmatch(r"[\u4e00-\u9fff]{2,}", token):
            expanded.update(token[index : index + 2] for index in range(len(token) - 1))
    return {token for token in expanded if token}


def _extract_question_numbers(value: str) -> set[int]:
    normalized = _normalize_hint(value)
    return {int(match) for match in re.findall(r"\b(\d{1,3})\b", normalized)}


def _extract_page_numbers(value: str) -> set[int]:
    original = str(value or "")
    matches = re.findall(r"(?:page|p\.?|\u7B2C)\s*(\d{1,3})", original, flags=re.IGNORECASE)
    return {int(match) for match in matches}


@dataclass(frozen=True)
class QuestionCandidate:
    question_id: int | None
    sequence_index: int | None
    page: int | None
    content: str
    tokens: set[str]
    sequence_number: int | None


class ReferenceBindingService:
    def __init__(self, *, questions: list[dict[str, Any]]) -> None:
        self._questions = [self._build_candidate(item) for item in questions]

    @staticmethod
    def _build_candidate(question: dict[str, Any]) -> QuestionCandidate:
        content = str(question.get("content") or "").strip()
        sequence_index = question.get("sequence_index")
        sequence_number = sequence_index + 1 if isinstance(sequence_index, int) else None
        search_text = " ".join(
            part
            for part in [
                f"question {sequence_number}" if sequence_number is not None else "",
                f"page {question.get('page')}" if question.get("page") is not None else "",
                content,
            ]
            if part
        )
        return QuestionCandidate(
            question_id=question.get("id"),
            sequence_index=sequence_index,
            page=question.get("page"),
            content=content,
            tokens=_tokenize(search_text),
            sequence_number=sequence_number,
        )

    def bind(self, hints: list[str]) -> tuple[list[dict[str, Any]], int]:
        if not hints or not self._questions:
            return [], 0

        refs: list[dict[str, Any]] = []
        unresolved = 0
        seen: set[tuple[int | None, int | None, int | None]] = set()

        for hint in hints:
            match = self._resolve_hint(hint)
            if match is None:
                unresolved += 1
                continue
            key = (match.question_id, match.sequence_index, match.page)
            if key in seen:
                continue
            seen.add(key)
            refs.append(
                {
                    "questionId": match.question_id,
                    "sequenceIndex": match.sequence_index,
                    "page": match.page,
                }
            )
        return refs, unresolved

    def _resolve_hint(self, hint: str) -> QuestionCandidate | None:
        hint_tokens = _tokenize(hint)
        explicit_numbers = _extract_question_numbers(hint)
        page_numbers = _extract_page_numbers(hint)

        best_candidate: QuestionCandidate | None = None
        best_score = 0
        for candidate in self._questions:
            score = 0

            if candidate.sequence_number is not None and candidate.sequence_number in explicit_numbers:
                score += 10
            elif explicit_numbers:
                score -= 3

            if candidate.page is not None and candidate.page in page_numbers:
                score += 3

            if hint_tokens and candidate.tokens:
                overlap = len(hint_tokens & candidate.tokens)
                if overlap:
                    score += min(overlap, 6)

            if candidate.content and hint.strip() and candidate.content.lower() in hint.lower():
                score += 3

            if score > best_score:
                best_score = score
                best_candidate = candidate

        if best_candidate is None:
            return None
        if explicit_numbers and best_score < 10:
            return None
        if not explicit_numbers and best_score < 3:
            return None
        return best_candidate
