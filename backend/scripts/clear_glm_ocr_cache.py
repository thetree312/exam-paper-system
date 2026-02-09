"""Utility script to clear GLM-OCR caches for a specific document.

Usage:
    # 激活 backend 虚拟环境并设置 DATABASE_URL
    python scripts/clear_glm_ocr_cache.py --document 588
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
from app.models import Document, FileOcrCache  # type: ignore  # pylint: disable=wrong-import-position


def clear_glm_cache_for_document(document_id: int) -> None:
    session = SessionLocal()
    try:
        document: Optional[Document] = session.query(Document).filter(Document.id == document_id).first()
        if document is None:
            raise SystemExit(f"Document {document_id} 不存在")

        file_id = document.file_id
        tenant_id = document.tenant_id

        # 清空 Document 上的缓存字段
        document.ocr_md_cache = None
        document.ocr_layout_cache = None
        document.ocr_cache_generated_at = None
        document.ocr_cache_model = None
        session.add(document)

        if file_id is None:
            print(f"[clear] document {document_id} 未绑定 file，已清空 document 缓存字段")
            session.commit()
            return

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

        session.commit()
        print(
            f"[clear] document={document_id} file={file_id} tenant={tenant_id} "
            f"removed_cache_entries={len(caches)}"
        )
    finally:
        session.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Clear GLM-OCR cache for a document")
    parser.add_argument("--document", type=int, required=True, help="目标 Document ID")
    args = parser.parse_args()

    clear_glm_cache_for_document(args.document)


if __name__ == "__main__":
    main()
