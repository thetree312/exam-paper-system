from __future__ import annotations

from datetime import timedelta


class _FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, tuple[str, int]] = {}

    def set(self, key: str, value: str, nx: bool = False, ex: int | None = None):
        if nx and key in self.values:
            return False
        self.values[key] = (value, int(ex or 0))
        return True

    def get(self, key: str):
        item = self.values.get(key)
        if item is None:
            return None
        return item[0].encode("utf-8")

    def delete(self, key: str):
        return 1 if self.values.pop(key, None) is not None else 0


def test_glm_rate_limiter_allows_only_two_live_slots():
    from app.services.glm_rate_limiter import GlmConcurrencyLimiter

    redis_client = _FakeRedis()
    limiter = GlmConcurrencyLimiter(
        redis_client=redis_client, max_concurrency=2, key_prefix="test:glm", lease_ttl=timedelta(minutes=3)
    )

    first = limiter.acquire(owner="worker-1")
    second = limiter.acquire(owner="worker-2")
    third = limiter.acquire(owner="worker-3")

    assert first is not None
    assert second is not None
    assert third is None


def test_glm_rate_limiter_releases_owned_slot():
    from app.services.glm_rate_limiter import GlmConcurrencyLimiter

    redis_client = _FakeRedis()
    limiter = GlmConcurrencyLimiter(
        redis_client=redis_client, max_concurrency=2, key_prefix="test:glm", lease_ttl=timedelta(minutes=3)
    )

    first = limiter.acquire(owner="worker-1")
    assert first is not None

    limiter.release(lease=first, owner="worker-1")
    second = limiter.acquire(owner="worker-2")

    assert second is not None


def test_glm_rate_limiter_does_not_release_other_workers_slot():
    from app.services.glm_rate_limiter import GlmConcurrencyLimiter

    redis_client = _FakeRedis()
    limiter = GlmConcurrencyLimiter(
        redis_client=redis_client, max_concurrency=1, key_prefix="test:glm", lease_ttl=timedelta(minutes=3)
    )

    first = limiter.acquire(owner="worker-1")
    assert first is not None

    limiter.release(lease=first, owner="worker-2")
    blocked = limiter.acquire(owner="worker-3")

    assert blocked is None
