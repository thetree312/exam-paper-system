"""List recent Document records for quick lookup.

Usage:
    python scripts/list_documents.py --tenant 2 --limit 10
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
from app.models import Document  # type: ignore  # pylint: disable=wrong-import-position


def list_documents(limit: int, tenant_id: Optional[int]) -> None:
    session = SessionLocal()
    try:
        query = session.query(Document).order_by(Document.id.desc())
        if tenant_id is not None:
            query = query.filter(Document.tenant_id == tenant_id)
        docs = query.limit(limit).all()

        if not docs:
            print("No documents found.")
            return

        for doc in docs:
            print(
                "id={id} tenant={tenant} file={file} session={session} title={title!r} created_at={created}".format(
                    id=doc.id,
                    tenant=doc.tenant_id,
                    file=doc.file_id,
                    session=doc.session_id,
                    title=doc.title or "",
                    created=doc.created_at,
                )
            )
    finally:
        session.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="List recent documents")
    parser.add_argument("--limit", type=int, default=10, help="Number of documents to show")
    parser.add_argument("--tenant", type=int, default=None, help="Filter by tenant id")
    args = parser.parse_args()

    list_documents(limit=args.limit, tenant_id=args.tenant)


if __name__ == "__main__":
    main()
