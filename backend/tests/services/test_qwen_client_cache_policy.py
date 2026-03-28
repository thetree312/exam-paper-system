from __future__ import annotations


def test_qwen_client_auto_cache_marks_only_stable_system_prefix(monkeypatch) -> None:
    from app import config as config_module
    from app.services.qwen_client import QwenClient

    monkeypatch.setenv("ALIBABA_API_KEY", "test-key")
    monkeypatch.setenv("ALIBABA_EXPLICIT_CACHE_ENABLED", "true")
    config_module.get_settings.cache_clear()
    try:
        client = QwenClient()
        prepared = client._inject_explicit_cache_markers(
            [
                {"role": "system", "content": "stable system prompt"},
                {"role": "system", "content": '[Decision State]\n{"goal":"foo"}'},
                {"role": "system", "content": '[Working Set]\n{"entries": []}'},
                {"role": "user", "content": "latest question"},
                {"role": "assistant", "content": "previous answer"},
                {
                    "role": "tool",
                    "content": [
                        {"type": "text", "text": '{"status":"ok","summary":"dynamic"}'},
                    ],
                },
            ]
        )
    finally:
        config_module.get_settings.cache_clear()

    assert prepared[0]["content"][0]["cache_control"]["type"] == "ephemeral"
    assert "cache_control" not in prepared[1]["content"][0]
    assert "cache_control" not in prepared[2]["content"][0]
    assert "cache_control" not in prepared[3]["content"][0]
    assert "cache_control" not in prepared[4]["content"][0]
    assert "cache_control" not in prepared[5]["content"][0]


def test_qwen_client_preserves_existing_manual_cache_markers(monkeypatch) -> None:
    from app import config as config_module
    from app.services.qwen_client import QwenClient

    monkeypatch.setenv("ALIBABA_API_KEY", "test-key")
    monkeypatch.setenv("ALIBABA_EXPLICIT_CACHE_ENABLED", "true")
    config_module.get_settings.cache_clear()
    try:
        client = QwenClient()
        prepared = client._inject_explicit_cache_markers(
            [
                {"role": "system", "content": "stable system prompt"},
                {
                    "role": "tool",
                    "content": [
                        {
                            "type": "text",
                            "text": '{"status":"ok"}',
                            "cache_control": {"type": "ephemeral"},
                        }
                    ],
                },
            ]
        )
    finally:
        config_module.get_settings.cache_clear()

    assert prepared[0]["content"][0]["cache_control"]["type"] == "ephemeral"
    assert prepared[1]["content"][0]["cache_control"]["type"] == "ephemeral"
