from __future__ import annotations

from pathlib import Path


def test_asset_resolver_returns_data_url_for_local_asset_in_base64_mode(tmp_path, monkeypatch):
    from app import config as config_module
    from app.services.assets import AssetResolver

    asset = tmp_path / "sample.png"
    asset.write_bytes(
        bytes.fromhex(
            "89504E470D0A1A0A0000000D4948445200000001000000010802000000907753DE0000000C49444154789C6360000000020001E221BC330000000049454E44AE426082"
        )
    )

    monkeypatch.setenv("ASSET_TRANSPORT_MODE", "base64")
    config_module.get_settings.cache_clear()
    try:
        resolver = AssetResolver(backend_root=tmp_path)
        value = resolver.resolve_for_model("sample.png")
    finally:
        config_module.get_settings.cache_clear()

    assert value.startswith("data:image/png;base64,")


def test_asset_resolver_preserves_http_urls(monkeypatch):
    from app import config as config_module
    from app.services.assets import AssetResolver

    monkeypatch.setenv("ASSET_TRANSPORT_MODE", "public_url")
    monkeypatch.setenv("PUBLIC_ASSET_BASE_URL", "https://cdn.example.com")
    config_module.get_settings.cache_clear()
    try:
        resolver = AssetResolver()
        value = resolver.resolve_for_model("https://cdn.example.com/uploads/2/sample.png")
    finally:
        config_module.get_settings.cache_clear()

    assert value == "https://cdn.example.com/uploads/2/sample.png"


def test_asset_resolver_builds_public_url_without_db_rewrite(monkeypatch):
    from app import config as config_module
    from app.services.assets import AssetResolver

    monkeypatch.setenv("ASSET_TRANSPORT_MODE", "public_url")
    monkeypatch.setenv("PUBLIC_ASSET_BASE_URL", "https://cdn.example.com/static")
    config_module.get_settings.cache_clear()
    try:
        resolver = AssetResolver()
        value = resolver.resolve_for_model("uploads/2/sample.page3.png")
    finally:
        config_module.get_settings.cache_clear()

    assert value == "https://cdn.example.com/static/uploads/2/sample.page3.png"
