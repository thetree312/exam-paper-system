"""Inspect canonical answers for a document's questions."""

from __future__ import annotations

import argparse
import pathlib
import sys

BASE_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from app.db import SessionLocal  # type: ignore  # pylint: disable=wrong-import-position
from app.models import Question  # type: ignore  # pylint: disable=wrong-import-position


def inspect(document_id: int) -> None:
    session = SessionLocal()
    try:
        qs = (
            session.query(Question)
            .filter(Question.document_id == document_id)
            .order_by(Question.sequence_index)
            .all()
        )
        if not qs:
            print(f"No questions found for document {document_id}")
            return

        filled = 0
        for q in qs:
            answer = (q.canonical_answer or "").strip()
            has_answer = bool(answer)
            if has_answer:
                filled += 1
            snippet = q.content[:60].replace("\n", " ") if q.content else ""
            print(
                f"#{q.sequence_index:02d} page={q.page} has_answer={has_answer} "
                f"answer='{(answer[:40] + ('…' if len(answer) > 40 else '')) if answer else ''}' "
                f"content='{snippet}'"
            )
        print(f"\nSummary: total={len(qs)} filled={filled} empty={len(qs) - filled}")
    finally:
        session.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Inspect question answers for a document")
    parser.add_argument("--document", type=int, required=True)
    args = parser.parse_args()
    inspect(args.document)


if __name__ == "__main__":
    main()
