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
                    {"type": "input_image", "image_url": "[omitted_data_url]"},
                ],
            },
            {"role": "assistant", "content": "plain text"},
        ]
    )

    assert summary["multimodal_message_count"] == 2
    assert summary["image_part_count"] == 2
    assert summary["messages_with_images_by_role"] == {"tool": 1, "user": 1}


def test_qwen_client_defaults_thinking_budget_matches_config_default(monkeypatch) -> None:
    from app import config as config_module
    from app.services.qwen_client import QwenClient

    monkeypatch.setenv("ALIBABA_API_KEY", "test-key")
    monkeypatch.delenv("ALIBABA_THINKING_BUDGET", raising=False)
    config_module.get_settings.cache_clear()
    try:
        client = QwenClient()
        assert client._thinking_budget == 2048
    finally:
        config_module.get_settings.cache_clear()


def test_qwen_client_injects_cache_markers_only_for_stable_system_parts(monkeypatch) -> None:
    from app import config as config_module
    from app.services.qwen_client import QwenClient

    monkeypatch.setenv("ALIBABA_API_KEY", "test-key")
    monkeypatch.setenv("ALIBABA_EXPLICIT_CACHE_ENABLED", "true")
    config_module.get_settings.cache_clear()
    try:
        client = QwenClient()
        prepared = client._inject_explicit_cache_markers(
            [
                {"role": "system", "content": "system"},
                {"role": "user", "content": "question"},
                {"role": "assistant", "content": "receipt"},
                {
                    "role": "tool",
                    "content": [
                        {"type": "text", "text": '{"status":"ok"}'},
                        {"type": "image_url", "image_url": {"url": "[omitted_data_url]"}},
                    ],
                },
            ]
        )
    finally:
        config_module.get_settings.cache_clear()

    assert prepared[0]["content"][0]["cache_control"]["type"] == "ephemeral"
    assert prepared[1]["content"] == "question"
    assert prepared[2]["content"] == "receipt"
    tool_content = prepared[3]["content"]
    assert isinstance(tool_content, list)
    assert "cache_control" not in tool_content[0]
    assert "cache_control" not in tool_content[1]


def test_qwen_client_builds_session_cache_headers(monkeypatch) -> None:
    from app import config as config_module
    from app.services.qwen_client import QwenClient

    monkeypatch.setenv("ALIBABA_API_KEY", "test-key")
    monkeypatch.setenv("ALIBABA_SESSION_CACHE_ENABLED", "true")
    config_module.get_settings.cache_clear()
    try:
        client = QwenClient(session_id="thread-123")
        headers = client._build_headers()
    finally:
        config_module.get_settings.cache_clear()

    assert headers["Authorization"] == "Bearer test-key"
    assert headers["Content-Type"] == "application/json"
    assert headers["x-dashscope-session-cache"] == "enable"
    assert headers["X-Agent-Session-Id"] == "thread-123"


def test_qwen_embedding_client_does_not_expose_chat_methods(monkeypatch) -> None:
    from app import config as config_module
    from app.services.qwen_client import QwenEmbeddingClient

    monkeypatch.setenv("ALIBABA_API_KEY", "test-key")
    monkeypatch.setenv("ALIBABA_MODEL_EMBEDDING", "tongyi-embedding-vision-flash")
    config_module.get_settings.cache_clear()
    try:
        client = QwenEmbeddingClient()
    finally:
        config_module.get_settings.cache_clear()

    assert "chat_stream" not in type(client).__dict__
    assert "last_usage_total_tokens" not in type(client).__dict__


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


def test_qwen_responses_stream_collects_response_id_and_function_calls(monkeypatch) -> None:
    from app import config as config_module
    from app.services.qwen_client import QwenClient

    class _FakeResponse:
        status_code = 200
        text = ""

        def raise_for_status(self) -> None:
            return None

        def iter_lines(self):
            frames = [
                {"type": "response.output_text.delta", "delta": "先读取"},
                {
                    "type": "response.output_item.done",
                    "item": {
                        "type": "function_call",
                        "call_id": "call-1",
                        "name": "search_kb_candidates",
                        "arguments": '{"query":"第六题"}',
                    },
                },
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp-123",
                        "usage": {"total_tokens": 88},
                    },
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
        stream, result = client.responses_with_tools_stream(
            [{"role": "user", "content": "第六题是什么"}],
            tools=[],
            return_events=True,
        )
        events = list(stream)
    finally:
        config_module.get_settings.cache_clear()

    assert any(event.get("type") == "delta" for event in events)
    assert "".join(result["content_parts"]) == "先读取"
    assert result["response_id"] == "resp-123"
    assert result["usage"] == 88
    assert result["tool_calls"][0]["function"]["name"] == "search_kb_candidates"


