from __future__ import annotations

from fastapi import HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.types import ASGIApp


class LimitRequestSizeMiddleware(BaseHTTPMiddleware):
    """Reject requests whose Content-Length exceeds configured max size."""

    def __init__(self, app: ASGIApp, max_body_size: int) -> None:
        super().__init__(app)
        self.max_body_size = max_body_size

    async def dispatch(self, request: Request, call_next):
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                declared = int(content_length)
            except ValueError:
                declared = None
            else:
                if declared > self.max_body_size:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Request body too large (>{self.max_body_size} bytes)",
                    )
        return await call_next(request)
