from __future__ import annotations

import time
from collections import defaultdict, deque
from threading import Lock
from typing import Callable, Deque, Dict

from fastapi import HTTPException, Request


class RateLimiter:
    """Simple in-memory sliding-window rate limiter.

    This implementation is process-local and intended for quick protection
    against accidental bursts in a single worker. For clustered deployments,
    replace with a Redis-based limiter.
    """

    def __init__(self) -> None:
        self._hits: Dict[str, Deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def check(self, key: str, limit: int, window_seconds: int) -> None:
        now = time.time()
        window_start = now - window_seconds
        with self._lock:
            bucket = self._hits[key]
            while bucket and bucket[0] < window_start:
                bucket.popleft()
            if len(bucket) >= limit:
                raise HTTPException(
                    status_code=429,
                    detail="Too many requests, please slow down.",
                )
            bucket.append(now)


_rate_limiter = RateLimiter()


def rate_limit(name: str, limit: int, window_seconds: int) -> Callable[[Request], None]:
    """Factory returning a FastAPI dependency enforcing rate limits."""

    async def dependency(request: Request) -> None:
        client_host = request.client.host if request.client else "unknown"
        key = f"{name}:{client_host}"
        _rate_limiter.check(key, limit, window_seconds)

    return dependency