def test_qwen_responses_stream_normalizes_role_messages_to_message_input(monkeypatch) -> None:
    from app import config as config_module
    from app.services.qwen_client import QwenClient

    captured: dict[str, object] = {}

    class _FakeResponse:
        status_code = 200
        text = ""

        def raise_for_status(self) -> None:
            return None

        def iter_lines(self):
            yield f"data: {json.dumps({'type': 'response.completed', 'response': {'id': 'resp-1', 'usage': {'total_tokens': 1}}}, ensure_ascii=False)}".encode("utf-8")
            yield b"data: [DONE]"

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    def _fake_post(*args, **kwargs):
        captured["json"] = kwargs.get("json")
        return _FakeResponse()

    monkeypatch.setenv("ALIBABA_API_KEY", "test-key")
    config_module.get_settings.cache_clear()
    try:
        client = QwenClient()
        monkeypatch.setattr("app.services.qwen_client.requests.post", _fake_post)
        stream, _result = client.responses_with_tools_stream(
            [
                {"role": "system", "content": [{"type": "text", "text": "policy"}]},
                {"role": "user", "content": [{"type": "text", "text": "question"}]},
                {"type": "function_call_output", "call_id": "call-1", "output": '{"ok":true}'},
            ],
            tools=[],
            return_events=True,
        )
        list(stream)
    finally:
        config_module.get_settings.cache_clear()

    payload = captured["json"]
    assert isinstance(payload, dict)
    input_items = payload["input"]
    assert input_items[0]["type"] == "message"
    assert input_items[0]["role"] == "system"
    assert input_items[0]["content"] == "policy"
    assert input_items[1]["type"] == "message"
    assert input_items[1]["content"] == [{"type": "text", "text": "question"}]
    assert input_items[2]["type"] == "function_call_output"


def test_qwen_responses_stream_converts_tool_role_messages_to_function_call_output(monkeypatch) -> None:
    from app import config as config_module
    from app.services.qwen_client import QwenClient

    captured: dict[str, object] = {}

    class _FakeResponse:
        status_code = 200
        text = ""

        def raise_for_status(self) -> None:
            return None

        def iter_lines(self):
            yield f"data: {json.dumps({'type': 'response.completed', 'response': {'id': 'resp-tool', 'usage': {'total_tokens': 1}}}, ensure_ascii=False)}".encode("utf-8")
            yield b"data: [DONE]"

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    def _fake_post(*args, **kwargs):
        captured["json"] = kwargs.get("json")
        return _FakeResponse()

    monkeypatch.setenv("ALIBABA_API_KEY", "test-key")
    config_module.get_settings.cache_clear()
    try:
        client = QwenClient()
        monkeypatch.setattr("app.services.qwen_client.requests.post", _fake_post)
        stream, _result = client.responses_with_tools_stream(
            [
                {
                    "role": "tool",
                    "tool_call_id": "call-tool-1",
                    "content": [{"type": "text", "text": '{"recent_observation":true}'}],
                }
            ],
            tools=[],
            return_events=True,
        )
        list(stream)
    finally:
        config_module.get_settings.cache_clear()

    payload = captured["json"]
    assert isinstance(payload, dict)
    input_items = payload["input"]
    assert input_items == [
        {
            "type": "function_call_output",
            "call_id": "call-tool-1",
            "output": '{"recent_observation":true}',
        }
    ]


