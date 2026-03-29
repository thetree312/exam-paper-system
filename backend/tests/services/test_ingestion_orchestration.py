from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any


def test_generate_previews_for_session_enqueues_layout_scheduler(monkeypatch) -> None:
    from app import tasks as tasks_module

    file_obj = SimpleNamespace(
        id=88,
        source_type="pdf",
        storage_path="uploads/2/paper.pdf",
        preview_path=None,
        tenant_id=2,
        user_id=3,
    )
    session_obj = SimpleNamespace(
        id=66,
        tenant_id=2,
        user_id=3,
        workroom_id=None,
        status="pending",
        file=file_obj,
    )
    calls: dict[str, Any] = {"schedule": []}

    class _FakeQuery:
        def filter(self, *_args, **_kwargs):
            return self

        def first(self):
            return session_obj

    class _FakeDB:
        def query(self, _model):
            return _FakeQuery()

        def add(self, _item):
            return None

        def commit(self):
            return None

        def close(self):
            return None

    monkeypatch.setattr(tasks_module, "SessionLocal", lambda: _FakeDB())
    monkeypatch.setattr(tasks_module, "_get_backend_root", lambda: Path("D:/Exam-paper/backend"))
    monkeypatch.setattr(tasks_module, "_render_pdf_previews", lambda _path: [Path("D:/Exam-paper/backend/uploads/2/paper.page1.png")])
    monkeypatch.setattr(tasks_module, "schedule_layout_for_file", SimpleNamespace(delay=lambda *args: calls["schedule"].append(args)))

    tasks_module.generate_previews_for_session(66)

    assert calls["schedule"] == [(2, 3, 88, None)]


def test_schedule_layout_for_file_enqueues_one_page_task_per_preview_page(monkeypatch) -> None:
    from app import tasks as tasks_module

    file_obj = SimpleNamespace(
        id=88,
        tenant_id=2,
        uploader_id=3,
        preview_path="uploads/2/paper.page1.png",
        source_type="pdf",
        content_hash="abc123",
    )
    source_obj = {"id": 701, "tenant_id": 2, "user_id": 3}
    queued_pages: list[tuple[Any, ...]] = []
    repo_calls: dict[str, Any] = {}

    class _FakeFileQuery:
        def filter(self, *_args, **_kwargs):
            return self

        def first(self):
            return file_obj

    class _FakeDB:
        def query(self, _model):
            return _FakeFileQuery()

        def commit(self):
            repo_calls["committed"] = True

        def rollback(self):
            repo_calls["rolled_back"] = True

        def close(self):
            return None

    class _FakeRepo:
        def __init__(self, _db):
            return None

        def upsert_source(self, **kwargs):
            repo_calls["upsert_source"] = kwargs
            return source_obj

        def create_ingest_job(self, **kwargs):
            repo_calls.setdefault("create_jobs", []).append(kwargs)
            return 91

        def finish_ingest_job(self, **kwargs):
            repo_calls.setdefault("finish_jobs", []).append(kwargs)

        def mark_source_status(self, **kwargs):
            repo_calls.setdefault("mark_source_status", []).append(kwargs)

    monkeypatch.setattr(tasks_module, "SessionLocal", lambda: _FakeDB())
    monkeypatch.setattr(tasks_module, "KBRepository", _FakeRepo)
    monkeypatch.setattr(tasks_module, "_detect_page_count", lambda _file, _root: 3)
    monkeypatch.setattr(tasks_module, "_get_backend_root", lambda: Path("D:/Exam-paper/backend"))
    monkeypatch.setattr(tasks_module, "parse_layout_for_page", SimpleNamespace(delay=lambda *args: queued_pages.append(args)))

    tasks_module.schedule_layout_for_file(tenant_id=2, user_id=3, file_id=88, workroom_id=None)

    assert queued_pages == [
        (2, 3, 88, 701, 1),
        (2, 3, 88, 701, 2),
        (2, 3, 88, 701, 3),
    ]
    assert repo_calls["committed"] is True


