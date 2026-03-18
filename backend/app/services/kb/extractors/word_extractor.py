from __future__ import annotations

from typing import Any

from ....models import File
from ...fulltext_service import FulltextService
from .pdf_extractor import PdfKBExtractor


class WordKBExtractor:
    def __init__(self, db: Any) -> None:
        self._db = db
        self._fulltext = FulltextService(db)
        self._pdf_like = PdfKBExtractor(db)

    def extract(self, file: File) -> dict[str, Any]:
        blocks = self._fulltext.get_or_extract_fulltext(int(file.id))
        pages = self._pdf_like._discover_preview_pages(file)
        if not pages:
            pages = [{"page_no": 1, "preview_image_path": None, "preview_text": None}]
        for block in blocks:
            page_no = int(getattr(block, "page_num", 1) or 1)
            target = next((page for page in pages if int(page.get("page_no") or 1) == page_no), None)
            if target and not target.get("preview_text"):
                target["preview_text"] = str(getattr(block, "content", "") or "")[:300]
        return {"blocks": blocks, "pages": pages}
