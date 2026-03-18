from __future__ import annotations

import threading
import time


class EmbeddingRateLimiter:
    def __init__(self, *, rpm: int = 600, tpm: int = 200000) -> None:
        self._rpm = max(1, rpm)
        self._tpm = max(1, tpm)
        self._lock = threading.Lock()
        self._window_start = time.monotonic()
        self._request_count = 0
        self._token_count = 0

    def acquire(self, *, request_tokens: int, request_count: int = 1) -> None:
        request_tokens = max(0, int(request_tokens))
        request_count = max(1, int(request_count))
        while True:
            with self._lock:
                now = time.monotonic()
                if now - self._window_start >= 60:
                    self._window_start = now
                    self._request_count = 0
                    self._token_count = 0
                if (
                    self._request_count + request_count <= self._rpm
                    and self._token_count + request_tokens <= self._tpm
                ):
                    self._request_count += request_count
                    self._token_count += request_tokens
                    return
                sleep_for = max(0.05, 60 - (now - self._window_start))
            time.sleep(min(sleep_for, 1.0))
