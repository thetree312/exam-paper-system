from __future__ import annotations

from pathlib import Path
from typing import Any

from ....models import File
from ...fulltext_service import FulltextService


class PdfKBExtractor:
    def __init__(self, db: Any) -> None:
        self._db = db
        self._fulltext = FulltextService(db)
        self._backend_root = Path(__file__).resolve().parents[4]

    def extract(self, file: File) -> dict[str, Any]:
        blocks = self._fulltext.get_or_extract_fulltext(int(file.id))
        pages = self._discover_preview_pages(file)
        preview_by_page = {item["page_no"]: item for item in pages}
        for block in blocks:
            page = preview_by_page.get(int(getattr(block, "page_num", 0) or 0))
            if page and not page.get("preview_text"):
                page["preview_text"] = str(getattr(block, "content", "") or "")[:300]
        return {"blocks": blocks, "pages": pages}

    def _discover_preview_pages(self, file: File) -> list[dict[str, Any]]:
        if not file.preview_path:
            return []
        rel = Path(file.preview_path)
        folder = self._backend_root / rel.parent
        name = rel.name
        if ".page" not in name:
            return [{"page_no": 1, "preview_image_path": rel.as_posix(), "preview_text": None}]
        base, suffix = name.rsplit(".page", 1)
        if "." not in suffix:
            return [{"page_no": 1, "preview_image_path": rel.as_posix(), "preview_text": None}]
        _page_str, ext = suffix.split(".", 1)
        matches = sorted(folder.glob(f"{base}.page*.{ext}"))
        pages: list[dict[str, Any]] = []
        for idx, path in enumerate(matches, start=1):
            pages.append(
                {
                    "page_no": idx,
                    "preview_image_path": path.relative_to(self._backend_root).as_posix(),
                    "preview_text": None,
                }
            )
        return pages
