from __future__ import annotations

from pathlib import Path
from typing import Any

from ....models import File


class ImageKBExtractor:
    def __init__(self, db: Any) -> None:
        self._db = db

    def extract(self, file: File) -> dict[str, Any]:
        rel_path = str(file.preview_path or file.storage_path or "").strip()
        pages = []
        if rel_path:
            pages.append({"page_no": 1, "preview_image_path": Path(rel_path).as_posix(), "preview_text": None})
        return {"blocks": [], "pages": pages}
