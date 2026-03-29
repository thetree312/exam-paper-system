from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace


def _entry(**overrides):
    base = {
        "id": 1,
        "tenant_id": 2,
        "file_id": 9,
        "content_hash": "abc",
        "page_no": 3,
        "model": "glm-ocr",
        "schema_version": "v1",
        "status": "completed",
        "lease_owner": None,
        "lease_expires_at": None,
        "request_started_at": None,
        "generated_at": datetime(2026, 3, 28, tzinfo=timezone.utc),
        "error": None,
        "source_asset_ref": "uploads/2/example.page3.png",
        "transport_kind": "data_url",
        "layout_json": "{}",
        "blocks_json": "[]",
        "updated_at": datetime(2026, 3, 28, tzinfo=timezone.utc),
    }
    base.update(overrides)
    return SimpleNamespace(**base)


class _FakeQuery:
    def __init__(self, entries):
        self._entries = list(entries)

    def filter(self, *_args, **_kwargs):
        return self

    def order_by(self, *_args, **_kwargs):
        return self

    def first(self):
        return self._entries[0] if self._entries else None


class _FakeSession:
    def __init__(self, entries):
        self.entries = list(entries)
        self.added = []

    def query(self, _model):
        return _FakeQuery(self.entries)

    def add(self, item):
        self.added.append(item)
        if item not in self.entries:
            self.entries.append(item)


def test_page_layout_cache_manager_returns_completed_entry_when_fresh():
    from app.services.page_layout_cache_manager import FilePageLayoutCacheManager

    session = _FakeSession(
        [
            _entry(
                status="completed",
                generated_at=datetime.now(timezone.utc) - timedelta(minutes=5),
            )
        ]
    )

    manager = FilePageLayoutCacheManager(session)  # type: ignore[arg-type]
    result = manager.get_completed(
        tenant_id=2,
        content_hash="abc",
        page_no=3,
        model="glm-ocr",
        schema_version="v1",
        ttl=timedelta(hours=1),
    )

    assert result is not None
    assert result.status == "completed"


def test_page_layout_cache_manager_acquires_pending_page_lease():
    from app.services.page_layout_cache_manager import FilePageLayoutCacheManager

    session = _FakeSession([])
    manager = FilePageLayoutCacheManager(session)  # type: ignore[arg-type]

    lease = manager.try_acquire(
        tenant_id=2,
        file_id=9,
        content_hash="abc",
        page_no=3,
        model="glm-ocr",
        schema_version="v1",
        source_asset_ref="uploads/2/example.page3.png",
        lease_owner="worker-1",
        lease_ttl=timedelta(minutes=3),
    )

    assert lease is not None
    assert lease.status == "running"
    assert lease.lease_owner == "worker-1"
    assert lease.source_asset_ref == "uploads/2/example.page3.png"


def test_page_layout_cache_manager_refuses_live_lease_from_other_worker():
    from app.services.page_layout_cache_manager import FilePageLayoutCacheManager

    session = _FakeSession(
        [
            _entry(
                status="running",
                lease_owner="worker-1",
                lease_expires_at=datetime.now(timezone.utc) + timedelta(minutes=2),
                generated_at=None,
            )
        ]
    )
    manager = FilePageLayoutCacheManager(session)  # type: ignore[arg-type]

    lease = manager.try_acquire(
        tenant_id=2,
        file_id=9,
        content_hash="abc",
        page_no=3,
        model="glm-ocr",
        schema_version="v1",
        source_asset_ref="uploads/2/example.page3.png",
        lease_owner="worker-2",
        lease_ttl=timedelta(minutes=3),
    )

    assert lease is None


def test_page_layout_cache_manager_reclaims_expired_lease():
    from app.services.page_layout_cache_manager import FilePageLayoutCacheManager

    stale = _entry(
        status="running",
        lease_owner="worker-1",
        lease_expires_at=datetime.now(timezone.utc) - timedelta(seconds=1),
        generated_at=None,
    )
    session = _FakeSession([stale])
    manager = FilePageLayoutCacheManager(session)  # type: ignore[arg-type]

    lease = manager.try_acquire(
        tenant_id=2,
        file_id=9,
        content_hash="abc",
        page_no=3,
        model="glm-ocr",
        schema_version="v1",
        source_asset_ref="uploads/2/example.page3.png",
        lease_owner="worker-2",
        lease_ttl=timedelta(minutes=3),
    )

    assert lease is stale
    assert lease.lease_owner == "worker-2"
    assert lease.status == "running"
