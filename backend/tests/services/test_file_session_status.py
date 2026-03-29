from __future__ import annotations

from types import SimpleNamespace
from pathlib import Path


def test_get_session_status_reports_preview_ready_before_kb_source_exists(monkeypatch) -> None:
    from app.routers import files as files_router

    file_obj = SimpleNamespace(id=88, source_type="pdf", preview_path="uploads/2/paper.page1.png")
    session_obj = SimpleNamespace(id=66, tenant_id=2, user_id=3, workroom_id=None, status="done", file=file_obj)

    class _FakeQuery:
        def __init__(self, result):
            self._result = result

        def filter(self, *_args, **_kwargs):
            return self

        def first(self):
            return self._result

    class _FakeExecuteResult:
        def mappings(self):
            return self

        def first(self):
            return None

    class _FakeDB:
        def query(self, model):
            return _FakeQuery(session_obj if getattr(model, "__name__", "") == "ExtractionSession" else file_obj)

        def execute(self, *_args, **_kwargs):
            return _FakeExecuteResult()

    monkeypatch.setattr(files_router, "_detect_page_count", lambda _file, _root: 2)

    result = files_router.get_session_status(66, db=_FakeDB())

    assert result.status == "done"
    assert result.ingestion_status == "preview_ready"
    assert result.preview_pages == [
        "/api/files/preview/88?page=1",
        "/api/files/preview/88?page=2",
    ]


def test_get_session_status_reports_layout_running_when_source_is_mid_pipeline(monkeypatch) -> None:
    from app.routers import files as files_router

    file_obj = SimpleNamespace(id=88, source_type="pdf", preview_path="uploads/2/paper.page1.png")
    session_obj = SimpleNamespace(id=66, tenant_id=2, user_id=3, workroom_id=9, status="done", file=file_obj)

    class _FakeQuery:
        def __init__(self, result):
            self._result = result

        def filter(self, *_args, **_kwargs):
            return self

        def first(self):
            return self._result

    class _FakeExecuteResult:
        def mappings(self):
            return self

        def first(self):
            return {"status": "layout_running"}

    class _FakeDB:
        def query(self, model):
            return _FakeQuery(session_obj if getattr(model, "__name__", "") == "ExtractionSession" else file_obj)

        def execute(self, *_args, **_kwargs):
            return _FakeExecuteResult()

    monkeypatch.setattr(files_router, "_detect_page_count", lambda _file, _root: 1)

    result = files_router.get_session_status(66, db=_FakeDB())

    assert result.ingestion_status == "layout_running"


def test_get_session_status_reports_kb_ready_and_degraded_ready(monkeypatch) -> None:
    from app.routers import files as files_router

    file_obj = SimpleNamespace(id=88, source_type="pdf", preview_path="uploads/2/paper.page1.png")
    session_obj = SimpleNamespace(id=66, tenant_id=2, user_id=3, workroom_id=None, status="done", file=file_obj)

    class _FakeQuery:
        def __init__(self, result):
            self._result = result

        def filter(self, *_args, **_kwargs):
            return self

        def first(self):
            return self._result

    class _FakeExecuteResult:
        def __init__(self, row):
            self._row = row

        def mappings(self):
            return self

        def first(self):
            return self._row

    class _FakeDB:
        def __init__(self, row):
            self._row = row

        def query(self, model):
            return _FakeQuery(session_obj if getattr(model, "__name__", "") == "ExtractionSession" else file_obj)

        def execute(self, *_args, **_kwargs):
            return _FakeExecuteResult(self._row)

    monkeypatch.setattr(files_router, "_detect_page_count", lambda _file, _root: 1)

    ready_result = files_router.get_session_status(66, db=_FakeDB({"status": "ready"}))
    degraded_result = files_router.get_session_status(66, db=_FakeDB({"status": "failed"}))

    assert ready_result.ingestion_status == "kb_ready"
    assert degraded_result.ingestion_status == "degraded_ready"


def test_get_session_status_handles_missing_page_count_without_500(monkeypatch) -> None:
    from app.routers import files as files_router

    class _FakeQuery:
        def filter(self, *_args, **_kwargs):
            return self

        def first(self):
            file_obj = type("File", (), {"id": 901})()
            return type("Session", (), {"id": 66, "status": "done", "file": file_obj})()

    class _FakeDB:
        def query(self, *_args, **_kwargs):
            return _FakeQuery()

        def execute(self, *_args, **_kwargs):
            class _Result:
                def first(self):
                    return None

            return _Result()

    monkeypatch.setattr(files_router, "_detect_page_count", lambda _file, _root: None)
    monkeypatch.setattr(files_router, "_derive_ingestion_status", lambda **_kwargs: "preview_ready")

    result = files_router.get_session_status(66, db=_FakeDB())

    assert result.session_id == 66
    assert result.preview_url is None
    assert result.preview_pages == []
    assert result.ingestion_status == "preview_ready"


def test_derive_ingestion_status_handles_missing_page_count_without_500(monkeypatch) -> None:
    from app.routers import files as files_router

    file_obj = SimpleNamespace(id=88, source_type="pdf", preview_path="uploads/2/paper.page1.png")
    session_obj = SimpleNamespace(
        id=66,
        tenant_id=2,
        user_id=3,
        workroom_id=None,
        status="done",
        file=file_obj,
    )

    class _FakeDB:
        def execute(self, *_args, **_kwargs):
            raise AssertionError("kb source query should not run when page_count is missing")

    monkeypatch.setattr(files_router, "_detect_page_count", lambda _file, _root: None)

    result = files_router._derive_ingestion_status(db=_FakeDB(), session=session_obj, file=file_obj)

    assert result == "processing"


def test_detect_page_count_counts_multi_page_preview_files(tmp_path: Path) -> None:
    from app.routers import files as files_router

    uploads_dir = tmp_path / "uploads" / "2"
    uploads_dir.mkdir(parents=True)
    (uploads_dir / "paper.page1.png").write_bytes(b"page1")
    (uploads_dir / "paper.page2.png").write_bytes(b"page2")

    file_obj = SimpleNamespace(source_type="pdf", preview_path="uploads/2/paper.page1.png")

    result = files_router._detect_page_count(file_obj, tmp_path)

    assert result == 2
