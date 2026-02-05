import logging
from typing import Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..models import Document, File, FulltextBlock


logger = logging.getLogger("agent.document_reader")


class DocumentReadTool:
    """Utility for fetching contextual text spans from a document's source file."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def read_span(
        self,
        *,
        tenant_id: int,
        document_id: Optional[int] = None,
        file_id: Optional[int] = None,
        block_index: Optional[int] = None,
        window: int = 2,
        char_limit: int = 2000,
    ) -> dict:
        """Return contextual text around a block index.

        Args:
            tenant_id: current tenant for permission checking.
            document_id: optional document identifier to resolve file binding.
            file_id: optional file id override.
            block_index: anchor block index (FulltextBlock.block_index).
            window: number of surrounding blocks before/after anchor.
            char_limit: truncate combined text to this many characters.
        """

        window = max(0, min(window, 20))
        char_limit = max(200, min(char_limit, 8000))

        document: Document | None = None
        if document_id is not None:
            document = (
                self.db.query(Document)
                .filter(Document.id == document_id, Document.tenant_id == tenant_id)
                .first()
            )
            if document is None:
                raise HTTPException(status_code=404, detail="文档不存在或无权访问")
            if file_id is None:
                file_id = document.file_id

        if file_id is None:
            raise HTTPException(status_code=400, detail="无法定位原始文件以读取上下文")

        file_obj: File | None = self.db.query(File).filter(File.id == file_id).first()
        if file_obj is None:
            raise HTTPException(status_code=404, detail="原始文件不存在")

        query = (
            self.db.query(FulltextBlock)
            .filter(FulltextBlock.file_id == file_id)
            .order_by(FulltextBlock.block_index.asc())
        )

        if block_index is not None:
            start = max(block_index - window, 0)
            end = block_index + window
            query = query.filter(
                FulltextBlock.block_index >= start,
                FulltextBlock.block_index <= end,
            )
        else:
            query = query.limit(window * 2 + 1)

        blocks = query.all()
        if not blocks:
            raise HTTPException(status_code=404, detail="指定位置附近没有可用的全文内容")

        text_parts: list[str] = []
        min_block = None
        max_block = None
        pages = set()
        for block in blocks:
            if not block.content:
                continue
            cleaned = block.content.strip()
            if not cleaned:
                continue
            text_parts.append(cleaned)
            pages.add(block.page_num)
            if min_block is None or block.block_index < min_block:
                min_block = block.block_index
            if max_block is None or block.block_index > max_block:
                max_block = block.block_index

        combined = "\n\n".join(text_parts)
        if len(combined) > char_limit:
            combined = combined[:char_limit].rstrip() + "……"

        result = {
            "document": {
                "id": document.id if document else None,
                "title": document.title if document else None,
            },
            "file": {
                "id": file_obj.id,
                "name": file_obj.original_name,
                "source_type": file_obj.source_type,
            },
            "pages": sorted(pages),
            "block_range": [min_block, max_block] if min_block is not None else None,
            "text": combined,
        }
        logger.info(
            "document_read_tool.read_span tenant=%s document=%s file=%s blocks=%s",
            tenant_id,
            document.id if document else None,
            file_obj.id,
            len(blocks),
        )
        return result
