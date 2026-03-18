from __future__ import annotations

from typing import Any

from ..qwen_client import QwenEmbeddingClient
from .rate_limiter import EmbeddingRateLimiter


class KBEmbeddingService:
    def __init__(self, *, limiter: EmbeddingRateLimiter | None = None) -> None:
        self._client = QwenEmbeddingClient()
        self._limiter = limiter or EmbeddingRateLimiter()

    @property
    def model_name(self) -> str:
        return self._client.model

    def embed_rows(self, rows: list[Any]) -> list[list[float]]:
        payloads = [row.embed_input for row in rows]
        token_budget = sum(max(1, int(getattr(row, "token_count", 1) or 1)) for row in rows)
        self._limiter.acquire(request_tokens=token_budget, request_count=max(1, len(payloads)))
        return self._client.embed(payloads)