def test_qwen_responses_stream_expands_assistant_tool_calls_to_function_calls(monkeypatch) -> None:
    from app import config as config_module
    from app.services.qwen_client import QwenClient

    captured: dict[str, object] = {}

    class _FakeResponse:
        status_code = 200
        text = ""

        def raise_for_status(self) -> None:
            return None

        def iter_lines(self):
            yield f"data: {json.dumps({'type': 'response.completed', 'response': {'id': 'resp-fc', 'usage': {'total_tokens': 1}}}, ensure_ascii=False)}".encode("utf-8")
            yield b"data: [DONE]"

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    def _fake_post(*args, **kwargs):
        captured["json"] = kwargs.get("json")
        return _FakeResponse()

    monkeypatch.setenv("ALIBABA_API_KEY", "test-key")
    config_module.get_settings.cache_clear()
    try:
        client = QwenClient()
        monkeypatch.setattr("app.services.qwen_client.requests.post", _fake_post)
        stream, _result = client.responses_with_tools_stream(
            [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-tool-1",
                            "type": "function",
                            "function": {"name": "search_kb_candidates", "arguments": '{"query":"q"}'},
                        }
                    ],
                }
            ],
            tools=[],
            return_events=True,
        )
        list(stream)
    finally:
        config_module.get_settings.cache_clear()

    payload = captured["json"]
    assert isinstance(payload, dict)
    assert payload["input"] == [
        {
            "type": "function_call",
            "call_id": "call-tool-1",
            "name": "search_kb_candidates",
            "arguments": '{"query":"q"}',
        }
    ]


def test_qwen_responses_stream_preserves_user_multimodal_content(monkeypatch) -> None:
    from app import config as config_module
    from app.services.qwen_client import QwenClient

    captured: dict[str, object] = {}

    class _FakeResponse:
        status_code = 200
        text = ""

        def raise_for_status(self) -> None:
            return None

        def iter_lines(self):
            yield f"data: {json.dumps({'type': 'response.completed', 'response': {'id': 'resp-mm', 'usage': {'total_tokens': 1}}}, ensure_ascii=False)}".encode("utf-8")
            yield b"data: [DONE]"

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    def _fake_post(*args, **kwargs):
        captured["json"] = kwargs.get("json")
        return _FakeResponse()

    monkeypatch.setenv("ALIBABA_API_KEY", "test-key")
    config_module.get_settings.cache_clear()
    try:
        client = QwenClient()
        monkeypatch.setattr("app.services.qwen_client.requests.post", _fake_post)
        stream, _result = client.responses_with_tools_stream(
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": '{"working_set":true}'},
                        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AAAA"}},
                    ],
                }
            ],
            tools=[],
            return_events=True,
        )
        list(stream)
    finally:
        config_module.get_settings.cache_clear()

    payload = captured["json"]
    assert isinstance(payload, dict)
    input_items = payload["input"]
    assert input_items[0]["type"] == "message"
    assert input_items[0]["role"] == "user"
    assert isinstance(input_items[0]["content"], list)
    assert input_items[0]["content"][0] == {"type": "text", "text": '{"working_set":true}'}
    assert input_items[0]["content"][1] == {"type": "input_image", "image_url": "data:image/jpeg;base64,AAAA"}


def test_qwen_responses_stream_sanitizes_tool_schema_and_parses_data_prefix(monkeypatch) -> None:
    from app import config as config_module
    from app.services.qwen_client import QwenClient

    captured: dict[str, object] = {}

    class _FakeResponse:
        status_code = 200
        text = ""

        def raise_for_status(self) -> None:
            return None

        def iter_lines(self):
            frames = [
                {"type": "response.created", "response": {"id": "resp-1"}},
                {
                    "type": "response.completed",
                    "response": {"id": "resp-1", "usage": {"total_tokens": 2}},
                },
            ]
            for frame in frames:
                yield f"data:{json.dumps(frame, ensure_ascii=False)}".encode("utf-8")
            yield b"data:[DONE]"

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    def _fake_post(*args, **kwargs):
        captured["json"] = kwargs.get("json")
        return _FakeResponse()

    monkeypatch.setenv("ALIBABA_API_KEY", "test-key")
    config_module.get_settings.cache_clear()
    try:
        client = QwenClient()
        monkeypatch.setattr("app.services.qwen_client.requests.post", _fake_post)
        stream, result = client.responses_with_tools_stream(
            [{"role": "user", "content": "question"}],
            tools=[
                {
                    "type": "function",
                    "function": {
                        "name": "request_user_clarification",
                        "parameters": {
                            "properties": {
                                "prompt": {"type": "string"},
                                "default": {},
                            }
                        },
                    },
                }
            ],
            return_events=True,
        )
        list(stream)
    finally:
        config_module.get_settings.cache_clear()

    payload = captured["json"]
    assert isinstance(payload, dict)
    assert payload["tools"][0]["type"] == "function"
    assert payload["tools"][0]["name"] == "request_user_clarification"
    params = payload["tools"][0]["parameters"]
    assert params["type"] == "object"
    assert "default" not in params["properties"]
    assert result["response_id"] == "resp-1"


