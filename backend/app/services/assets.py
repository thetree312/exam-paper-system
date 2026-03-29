from __future__ import annotations

import base64
import mimetypes
from pathlib import Path
from urllib.parse import quote

from ..config import get_settings


class AssetResolver:
    def __init__(
        self,
        *,
        backend_root: Path | None = None,
        transport_mode: str | None = None,
        public_asset_base_url: str | None = None,
    ) -> None:
        settings = get_settings()
        self._backend_root = backend_root or Path(__file__).resolve().parents[2]
        self._transport_mode = str(transport_mode or settings.asset_transport_mode).strip().lower()
        self._public_asset_base_url = (
            str(public_asset_base_url if public_asset_base_url is not None else settings.public_asset_base_url)
            .strip()
            .rstrip("/")
        )

    def resolve_for_storage(self, asset_ref: str) -> Path:
        ref = str(asset_ref or "").strip()
        if not ref:
            raise ValueError("asset_ref is empty")
        if ref.startswith(("http://", "https://", "data:image/")):
            raise ValueError("asset_ref is not a local storage reference")
        path = (self._backend_root / ref.lstrip("/\\")).resolve()
        if not path.exists() or not path.is_file():
            raise FileNotFoundError(f"asset not found: {path}")
        return path

    def build_public_url(self, asset_ref: str) -> str:
        ref = str(asset_ref or "").strip().replace("\\", "/").lstrip("/")
        if not ref:
            raise ValueError("asset_ref is empty")
        if ref.startswith(("http://", "https://")):
            return ref
        if not self._public_asset_base_url:
            raise ValueError("PUBLIC_ASSET_BASE_URL is not configured")
        return f"{self._public_asset_base_url}/{quote(ref, safe='/')}"

    def resolve_for_model(self, asset_ref: str) -> str:
        ref = str(asset_ref or "").strip()
        if not ref:
            raise ValueError("asset_ref is empty")
        if ref.startswith(("http://", "https://", "data:image/")):
            return ref
        if self._transport_mode == "base64":
            return self._build_data_url(ref)
        if self._transport_mode == "public_url":
            return self.build_public_url(ref)
        raise ValueError(f"unsupported asset transport mode: {self._transport_mode}")

    def _build_data_url(self, asset_ref: str) -> str:
        path = self.resolve_for_storage(asset_ref)
        raw = path.read_bytes()
        mime_type, _ = mimetypes.guess_type(path.name)
        mime = mime_type or "image/png"
        encoded = base64.b64encode(raw).decode("ascii")
        return f"data:{mime};base64,{encoded}"
