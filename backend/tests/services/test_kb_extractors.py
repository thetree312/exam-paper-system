from __future__ import annotations

from types import SimpleNamespace
from typing import Any


def test_image_extractor_uses_existing_preview_path() -> None:
    from app.services.kb.extractors import ImageKBExtractor

    extractor = ImageKBExtractor(db=None)
    file_obj = SimpleNamespace(preview_path="uploads/2/page1.png", storage_path="uploads/2/raw.png")

    payload = extractor.extract(file_obj)

    assert payload["blocks"] == []
    assert payload["pages"] == [{"page_no": 1, "preview_image_path": "uploads/2/page1.png", "preview_text": None}]


def test_word_extractor_reuses_fulltext_blocks(monkeypatch: Any) -> None:
    from app.services.kb.extractors.word_extractor import WordKBExtractor

    blocks = [SimpleNamespace(page_num=1, content="word paragraph"), SimpleNamespace(page_num=1, content="table row")]
    monkeypatch.setattr(
        "app.services.kb.extractors.word_extractor.FulltextService.get_or_extract_fulltext",
        lambda self, _file_id: blocks,
    )
    monkeypatch.setattr(
        "app.services.kb.extractors.word_extractor.PdfKBExtractor._discover_preview_pages",
        lambda self, _file: [{"page_no": 1, "preview_image_path": "uploads/2/word.page1.png", "preview_text": None}],
    )

    extractor = WordKBExtractor(db=None)
    file_obj = SimpleNamespace(id=8, preview_path="uploads/2/word.page1.png")
    payload = extractor.extract(file_obj)

    assert payload["blocks"] == blocks
    assert payload["pages"][0]["preview_image_path"] == "uploads/2/word.page1.png"
    assert payload["pages"][0]["preview_text"] == "word paragraph"
