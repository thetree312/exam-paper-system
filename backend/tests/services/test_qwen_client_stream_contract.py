from __future__ import annotations

import json


def test_qwen_client_exposes_chat_stream_contract() -> None:
    from app.services.qwen_client import QwenClient, QwenEmbeddingClient

    assert "chat_stream" in QwenClient.__dict__
    assert callable(QwenClient.__dict__["chat_stream"])
    assert "chat_stream" not in QwenEmbeddingClient.__dict__


def test_qwen_payload_redacts_data_url_for_logs() -> None:
    from app.services.qwen_client import _redact_payload_for_log

    payload = {
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "hello"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
                ],
            }
        ]
    }
    redacted = _redact_payload_for_log(payload)
    url = redacted["messages"][0]["content"][1]["image_url"]["url"]
    assert isinstance(url, str)
    assert url.startswith("<redacted-data-url")


def test_qwen_client_summarizes_multimodal_messages_by_role() -> None:
    from app.services.qwen_client import QwenClient

    summary = QwenClient._summarize_multimodal_messages(
        [
            {
                "role": "tool",
                "content": [
                    {"type": "text", "text": "evidence"},
                    {"type": "image_url", "image_url": {"url": "[omitted_data_url]"}},
                ],
            },
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "question"},
                    {"type": "image_url", "image_url": {"url": "[omitted_data_url]"}},
                ],
            },
            {"role": "assistant", "content": "plain text"},
        ]
    )

    assert summary["multimodal_message_count"] == 2
    assert summary["image_part_count"] == 2
    assert summary["messages_with_images_by_role"] == {"tool": 1, "user": 1}


def test_qwen_client_defaults_thinking_budget_to_800(monkeypatch) -> None:
    from app import config as config_module
    from app.services.qwen_client import QwenClient

    monkeypatch.setenv("ALIBABA_API_KEY", "test-key")
    monkeypatch.delenv("ALIBABA_THINKING_BUDGET", raising=False)
    config_module.get_settings.cache_clear()
    try:
        client = QwenClient()
        assert client._thinking_budget == 800
    finally:
        config_module.get_settings.cache_clear()


def test_qwen_client_allows_explicit_base_url_and_api_key_override(monkeypatch) -> None:
    from app import config as config_module
    from app.services.qwen_client import QwenClient

    monkeypatch.setenv("ALIBABA_API_KEY", "alibaba-key")
    config_module.get_settings.cache_clear()
    try:
        client = QwenClient(
            model="moonshotai/kimi-k2-instruct-0905",
            base_url="https://integrate.api.nvidia.com/v1",
            api_key="nvidia-key",
        )
        assert client.base_url == "https://integrate.api.nvidia.com/v1"
        assert client.api_key == "nvidia-key"
        assert client.model == "moonshotai/kimi-k2-instruct-0905"
    finally:
        config_module.get_settings.cache_clear()


def test_qwen_client_uses_plain_chat_path_for_nvidia_base_url(monkeypatch) -> None:
    from app import config as config_module
    from app.services.qwen_client import QwenClient

    monkeypatch.setenv("ALIBABA_API_KEY", "alibaba-key")
    config_module.get_settings.cache_clear()
    try:
        client = QwenClient(
            model="moonshotai/kimi-k2-instruct-0905",
            base_url="https://integrate.api.nvidia.com/v1",
            api_key="nvidia-key",
        )
        assert client._chat_path == "chat/completions"
    finally:
        config_module.get_settings.cache_clear()


def test_qwen_chat_stream_collects_final_message_content_when_delta_is_empty(monkeypatch) -> None:
    from app import config as config_module
    from app.services.qwen_client import QwenClient

    class _FakeResponse:
        status_code = 200
        text = ""

        def raise_for_status(self) -> None:
            return None

        def iter_lines(self):
            frames = [
                {
                    "choices": [
                        {
                            "delta": {
                                "thinking": "先确认第六题的指代对象。"
                            }
                        }
                    ]
                },
                {
                    "choices": [
                        {
                            "delta": {},
                            "message": {
                                "content": [
                                    {
                                        "type": "text",
                                        "text": json.dumps(
                                            {
                                                "认知更新": {
                                                    "摘要": "当前还不能直接回答。",
                                                    "已确认": ["工作区为空。"],
                                                    "未决问题": ["第六题属于哪份材料？"],
                                                    "阻塞张力": "指代尚未唯一绑定。",
                                                    "下一关注点": "先让用户明确第六题来源。",
                                                },
                                                "延续承诺": {
                                                    "用户澄清请求": "你说的第六题属于哪份试卷或文件？",
                                                    "原因": "当前缺的是指代绑定。",
                                                },
                                            },
                                            ensure_ascii=False,
                                        ),
                                    }
                                ]
                            },
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {"total_tokens": 123},
                },
            ]
            for frame in frames:
                yield f"data: {json.dumps(frame, ensure_ascii=False)}".encode("utf-8")
            yield b"data: [DONE]"

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setenv("ALIBABA_API_KEY", "test-key")
    config_module.get_settings.cache_clear()
    try:
        client = QwenClient()
        monkeypatch.setattr("app.services.qwen_client.requests.post", lambda *args, **kwargs: _FakeResponse())
        stream, result = client.chat_stream(
            [{"role": "user", "content": "第六题图例视风风速的坐标是什么"}],
            return_events=True,
        )
        events = list(stream)
        assert any(event.get("type") == "thinking" for event in events)
        assert "".join(result["content_parts"]).startswith("{")
        assert result["usage"] == 123
    finally:
        config_module.get_settings.cache_clear()