def test_qwen_responses_stream_sanitizes_nested_array_items_for_tools(monkeypatch) -> None:
    from app import config as config_module
    from app.services.qwen_client import QwenClient

    captured: dict[str, object] = {}

    class _FakeResponse:
        status_code = 200
        text = ""

        def raise_for_status(self) -> None:
            return None

        def iter_lines(self):
            frames = [
                {"type": "response.created", "response": {"id": "resp-2"}},
                {
                    "type": "response.completed",
                    "response": {"id": "resp-2", "usage": {"total_tokens": 2}},
                },
            ]
            for frame in frames:
                yield f"data:{json.dumps(frame, ensure_ascii=False)}".encode("utf-8")
            yield b"data:[DONE]"

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    def _fake_post(*args, **kwargs):
        captured["json"] = kwargs.get("json")
        return _FakeResponse()

    monkeypatch.setenv("ALIBABA_API_KEY", "test-key")
    config_module.get_settings.cache_clear()
    try:
        client = QwenClient()
        monkeypatch.setattr("app.services.qwen_client.requests.post", _fake_post)
        stream, result = client.responses_with_tools_stream(
            [{"role": "user", "content": "question"}],
            tools=[
                {
                    "type": "function",
                    "function": {
                        "name": "request_user_clarification",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "fields": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "options": {"type": "array"},
                                        },
                                    },
                                },
                            },
                        },
                    },
                }
            ],
            return_events=True,
        )
        list(stream)
    finally:
        config_module.get_settings.cache_clear()

    payload = captured["json"]
    assert isinstance(payload, dict)
    options_schema = payload["tools"][0]["parameters"]["properties"]["fields"]["items"]["properties"]["options"]
    assert options_schema["type"] == "array"
    assert options_schema["items"] == {"type": "string"}
    assert result["response_id"] == "resp-2"


def test_qwen_responses_stream_flattens_chat_tool_shape_to_responses_tool_shape(monkeypatch) -> None:
    from app import config as config_module
    from app.services.qwen_client import QwenClient

    captured: dict[str, object] = {}

    class _FakeResponse:
        status_code = 200
        text = ""

        def raise_for_status(self) -> None:
            return None

        def iter_lines(self):
            frames = [
                {"type": "response.created", "response": {"id": "resp-3"}},
                {"type": "response.completed", "response": {"id": "resp-3", "usage": {"total_tokens": 1}}},
            ]
            for frame in frames:
                yield f"data:{json.dumps(frame, ensure_ascii=False)}".encode("utf-8")
            yield b"data:[DONE]"

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    def _fake_post(*args, **kwargs):
        captured["json"] = kwargs.get("json")
        return _FakeResponse()

    monkeypatch.setenv("ALIBABA_API_KEY", "test-key")
    config_module.get_settings.cache_clear()
    try:
        client = QwenClient()
        monkeypatch.setattr("app.services.qwen_client.requests.post", _fake_post)
        stream, _result = client.responses_with_tools_stream(
            [{"role": "user", "content": "question"}],
            tools=[
                {
                    "type": "function",
                    "function": {
                        "name": "search_available_actions",
                        "description": "desc",
                        "parameters": {
                            "type": "object",
                            "properties": {"goal": {"type": "string"}},
                            "additionalProperties": False,
                        },
                    },
                }
            ],
            return_events=True,
        )
        list(stream)
    finally:
        config_module.get_settings.cache_clear()

    payload = captured["json"]
    assert isinstance(payload, dict)
    tool = payload["tools"][0]
    assert tool == {
        "type": "function",
        "name": "search_available_actions",
        "description": "desc",
        "parameters": {
            "type": "object",
            "properties": {"goal": {"type": "string"}},
            "additionalProperties": False,
        },
    }