def test_parse_layout_for_page_enqueues_finalize_after_commit(monkeypatch) -> None:
    from app import tasks as tasks_module

    file_obj = SimpleNamespace(
        id=1076,
        content_hash="hash-1076",
        source_type="pdf",
        preview_path="uploads/2/paper.page1.png",
    )
    queued_finalize: list[tuple[Any, ...]] = []
    state: dict[str, Any] = {"committed": False, "job_finished": False}

    class _FakeLease:
        pass

    class _FakeFileQuery:
        def filter(self, *_args, **_kwargs):
            return self

        def first(self):
            return file_obj

    class _FakeDB:
        def query(self, _model):
            return _FakeFileQuery()

        def rollback(self):
            return None

        def commit(self):
            state["committed"] = True

        def close(self):
            return None

    class _FakeRepo:
        def __init__(self, _db):
            return None

        def create_ingest_job(self, **_kwargs):
            return 91

        def mark_source_status(self, **_kwargs):
            return None

        def finish_ingest_job(self, **_kwargs):
            state["job_finished"] = True

    class _FakeCacheManager:
        def __init__(self, _db):
            return None

        def get_completed(self, **_kwargs):
            return None

        def try_acquire(self, **_kwargs):
            return SimpleNamespace(id=1)

        def mark_completed(self, **_kwargs):
            return None

    class _FakeLimiter:
        def __init__(self, **_kwargs):
            return None

        def acquire(self, **_kwargs):
            return _FakeLease()

        def release(self, **_kwargs):
            return None

    class _FakePageLayoutService:
        def __init__(self, **_kwargs):
            return None

        def parse_page(self, **_kwargs):
            return SimpleNamespace(
                raw_payload={"ok": True},
                blocks=[{"block_type": "text"}],
                transport_kind="data_url",
            )

    monkeypatch.setattr(tasks_module, "SessionLocal", lambda: _FakeDB())
    monkeypatch.setattr(tasks_module, "KBRepository", _FakeRepo)
    monkeypatch.setattr(tasks_module, "FilePageLayoutCacheManager", _FakeCacheManager)
    monkeypatch.setattr(tasks_module, "GlmConcurrencyLimiter", _FakeLimiter)
    monkeypatch.setattr(tasks_module, "PageLayoutService", _FakePageLayoutService)
    monkeypatch.setattr(tasks_module, "_resolve_preview_asset_ref", lambda **_kwargs: "uploads/2/paper.page1.png")
    monkeypatch.setattr(
        tasks_module,
        "finalize_layout_for_file",
        SimpleNamespace(delay=lambda *args: queued_finalize.append(args)),
    )

    tasks_module.parse_layout_for_page(
        tenant_id=2,
        user_id=2,
        file_id=1076,
        source_id=43,
        page_no=1,
    )

    assert state["job_finished"] is True
    assert state["committed"] is True
    assert queued_finalize == [(2, 2, 1076, 43)]


def test_finalize_layout_for_file_enqueues_materialize_from_committed_state(monkeypatch) -> None:
    from app import tasks as tasks_module

    file_obj = SimpleNamespace(
        id=1076,
        content_hash="hash-1076",
        source_type="pdf",
        preview_path="uploads/2/paper.page1.png",
    )
    queued_materialize: list[tuple[Any, ...]] = []
    state: dict[str, Any] = {"count_calls": 0, "committed": False}

    class _FakeFileQuery:
        def filter(self, *_args, **_kwargs):
            return self

        def first(self):
            return file_obj

    class _FakeCountQuery:
        def filter(self, *_args, **_kwargs):
            return self

        def count(self):
            state["count_calls"] += 1
            return 8

    class _FakeScalarResult:
        def __init__(self, value):
            self._value = value

        def scalar_one(self):
            return self._value

    class _FakeMappingResult:
        def __init__(self, row):
            self._row = row

        def mappings(self):
            return self

        def first(self):
            return self._row

    class _FakeDB:
        def query(self, model):
            if model is tasks_module.File:
                return _FakeFileQuery()
            return _FakeCountQuery()

        def execute(self, statement, params=None):
            sql = str(statement)
            if "FROM kb_ingest_jobs" in sql:
                return _FakeScalarResult(0)
            if "UPDATE kb_sources" in sql and "RETURNING workroom_id, status" in sql:
                return _FakeMappingResult({"workroom_id": 29, "status": "embedding_queued"})
            raise AssertionError(f"unexpected SQL: {sql}")

        def commit(self):
            state["committed"] = True

        def rollback(self):
            return None

        def close(self):
            return None

    monkeypatch.setattr(tasks_module, "SessionLocal", lambda: _FakeDB())
    monkeypatch.setattr(tasks_module, "_detect_page_count", lambda _file, _root: 8)
    monkeypatch.setattr(tasks_module, "_get_backend_root", lambda: Path("D:/Exam-paper/backend"))
    monkeypatch.setattr(
        tasks_module,
        "materialize_kb_for_file",
        SimpleNamespace(delay=lambda *args: queued_materialize.append(args)),
    )

    tasks_module.finalize_layout_for_file(
        tenant_id=2,
        user_id=2,
        file_id=1076,
        source_id=43,
    )

    assert state["count_calls"] == 1
    assert state["committed"] is True
    assert queued_materialize == [(2, 2, 1076, 29)]
