"""Reset a document's OCR artifacts (cache + questions) for convenient re-tests.

Usage:
    python scripts/reset_document_ocr.py --document 590 --drop-questions

By default it only clears OCR cache (Document + FileOcrCache). Pass --drop-questions to
also delete existing Question rows for that document.
"""

from __future__ import annotations

import argparse
import pathlib
import sys
from typing import Optional

BASE_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from app.db import SessionLocal  # type: ignore  # pylint: disable=wrong-import-position
from app.models import Document, FileOcrCache, Question  # type: ignore  # pylint: disable=wrong-import-position


def reset_document(document_id: int, drop_questions: bool) -> None:
    session = SessionLocal()
    try:
        document: Optional[Document] = session.query(Document).filter(Document.id == document_id).first()
        if document is None:
            raise SystemExit(f"Document {document_id} 不存在")

        file_id = document.file_id
        tenant_id = document.tenant_id

        document.ocr_md_cache = None
        document.ocr_layout_cache = None
        document.ocr_cache_generated_at = None
        document.ocr_cache_model = None
        session.add(document)

        removed_cache_entries = 0
        if file_id is not None:
            caches = (
                session.query(FileOcrCache)
                .filter(
                    FileOcrCache.file_id == file_id,
                    FileOcrCache.tenant_id == tenant_id,
                )
                .all()
            )
            for cache_entry in caches:
                session.delete(cache_entry)
            removed_cache_entries = len(caches)

        removed_questions = 0
        if drop_questions:
            removed_questions = (
                session.query(Question)
                .filter(Question.document_id == document_id)
                .delete(synchronize_session=False)
            )

        session.commit()
        print(
            f"[reset] document={document_id} tenant={tenant_id} cache_entries={removed_cache_entries} "
            f"questions_removed={removed_questions}"
        )
    finally:
        session.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Reset OCR cache/questions for a document")
    parser.add_argument("--document", type=int, required=True, help="目标 Document ID")
    parser.add_argument(
        "--drop-questions",
        action="store_true",
        help="额外删除该 Document 已生成的 Question 记录",
    )
    args = parser.parse_args()

    reset_document(args.document, args.drop_questions)


if __name__ == "__main__":
    main()
