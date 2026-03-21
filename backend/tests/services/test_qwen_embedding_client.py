from __future__ import annotations

from typing import Any

import pytest
import requests


def _reset_settings_cache() -> None:
    from app.config import get_settings

    get_settings.cache_clear()


def test_embedding_client_splits_batch_by_provider_limit(monkeypatch: Any) -> None:
    from app.services import qwen_client

    monkeypatch.setenv("ALIBABA_API_KEY", "test-key")
    monkeypatch.setenv("ALIBABA_MODEL_EMBEDDING", "tongyi-embedding-vision-flash")
    _reset_settings_cache()

    calls: list[dict[str, Any]] = []

    class OkResp:
        status_code = 200
        text = '{"ok":true}'

        def __init__(self, payload: dict[str, Any]) -> None:
            self._payload = payload

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, Any]:
            input_obj = self._payload.get("input")
            contents = input_obj.get("contents") if isinstance(input_obj, dict) else []
            return {
                "output": {
                    "embeddings": [
                        {"text_index": i, "embedding": [float(i + 1)]}
                        for i, _ in enumerate(contents or [])
                    ]
                }
            }

    def _fake_post(*_args: Any, **kwargs: Any) -> OkResp:
        payload = dict(kwargs.get("json") or {})
        calls.append(payload)
        return OkResp(payload)

    monkeypatch.setattr(qwen_client.requests, "post", _fake_post)

    client = qwen_client.QwenEmbeddingClient()
    vectors = client.embed([f"q{i}" for i in range(11)])

    assert len(vectors) == 11
    assert len(calls) == 2
    assert isinstance(calls[0].get("input"), dict)
    assert len(calls[0]["input"]["contents"]) == 10
    assert len(calls[1]["input"]["contents"]) == 1


def test_embedding_client_retries_transient_http_errors(monkeypatch: Any) -> None:
    from app.services import qwen_client

    monkeypatch.setenv("ALIBABA_API_KEY", "test-key")
    monkeypatch.setenv("ALIBABA_MODEL_EMBEDDING", "tongyi-embedding-vision-flash")
    _reset_settings_cache()

    attempts = {"count": 0}

    class RetryResp:
        status_code = 429
        text = '{"error":"rate_limited"}'

        def raise_for_status(self) -> None:
            raise requests.HTTPError("rate limited", response=self)  # type: ignore[arg-type]

        def json(self) -> dict[str, Any]:
            return {"data": []}

    class OkResp:
        status_code = 200
        text = '{"ok":true}'

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, Any]:
            return {"output": {"embeddings": [{"text_index": 0, "embedding": [0.1, 0.2, 0.3]}]}}

    def _fake_post(*_args: Any, **_kwargs: Any) -> Any:
        attempts["count"] += 1
        if attempts["count"] == 1:
            return RetryResp()
        return OkResp()

    monkeypatch.setattr(qwen_client.requests, "post", _fake_post)
    monkeypatch.setattr(qwen_client.time, "sleep", lambda _seconds: None)

    client = qwen_client.QwenEmbeddingClient()
    vectors = client.embed(["hello"])

    assert attempts["count"] == 2
    assert vectors == [[0.1, 0.2, 0.3]]


def test_embedding_client_does_not_retry_bad_request(monkeypatch: Any) -> None:
    from app.services import qwen_client

    monkeypatch.setenv("ALIBABA_API_KEY", "test-key")
    monkeypatch.setenv("ALIBABA_MODEL_EMBEDDING", "tongyi-embedding-vision-flash")
    _reset_settings_cache()

    attempts = {"count": 0}

    class BadResp:
        status_code = 400
        text = '{"code":"InvalidParameter"}'

        def raise_for_status(self) -> None:
            raise requests.HTTPError("bad request", response=self)  # type: ignore[arg-type]

        def json(self) -> dict[str, Any]:
            return {"data": []}

    def _fake_post(*_args: Any, **_kwargs: Any) -> Any:
        attempts["count"] += 1
        return BadResp()

    monkeypatch.setattr(qwen_client.requests, "post", _fake_post)

    client = qwen_client.QwenEmbeddingClient()
    with pytest.raises(qwen_client.QwenRequestError):
        client.embed(["hello"])

    assert attempts["count"] == 1


def test_embedding_client_multimodal_payload_accepts_image_inputs(monkeypatch: Any) -> None:
    from app.services import qwen_client

    monkeypatch.setenv("ALIBABA_API_KEY", "test-key")
    monkeypatch.setenv("ALIBABA_MODEL_EMBEDDING", "tongyi-embedding-vision-flash")
    _reset_settings_cache()

    calls: list[dict[str, Any]] = []

    class OkResp:
        status_code = 200
        text = '{"ok":true}'

        def __init__(self, payload: dict[str, Any]) -> None:
            self._payload = payload

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, Any]:
            input_obj = self._payload.get("input")
            contents = input_obj.get("contents") if isinstance(input_obj, dict) else []
            return {
                "output": {
                    "embeddings": [
                        {"text_index": idx, "embedding": [float(idx + 1), 0.5]}
                        for idx, _item in enumerate(contents or [])
                    ]
                }
            }

    def _fake_post(*_args: Any, **kwargs: Any) -> OkResp:
        payload = dict(kwargs.get("json") or {})
        calls.append(payload)
        return OkResp(payload)

    monkeypatch.setattr(qwen_client.requests, "post", _fake_post)

    client = qwen_client.QwenEmbeddingClient()
    vectors = client.embed(
        [
            {"text": "query about diagram"},
            {"image": "data:image/png;base64,AAAA"},
        ]
    )

    assert len(vectors) == 2
    assert len(calls) == 1
    input_obj = calls[0].get("input")
    assert isinstance(input_obj, dict)
    contents = input_obj.get("contents")
    assert isinstance(contents, list) and len(contents) == 2
    assert contents[0] == {"text": "query about diagram"}
    assert contents[1] == {"image": "data:image/png;base64,AAAA"}


def test_embedding_client_allows_text_only_with_multimodal_model(monkeypatch: Any) -> None:
    from app.services import qwen_client

    monkeypatch.setenv("ALIBABA_API_KEY", "test-key")
    monkeypatch.setenv("ALIBABA_MODEL_EMBEDDING", "tongyi-embedding-vision-flash")
    _reset_settings_cache()

    class OkResp:
        status_code = 200
        text = '{"ok":true}'

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, Any]:
            return {"output": {"embeddings": [{"text_index": 0, "embedding": [0.4, 0.5]}]}}

    monkeypatch.setattr(qwen_client.requests, "post", lambda *_args, **_kwargs: OkResp())

    client = qwen_client.QwenEmbeddingClient()
    vectors = client.embed(["plain text retrieval query"])
    assert vectors == [[0.4, 0.5]]


def test_embedding_client_rejects_text_only_embedding_model(monkeypatch: Any) -> None:
    from app.services import qwen_client

    monkeypatch.setenv("ALIBABA_API_KEY", "test-key")
    monkeypatch.setenv("ALIBABA_MODEL_EMBEDDING", "qwen-plus")
    _reset_settings_cache()

    with pytest.raises(RuntimeError) as exc_info:
        qwen_client.QwenEmbeddingClient()
    assert "must be a multimodal model" in str(exc_info.value)

