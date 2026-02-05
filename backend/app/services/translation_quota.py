from __future__ import annotations

import time
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timezone
from threading import Lock
from typing import Deque, Dict


@dataclass
class QuotaStatus:
    limit: int
    remaining: int
    reset_at: datetime


class QuotaExceeded(RuntimeError):
    def __init__(self, status: QuotaStatus) -> None:
        super().__init__("translation quota exceeded")
        self.status = status


class TranslationQuotaManager:
    LIMIT = 20
    WINDOW_SECONDS = 3600

    def __init__(self) -> None:
        self._events: Dict[int, Deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def consume(self, user_id: int) -> QuotaStatus:
        now = time.time()
        window_start = now - self.WINDOW_SECONDS
        with self._lock:
            bucket = self._events[user_id]
            while bucket and bucket[0] < window_start:
                bucket.popleft()

            if len(bucket) >= self.LIMIT:
                reset_ts = bucket[0] + self.WINDOW_SECONDS if bucket else now + self.WINDOW_SECONDS
                status = QuotaStatus(
                    limit=self.LIMIT,
                    remaining=0,
                    reset_at=datetime.fromtimestamp(reset_ts, tz=timezone.utc),
                )
                raise QuotaExceeded(status)

            bucket.append(now)
            remaining = self.LIMIT - len(bucket)
            reset_ts = bucket[0] + self.WINDOW_SECONDS if bucket else now + self.WINDOW_SECONDS
            return QuotaStatus(
                limit=self.LIMIT,
                remaining=remaining,
                reset_at=datetime.fromtimestamp(reset_ts, tz=timezone.utc),
            )
