from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Protocol

import redis

from ..config import get_settings


class _RedisLike(Protocol):
    def set(self, key: str, value: str, nx: bool = False, ex: int | None = None): ...
    def get(self, key: str): ...
    def delete(self, key: str): ...


@dataclass(frozen=True, slots=True)
class GlmConcurrencyLease:
    key: str


class GlmConcurrencyLimiter:
    def __init__(
        self,
        *,
        redis_client: _RedisLike | None = None,
        max_concurrency: int | None = None,
        key_prefix: str = "glm:layout",
        lease_ttl: timedelta | None = None,
    ) -> None:
        settings = get_settings()
        self._redis: _RedisLike = redis_client or redis.Redis.from_url(settings.redis_url)
        self._max_concurrency = int(max_concurrency or settings.glm_layout_max_concurrency)
        self._key_prefix = key_prefix
        self._lease_ttl = lease_ttl or timedelta(seconds=settings.glm_layout_lease_seconds)

    def acquire(self, *, owner: str) -> GlmConcurrencyLease | None:
        ttl_seconds = max(1, int(self._lease_ttl.total_seconds()))
        for slot in range(1, self._max_concurrency + 1):
            key = f"{self._key_prefix}:{slot}"
            if self._redis.set(key, owner, nx=True, ex=ttl_seconds):
                return GlmConcurrencyLease(key=key)
        return None

    def release(self, *, lease: GlmConcurrencyLease, owner: str) -> None:
        current = self._redis.get(lease.key)
        if current is None:
            return
        if isinstance(current, bytes):
            current_value = current.decode("utf-8")
        else:
            current_value = str(current)
        if current_value != owner:
            return
        self._redis.delete(lease.key)
