from typing import Any, Dict, Generator, Iterable, List, Tuple

import base64
import copy
import json
import logging
import mimetypes
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse, urlunparse

import requests

from ..config import get_settings
from ..provider_schema import validate_provider_schema
from .assets import AssetResolver


text_logger = logging.getLogger("agent.qwen")
embedding_logger = logging.getLogger("agent.embedding")


_MAX_LOG_PAYLOAD_CHARS = 6000
_EXPLICIT_CACHE_MAX_MARKERS = 4
_MAX_LOG_STRING_CHARS = 240
_EXPLICIT_CACHE_ROLES = {"system", "user", "assistant", "tool"}
_RESPONSES_MESSAGE_ROLES = {"system", "user", "assistant"}
_DASHSCOPE_SESSION_CACHE_HEADER = "x-dashscope-session-cache"


def _normalize_base_url(base_url: str) -> str:
    raw = (base_url or "").strip()
    if not raw:
        raise ValueError("ALIBABA_BASE_URL is empty")
    if "://" not in raw:
        raw = f"https://{raw}"
    parsed = urlparse(raw)
    if not parsed.netloc:
        tmp = parsed.path.lstrip("/")
        if parsed.path.startswith("//"):
            tmp = parsed.path[2:]
        parts = tmp.split("/", 1)
        netloc = parts[0]
        rest = parts[1] if len(parts) > 1 else ""
        parsed = parsed._replace(netloc=netloc, path=f"/{rest}" if rest else "")
    normalized_path = parsed.path.rstrip("/")
    parsed = parsed._replace(path=normalized_path)
    return urlunparse(parsed)


def _build_dashscope_url(base_url: str, path: str) -> str:
    base = _normalize_base_url(base_url).rstrip("/") + "/"
    rel = path.lstrip("/")
    return urljoin(base, rel)


def _redact_payload_for_log(payload: Any) -> Any:
    return QwenClient._redact_payload_for_log(payload)


class QwenRequestError(RuntimeError):
    """Raised when DashScope request fails, optionally carrying raw response text."""

    def __init__(self, message: str, *, response_text: str | None = None) -> None:
        super().__init__(message)
        self.response_text = response_text


class QwenClient:
    """
    Thin wrapper for DashScope (Qwen Plus) chat completions.
    """

    def __init__(
        self,
        *,
        model: str | None = None,
        max_output_tokens: int | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
        session_id: str | None = None,
    ) -> None:
        settings = get_settings()
        resolved_api_key = str(api_key or settings.alibaba_api_key or "").strip()
        if not resolved_api_key:
            raise RuntimeError("ALIBABA_API_KEY is not configured")
        self.base_url = str(base_url or settings.alibaba_base_url).rstrip("/")
        if "integrate.api.nvidia.com" in self.base_url.lower():
            self._chat_path = "chat/completions"
            self._files_path = "files"
            self._responses_path = None
        else:
            self._chat_path = "compatible-mode/v1/chat/completions"
            self._files_path = "compatible-mode/v1/files"
            self._responses_path = "compatible-mode/v1/responses"
        self.api_key = resolved_api_key
        self.model = model or settings.alibaba_model_qwen_plus
        self.max_output_tokens = max_output_tokens
        self.session_id = str(session_id or "").strip() or None
        self._last_usage_total_tokens: int | None = None
        self._explicit_cache_enabled = bool(getattr(settings, "alibaba_explicit_cache_enabled", False))
        self._session_cache_enabled = bool(getattr(settings, "alibaba_session_cache_enabled", False))
        self._enable_thinking = bool(getattr(settings, "alibaba_enable_thinking", False))
        self._thinking_budget = int(getattr(settings, "alibaba_thinking_budget", 0) or 0)

    def _is_explicit_cache_supported_model(self) -> bool:
        model_name = (self.model or "").strip().lower()
        if not model_name:
            return False
        return model_name in {
            "qwen-flash",
            "qwen3.5-flash",
            "qwen-plus",
            "qwen3.5-plus",
            "qwen-max",
            "qwen3-max",
        }

    def _build_headers(self, *, json_content: bool = True) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
        }
        if json_content:
            headers["Content-Type"] = "application/json"
        if self._session_cache_enabled and self._is_explicit_cache_supported_model():
            headers[_DASHSCOPE_SESSION_CACHE_HEADER] = "enable"
        if self.session_id:
            headers["X-Agent-Session-Id"] = self.session_id
        return headers

    def supports_responses_api(self) -> bool:
        return isinstance(self._responses_path, str) and bool(self._responses_path.strip())

    @staticmethod
    def _redact_payload_for_log(payload: Any) -> Any:
        if isinstance(payload, dict):
            redacted: dict[str, Any] = {}
            for key, value in payload.items():
                if key == "url" and isinstance(value, str) and value.startswith("data:image/"):
                    redacted[key] = f"<redacted-data-url len={len(value)}>"
                    continue
                if key == "image_url" and isinstance(value, str) and value.startswith("data:image/"):
                    redacted[key] = f"<redacted-data-url len={len(value)}>"
                    continue
                redacted[str(key)] = QwenClient._redact_payload_for_log(value)
            return redacted
        if isinstance(payload, list):
            return [QwenClient._redact_payload_for_log(item) for item in payload]
        return payload

    @staticmethod
    def _summarize_multimodal_messages(messages: list[dict[str, Any]] | None) -> dict[str, Any]:
        summary: dict[str, Any] = {
            "multimodal_message_count": 0,
            "image_part_count": 0,
            "messages_with_images_by_role": {},
        }
        by_role = summary["messages_with_images_by_role"]
        for item in messages or []:
            if not isinstance(item, dict):
                continue
            role = str(item.get("role") or "unknown").strip().lower() or "unknown"
            content = item.get("content")
            if not isinstance(content, list):
                continue
            image_parts = 0
            for part in content:
                if not isinstance(part, dict):
                    continue
                if str(part.get("type") or "").strip().lower() in {"image_url", "input_image"}:
                    image_parts += 1
            if image_parts <= 0:
                continue
            summary["multimodal_message_count"] = int(summary["multimodal_message_count"]) + 1
            summary["image_part_count"] = int(summary["image_part_count"]) + image_parts
            by_role[role] = int(by_role.get(role) or 0) + 1
        return summary

    def _inject_explicit_cache_markers(self, messages: List[dict]) -> List[dict]:
        if not self._explicit_cache_enabled or not self._is_explicit_cache_supported_model():
            return messages

        prepared: List[dict] = []
        markers_used = 0
        for msg in messages:
            if not isinstance(msg, dict):
                prepared.append(msg)
                continue

            cloned = dict(msg)
            role = str(cloned.get("role") or "").strip().lower()
            content = cloned.get("content")
            if (
                role in _EXPLICIT_CACHE_ROLES
                and markers_used < _EXPLICIT_CACHE_MAX_MARKERS
                and self._should_auto_cache_mark_message(cloned)
            ):
                content, markers_used = self._cache_mark_message_content(content, markers_used)
                cloned["content"] = content
            prepared.append(cloned)
        return prepared

    @staticmethod
    def _extract_primary_text(content: Any) -> str:
        if isinstance(content, str):
            return content.strip()
        if not isinstance(content, list):
            return ""
        texts: list[str] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            if str(item.get("type") or "text").strip().lower() != "text":
                continue
            text = str(item.get("text") or "").strip()
            if text:
                texts.append(text)
        return "\n".join(texts).strip()

    @classmethod
    def _should_auto_cache_mark_message(cls, message: dict[str, Any]) -> bool:
        role = str(message.get("role") or "").strip().lower()
        if role != "system":
            return False
        primary_text = cls._extract_primary_text(message.get("content"))
        if not primary_text:
            return False
        return not primary_text.startswith("[")

    @staticmethod
    def _cache_mark_message_content(content: Any, markers_used: int) -> tuple[Any, int]:
        if markers_used >= _EXPLICIT_CACHE_MAX_MARKERS:
            return content, markers_used

        if isinstance(content, str):
            if not content.strip():
                return content, markers_used
            return (
                [
                    {
                        "type": "text",
                        "text": content,
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
                markers_used + 1,
            )

        if not isinstance(content, list):
            return content, markers_used

        updated: list[Any] = []
        used = markers_used
        for part in content:
            if not isinstance(part, dict):
                updated.append(part)
                continue
            cloned_part = dict(part)
            if (
                used < _EXPLICIT_CACHE_MAX_MARKERS
                and str(cloned_part.get("type") or "text").strip().lower() == "text"
                and isinstance(cloned_part.get("text"), str)
                and str(cloned_part.get("text") or "").strip()
                and not isinstance(cloned_part.get("cache_control"), dict)
            ):
                cloned_part["cache_control"] = {"type": "ephemeral"}
                used += 1
            updated.append(cloned_part)
        return updated, used

    def _apply_thinking_options(self, payload: dict) -> None:
        if not self._enable_thinking:
            return
        payload["enable_thinking"] = True
        if self._thinking_budget > 0:
            payload["thinking_budget"] = self._thinking_budget

    @staticmethod
    def _extract_thinking_from_delta(delta: dict) -> str | None:
        for key in (
            "thinking",
            "thinking_content",
            "reasoning",
            "reasoning_content",
        ):
            value = delta.get(key)
            if isinstance(value, str) and value:
                return value
        return None

    @staticmethod
    def _split_content_parts(content_raw: Any) -> tuple[str, str]:
        if not isinstance(content_raw, list):
            return "", ""
        content_parts: list[str] = []
        thinking_parts: list[str] = []
        for part in content_raw:
            if not isinstance(part, dict):
                continue
            text = part.get("text")
            if not isinstance(text, str) or not text:
                continue
            part_type = str(part.get("type") or "text").strip().lower()
            if part_type in ("thinking", "reasoning"):
                thinking_parts.append(text)
            else:
                content_parts.append(text)
        return "".join(content_parts).strip(), "".join(thinking_parts).strip()

    @staticmethod
    def _extract_cache_usage(usage_obj: dict) -> tuple[int | None, int | None]:
        prompt_details = usage_obj.get("prompt_tokens_details") or {}
        if not isinstance(prompt_details, dict):
            prompt_details = {}

        cached_tokens = prompt_details.get("cached_tokens")
        cache_creation_tokens = prompt_details.get("cache_creation_input_tokens")

        if not isinstance(cached_tokens, int):
            cached_tokens = None
        if not isinstance(cache_creation_tokens, int):
            cache_creation_tokens = None
        return cached_tokens, cache_creation_tokens

    def _log_payload(self, label: str, payload: dict) -> None:
        try:
            serialized = json.dumps(self._redact_payload_for_log(payload), ensure_ascii=False)
        except TypeError:
            serialized = str(payload)

        preview = serialized
        if len(preview) > _MAX_LOG_PAYLOAD_CHARS:
            preview = preview[:_MAX_LOG_PAYLOAD_CHARS] + f" ...[truncated {len(serialized) - _MAX_LOG_PAYLOAD_CHARS} chars]"

        multimodal_source = None
        if isinstance(payload, dict):
            if isinstance(payload.get("messages"), list):
                multimodal_source = payload.get("messages")
            elif isinstance(payload.get("input"), list):
                multimodal_source = payload.get("input")
        multimodal_summary = self._summarize_multimodal_messages(multimodal_source)
        text_logger.info(
            "qwen.payload label=%s session_id=%s length=%s multimodal=%s payload=%s",
            label,
            self.session_id,
            len(serialized),
            multimodal_summary,
            preview,
        )

    def _inject_explicit_cache_markers_into_input(self, input_items: List[dict]) -> List[dict]:
        if not isinstance(input_items, list):
            return input_items
        patched: list[dict] = []
        markers_used = 0
        for item in input_items:
            if not isinstance(item, dict):
                patched.append(item)
                continue
            role = str(item.get("role") or "").strip().lower()
            if (
                role in _EXPLICIT_CACHE_ROLES
                and markers_used < _EXPLICIT_CACHE_MAX_MARKERS
                and self._should_auto_cache_mark_message(item)
            ):
                cloned = dict(item)
                content, markers_used = self._cache_mark_message_content(cloned.get("content"), markers_used)
                cloned["content"] = content
                patched.append(cloned)
                continue
            patched.append(item)
        return patched

    @staticmethod
    def _flatten_message_content_to_string(content: Any) -> str:
        if isinstance(content, str):
            return content
        if not isinstance(content, list):
            return str(content or "")
        text_parts: list[str] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            part_type = str(part.get("type") or "").strip().lower()
            if part_type != "text":
                continue
            text = str(part.get("text") or "")
            if text:
                text_parts.append(text)
        return "\n".join(text_parts).strip()

    @staticmethod
    def _normalize_user_content_parts_for_responses(content: Any) -> list[dict[str, Any]] | str:
        if isinstance(content, str):
            return content
        if not isinstance(content, list):
            return str(content or "")
        normalized_parts: list[dict[str, Any]] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            part_type = str(part.get("type") or "").strip().lower()
            if part_type == "text":
                text = str(part.get("text") or "")
                if text:
                    normalized_parts.append({"type": "text", "text": text})
                continue
            if part_type == "image_url":
                raw_value = part.get("image_url")
                if isinstance(raw_value, dict):
                    raw_value = raw_value.get("url")
                url = str(raw_value or "").strip()
                if url:
                    normalized_parts.append({"type": "input_image", "image_url": url})
                continue
            if part_type == "input_image":
                url = str(part.get("image_url") or "").strip()
                if url:
                    normalized_parts.append({"type": "input_image", "image_url": url})
        if normalized_parts:
            return normalized_parts
        return QwenClient._flatten_message_content_to_string(content)

    def _normalize_responses_input_items(self, input_items: List[dict]) -> List[dict]:
        normalized: list[dict] = []
        for item in input_items:
            if not isinstance(item, dict):
                continue
            item_type = str(item.get("type") or "").strip().lower()
            if item_type == "function_call":
                normalized_call = self._normalize_responses_function_call_item(item)
                if normalized_call:
                    normalized.append(normalized_call)
                continue
            if item_type == "function_call_output":
                normalized.append(
                    {
                        "type": "function_call_output",
                        "call_id": str(item.get("call_id") or "").strip(),
                        "output": str(item.get("output") or ""),
                    }
                )
                continue
            role = str(item.get("role") or "").strip().lower()
            if role == "tool":
                normalized_output = self._normalize_responses_tool_message(item)
                if normalized_output:
                    normalized.append(normalized_output)
                continue
            if role in _RESPONSES_MESSAGE_ROLES:
                assistant_tool_calls = item.get("tool_calls") if isinstance(item.get("tool_calls"), list) else []
                if role == "assistant" and assistant_tool_calls:
                    content = self._flatten_message_content_to_string(item.get("content"))
                    if content:
                        normalized.append(
                            {
                                "type": "message",
                                "role": "assistant",
                                "content": content,
                            }
                        )
                    for tool_call in assistant_tool_calls:
                        normalized_call = self._normalize_responses_function_call_item(tool_call)
                        if normalized_call:
                            normalized.append(normalized_call)
                    continue
                if role == "user":
                    content = self._normalize_user_content_parts_for_responses(item.get("content"))
                else:
                    content = self._flatten_message_content_to_string(item.get("content"))
                normalized.append(
                    {
                        "type": "message",
                        "role": role,
                        "content": content,
                    }
                )
                continue
            raise ValueError(f"unsupported_responses_input_item: {item_type or role or '<unknown>'}")
        return normalized

    @staticmethod
    def _normalize_responses_function_call_item(item: dict[str, Any]) -> dict[str, Any] | None:
        if not isinstance(item, dict):
            return None
        if str(item.get("type") or "").strip().lower() == "function_call":
            call_id = str(item.get("call_id") or item.get("id") or "").strip()
            name = str(item.get("name") or "").strip()
            arguments = item.get("arguments")
        else:
            call_id = str(item.get("id") or "").strip()
            function = item.get("function") if isinstance(item.get("function"), dict) else {}
            name = str(function.get("name") or "").strip()
            arguments = function.get("arguments")
        if not call_id or not name:
            return None
        if isinstance(arguments, dict):
            arguments = json.dumps(arguments, ensure_ascii=False)
        return {
            "type": "function_call",
            "call_id": call_id,
            "name": name,
            "arguments": str(arguments or ""),
        }

    @classmethod
    def _normalize_responses_tool_message(cls, item: dict[str, Any]) -> dict[str, Any]:
        call_id = str(item.get("tool_call_id") or item.get("call_id") or "").strip()
        if not call_id:
            raise ValueError("tool role message requires tool_call_id for Responses API")
        output = cls._flatten_message_content_to_string(item.get("content"))
        return {
            "type": "function_call_output",
            "call_id": call_id,
            "output": output,
        }

    @classmethod
    def _sanitize_json_schema_for_responses(cls, schema: Any) -> Any:
        if not isinstance(schema, dict):
            return schema
        if not schema:
            return {"type": "string"}

        cleaned: dict[str, Any] = {}
        for key, value in schema.items():
            if key == "default":
                continue
            if key in {"properties", "$defs", "definitions"} and isinstance(value, dict):
                sub: dict[str, Any] = {}
                for sub_key, sub_schema in value.items():
                    if sub_key == "default" and isinstance(sub_schema, dict) and not sub_schema:
                        continue
                    sanitized = cls._sanitize_json_schema_for_responses(sub_schema)
                    if isinstance(sanitized, dict) and sanitized:
                        sub[sub_key] = sanitized
                cleaned[key] = sub
                continue
            if key == "items":
                cleaned[key] = cls._sanitize_json_schema_for_responses(value)
                continue
            if key in {"anyOf", "oneOf", "allOf"} and isinstance(value, list):
                cleaned[key] = [cls._sanitize_json_schema_for_responses(item) for item in value if item]
                continue
            cleaned[key] = value

        if "properties" in cleaned and "type" not in cleaned:
            cleaned["type"] = "object"
        if cleaned.get("type") == "array" and "items" not in cleaned:
            cleaned["items"] = {"type": "string"}
        if "required" in cleaned and not cleaned.get("required"):
            cleaned.pop("required", None)
        if not cleaned:
            return {"type": "string"}
        return cleaned

    @classmethod
    def _normalize_responses_tools(cls, tools: List[dict]) -> List[dict]:
        normalized: list[dict] = []
        for tool in tools or []:
            if not isinstance(tool, dict):
                continue
            cloned = copy.deepcopy(tool)
            function = cloned.get("function") if isinstance(cloned.get("function"), dict) else None
            if not isinstance(function, dict):
                normalized.append(cloned)
                continue
            params = function.get("parameters")
            if isinstance(params, dict):
                params = cls._sanitize_json_schema_for_responses(params)
                errors = validate_provider_schema(params, path=f"tool:{function.get('name') or '<unknown>'}.parameters")
                if errors:
                    raise ValueError("; ".join(errors))
            normalized.append(
                {
                    "type": "function",
                    "name": str(function.get("name") or "").strip(),
                    "description": str(function.get("description") or "").strip(),
                    "parameters": params if isinstance(params, dict) else {"type": "object", "properties": {}, "additionalProperties": False},
                }
            )
        return normalized

    @staticmethod
    def _extract_responses_output_text(item: Any) -> str:
        if not isinstance(item, dict):
            return ""
        content = item.get("content")
        if not isinstance(content, list):
            return ""
        parts: list[str] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            part_type = str(part.get("type") or "").strip().lower()
            if part_type in {"output_text", "text"}:
                text = str(part.get("text") or "").strip()
                if text:
                    parts.append(text)
        return "".join(parts).strip()

    @staticmethod
    def _normalize_responses_tool_item(item: dict[str, Any]) -> dict[str, Any] | None:
        item_type = str(item.get("type") or "").strip().lower()
        if item_type not in {"function_call", "custom_tool_call"}:
            return None
        name = str(item.get("name") or "").strip()
        if not name:
            return None
        arguments = item.get("arguments")
        if isinstance(arguments, dict):
            args_text = json.dumps(arguments, ensure_ascii=False)
        else:
            args_text = str(arguments or "")
        return {
            "id": str(item.get("call_id") or item.get("id") or "").strip(),
            "type": "function",
            "function": {
                "name": name,
                "arguments": args_text,
            },
        }

    def chat(
        self,
        messages: List[dict],
        *,
        temperature: float = 0.2,
        top_p: float = 0.8,
        response_format: dict | None = None,
    ) -> Tuple[str, int | None]:
        url = _build_dashscope_url(self.base_url, self._chat_path)
        headers = self._build_headers()
        payload = {
            "model": self.model,
            "messages": self._inject_explicit_cache_markers(messages),
            "temperature": temperature,
            "top_p": top_p,
        }
        if response_format:
            payload["response_format"] = response_format
        self._apply_thinking_options(payload)
        if self.max_output_tokens is not None:
            payload["max_tokens"] = self.max_output_tokens
        start = time.perf_counter()
        self._log_payload("chat", payload)
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=300)
            resp.raise_for_status()
        except requests.HTTPError as exc:
            elapsed_ms = (time.perf_counter() - start) * 1000
            status = getattr(exc.response, "status_code", None) or resp.status_code
            body_preview = (resp.text or "")[:400]
            text_logger.exception(
                "qwen.chat http_error model=%s status=%s elapsed_ms=%.1f body=%s",
                self.model,
                status,
                elapsed_ms,
                body_preview,
            )
            raise QwenRequestError(
                f"Qwen request failed: status={resp.status_code}, body={resp.text}",
                response_text=resp.text,
            ) from exc
        except requests.RequestException as exc:
            elapsed_ms = (time.perf_counter() - start) * 1000
            text_logger.exception(
                "qwen.chat request_error model=%s elapsed_ms=%.1f", self.model, elapsed_ms
            )
            response_text = None
            if getattr(exc, "response", None) is not None:
                try:
                    response_text = exc.response.text  # type: ignore[attr-defined]
                except Exception:
                    response_text = None
            raise QwenRequestError(f"Qwen request error: {exc}", response_text=response_text) from exc

        data = resp.json()
        content: str = ""
        try:
            choice = data["choices"][0]
            message = choice["message"]
            content_raw = message.get("content", "")
            if isinstance(content_raw, list):
                content = "\n".join(
                    part.get("text", "") for part in content_raw if isinstance(part, dict)
                ).strip()
            else:
                content = str(content_raw).strip()
        except (KeyError, IndexError):
            content = str(data)

        usage_obj = data.get("usage") or {}
        usage = usage_obj.get("total_tokens")
        cached_tokens, cache_creation_tokens = self._extract_cache_usage(usage_obj)
        if isinstance(usage, int):
            self._last_usage_total_tokens = usage
        elapsed_ms = (time.perf_counter() - start) * 1000
        text_logger.info(
            "qwen.chat success model=%s tokens=%s cached_tokens=%s cache_creation_tokens=%s elapsed_ms=%.1f",
            self.model,
            usage,
            cached_tokens,
            cache_creation_tokens,
            elapsed_ms,
        )
        return content, usage

    def upload_file(self, file_path: str | Path, *, purpose: str = "file-extract") -> dict[str, Any]:
        path = Path(file_path).expanduser().resolve()
        if not path.exists() or not path.is_file():
            raise FileNotFoundError(f"Bailian upload file not found: {path}")

        url = _build_dashscope_url(self.base_url, self._files_path)
        headers = self._build_headers(json_content=False)
        files = {
            "file": (path.name, path.open("rb"), mimetypes.guess_type(path.name)[0] or "application/octet-stream"),
        }
        data = {"purpose": purpose}
        start = time.perf_counter()
        try:
            resp = requests.post(url, headers=headers, files=files, data=data, timeout=300)
            resp.raise_for_status()
        except requests.HTTPError as exc:
            elapsed_ms = (time.perf_counter() - start) * 1000
            text_logger.exception(
                "qwen.files.upload http_error path=%s status=%s elapsed_ms=%.1f body=%s",
                str(path),
                getattr(exc.response, "status_code", None) or getattr(resp, "status_code", None),
                elapsed_ms,
                (getattr(resp, "text", "") or "")[:400],
            )
            raise QwenRequestError(
                f"Qwen file upload failed: status={resp.status_code}, body={resp.text}",
                response_text=resp.text,
            ) from exc
        except requests.RequestException as exc:
            elapsed_ms = (time.perf_counter() - start) * 1000
            text_logger.exception("qwen.files.upload request_error path=%s elapsed_ms=%.1f", str(path), elapsed_ms)
            raise QwenRequestError(f"Qwen file upload request error: {exc}") from exc
        finally:
            files["file"][1].close()

        payload = resp.json()
        text_logger.info(
            "qwen.files.upload success path=%s purpose=%s file_id=%s elapsed_ms=%.1f",
            str(path),
            purpose,
            payload.get("id"),
            (time.perf_counter() - start) * 1000,
        )
        return payload

    def get_file(self, file_id: str) -> dict[str, Any]:
        url = _build_dashscope_url(self.base_url, f"{self._files_path}/{file_id}")
        headers = self._build_headers(json_content=False)
        try:
            resp = requests.get(url, headers=headers, timeout=60)
            resp.raise_for_status()
        except requests.HTTPError as exc:
            raise QwenRequestError(
                f"Qwen get file failed: status={resp.status_code}, body={resp.text}",
                response_text=resp.text,
            ) from exc
        except requests.RequestException as exc:
            raise QwenRequestError(f"Qwen get file request error: {exc}") from exc
        return resp.json()

    def delete_file(self, file_id: str) -> dict[str, Any]:
        url = _build_dashscope_url(self.base_url, f"{self._files_path}/{file_id}")
        headers = self._build_headers(json_content=False)
        try:
            resp = requests.delete(url, headers=headers, timeout=60)
            resp.raise_for_status()
        except requests.HTTPError as exc:
            raise QwenRequestError(
                f"Qwen delete file failed: status={resp.status_code}, body={resp.text}",
                response_text=resp.text,
            ) from exc
        except requests.RequestException as exc:
            raise QwenRequestError(f"Qwen delete file request error: {exc}") from exc
        return resp.json() if resp.content else {"id": file_id, "deleted": True}

    def chat_with_tools(
        self,
        messages: List[dict],
        *,
        tools: List[dict],
        tool_choice: str | dict = "auto",
        temperature: float = 0.2,
        top_p: float = 0.8,
    ) -> Tuple[str, List[dict], int | None]:
        url = _build_dashscope_url(self.base_url, self._chat_path)
        headers = self._build_headers()
        payload: dict = {
            "model": self.model,
            "messages": self._inject_explicit_cache_markers(messages),
            "temperature": temperature,
            "top_p": top_p,
            "tools": tools,
            "tool_choice": tool_choice,
        }
        self._apply_thinking_options(payload)
        if self.max_output_tokens is not None:
            payload["max_tokens"] = self.max_output_tokens
        start = time.perf_counter()
        self._log_payload("chat_with_tools", payload)
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=300)
            resp.raise_for_status()
        except requests.HTTPError as exc:
            elapsed_ms = (time.perf_counter() - start) * 1000
            status = getattr(exc.response, "status_code", None) or resp.status_code
            body_preview = (resp.text or "")[:400]
            text_logger.exception(
                "qwen.chat_tools http_error model=%s status=%s elapsed_ms=%.1f body=%s",
                self.model,
                status,
                elapsed_ms,
                body_preview,
            )
            raise QwenRequestError(
                f"Qwen tools request failed: status={resp.status_code}, body={resp.text}",
                response_text=resp.text,
            ) from exc
        except requests.RequestException as exc:
            elapsed_ms = (time.perf_counter() - start) * 1000
            text_logger.exception(
                "qwen.chat_tools request_error model=%s elapsed_ms=%.1f",
                self.model,
                elapsed_ms,
            )
            response_text = None
            if getattr(exc, "response", None) is not None:
                try:
                    response_text = exc.response.text  # type: ignore[attr-defined]
                except Exception:
                    response_text = None
            raise QwenRequestError(f"Qwen request error: {exc}", response_text=response_text) from exc

        data = resp.json()
        content: str = ""
        tool_calls: List[dict] = []
        try:
            choice = data["choices"][0]
            message = choice["message"]
            content_raw = message.get("content", "")
            if isinstance(content_raw, list):
                content = "\n".join(
                    part.get("text", "") for part in content_raw if isinstance(part, dict)
                ).strip()
            else:
                content = str(content_raw).strip()
            raw_tool_calls = message.get("tool_calls") or []
            if isinstance(raw_tool_calls, list):
                for tc in raw_tool_calls:
                    if isinstance(tc, dict):
                        tool_calls.append(tc)
        except (KeyError, IndexError):
            content = str(data)

        usage_obj = data.get("usage") or {}
        usage = usage_obj.get("total_tokens")
        cached_tokens, cache_creation_tokens = self._extract_cache_usage(usage_obj)
        if isinstance(usage, int):
            self._last_usage_total_tokens = usage
        elapsed_ms = (time.perf_counter() - start) * 1000
        text_logger.info(
            "qwen.chat_tools success model=%s tokens=%s cached_tokens=%s cache_creation_tokens=%s elapsed_ms=%.1f tool_calls=%s",
            self.model,
            usage,
            cached_tokens,
            cache_creation_tokens,
            elapsed_ms,
            len(tool_calls),
        )
        return content, tool_calls, usage

    def chat_with_tools_stream(
        self,
        messages: List[dict],
        *,
        tools: List[dict],
        tool_choice: str | dict = "auto",
        temperature: float = 0.2,
        top_p: float = 0.8,
        return_events: bool = False,
    ) -> tuple[Generator[Any, None, None], dict]:
        url = _build_dashscope_url(self.base_url, self._chat_path)
        headers = self._build_headers()
        payload: dict = {
            "model": self.model,
            "messages": self._inject_explicit_cache_markers(messages),
            "temperature": temperature,
            "top_p": top_p,
            "tools": tools,
            "tool_choice": tool_choice,
            "stream": True,
        }
        self._apply_thinking_options(payload)
        if self.max_output_tokens is not None:
            payload["max_tokens"] = self.max_output_tokens

        self._log_payload("chat_with_tools_stream", payload)
        result: dict = {"content_parts": [], "tool_calls": [], "thinking_parts": []}

        def gen() -> Generator[Any, None, None]:
            tool_calls_by_index: dict[int, dict] = {}
            saw_delta = False
            usage: int | None = None
            cached_tokens: int | None = None
            cache_creation_tokens: int | None = None
            with requests.post(
                url, headers=headers, json=payload, stream=True, timeout=300
            ) as resp:
                try:
                    resp.raise_for_status()
                except requests.HTTPError as exc:
                    raise QwenRequestError(
                        f"Qwen tools stream failed: status={resp.status_code}, body={resp.text}",
                        response_text=resp.text,
                    ) from exc

                for line in resp.iter_lines():
                    if not line:
                        continue
                    try:
                        text = line.decode("utf-8").strip()
                    except Exception:
                        # 解码失败时直接跳过该行，但保留后续行
                        continue
                    if not text:
                        continue
                    if text.startswith("data: "):
                        text = text[len("data: ") :].strip()
                    if text == "[DONE]":
                        break

                    # 解析单条 SSE payload；任何异常结构一律仅记录日志后跳过，
                    # 不改变上层对结果为空/非空的判断逻辑。
                    try:
                        data = json.loads(text)
                    except json.JSONDecodeError:
                        text_logger.warning(
                            "qwen.chat_tools_stream invalid_json line=%s", text[:400]
                        )
                        continue

                    if isinstance(data, dict) and data.get("error"):
                        err = data["error"]
                        code = None
                        message = None
                        if isinstance(err, dict):
                            code = err.get("code")
                            message = err.get("message") or err.get("msg")
                        if not message:
                            message = str(err)
                        text_logger.error(
                            "qwen.chat_tools_stream error_event code=%s message=%s raw=%s",
                            code,
                            message,
                            text[:400],
                        )
                        # 为避免改变现有调用方语义，这里只记录日志并继续，
                        # 让上层仍然通过“空结果”来感知异常。
                        continue

                    usage_obj = data.get("usage")
                    if isinstance(usage_obj, dict):
                        u_val = usage_obj.get("total_tokens")
                        if isinstance(u_val, int):
                            usage = u_val
                        c_val, cc_val = self._extract_cache_usage(usage_obj)
                        if isinstance(c_val, int):
                            cached_tokens = c_val
                        if isinstance(cc_val, int):
                            cache_creation_tokens = cc_val

                    try:
                        choice = data["choices"][0]
                        delta = choice.get("delta") or {}
                    except (KeyError, IndexError):
                        # 非标准 choices 结构（例如 ping / system 事件），直接跳过
                        text_logger.warning(
                            "qwen.chat_tools_stream missing_choices payload=%s", text[:400]
                        )
                        continue

                    thinking_delta = self._extract_thinking_from_delta(delta)
                    if thinking_delta:
                        saw_delta = True
                        result["thinking_parts"].append(thinking_delta)
                        if return_events:
                            yield {"type": "thinking", "content": thinking_delta}

                    delta_content = delta.get("content")
                    if isinstance(delta_content, list):
                        text_content, thinking_content = self._split_content_parts(delta_content)
                        if thinking_content:
                            saw_delta = True
                            result["thinking_parts"].append(thinking_content)
                            if return_events:
                                yield {"type": "thinking", "content": thinking_content}
                        if text_content:
                            saw_delta = True
                            result["content_parts"].append(text_content)
                            if return_events:
                                yield {"type": "delta", "content": text_content}
                            else:
                                yield text_content
                    elif isinstance(delta_content, str) and delta_content:
                        saw_delta = True
                        result["content_parts"].append(delta_content)
                        if return_events:
                            yield {"type": "delta", "content": delta_content}
                        else:
                            yield delta_content

                    raw_tc_list = delta.get("tool_calls") or []
                    if isinstance(raw_tc_list, list):
                        for tc in raw_tc_list:
                            if not isinstance(tc, dict):
                                continue
                            saw_delta = True
                            idx = tc.get("index")
                            if not isinstance(idx, int):
                                idx = 0
                            entry = tool_calls_by_index.setdefault(
                                idx,
                                {
                                    "id": None,
                                    "type": "function",
                                    "function": {"name": None, "arguments": ""},
                                },
                            )
                            if tc.get("id") and not entry.get("id"):
                                entry["id"] = tc["id"]
                            fn_delta = tc.get("function") or {}
                            fn_entry = entry.setdefault(
                                "function", {"name": None, "arguments": ""}
                            )
                            name_delta = fn_delta.get("name")
                            if isinstance(name_delta, str) and not fn_entry.get("name"):
                                fn_entry["name"] = name_delta
                            args_delta = fn_delta.get("arguments")
                            if isinstance(args_delta, str) and args_delta:
                                fn_entry["arguments"] = (
                                    str(fn_entry.get("arguments") or "") + args_delta
                                )

            if not saw_delta:
                text_logger.warning(
                    "qwen.chat_tools_stream empty_stream model=%s", self.model
                )

            if isinstance(usage, int):
                result["usage"] = usage
                text_logger.info(
                    "qwen.chat_tools_stream usage model=%s tokens=%s cached_tokens=%s cache_creation_tokens=%s",
                    self.model,
                    usage,
                    cached_tokens,
                    cache_creation_tokens,
                )
                self._last_usage_total_tokens = usage

            ordered: list[dict] = []
            for idx in sorted(tool_calls_by_index.keys()):
                entry = tool_calls_by_index[idx]
                fn = entry.get("function") or {}
                args = fn.get("arguments")
                if isinstance(args, str):
                    fn["arguments"] = args.strip()
                ordered.append(entry)
            result["tool_calls"] = ordered

        return gen(), result

    def responses_with_tools_stream(
        self,
        input_items: List[dict],
        *,
        tools: List[dict],
        previous_response_id: str | None = None,
        instructions: str | None = None,
        tool_choice: str | dict = "auto",
        temperature: float = 0.2,
        top_p: float = 0.8,
        return_events: bool = False,
    ) -> tuple[Generator[Any, None, None], dict]:
        if not self.supports_responses_api():
            raise RuntimeError("responses_api_not_supported_for_current_base_url")
        url = _build_dashscope_url(self.base_url, str(self._responses_path))
        headers = self._build_headers()
        payload: dict[str, Any] = {
            "model": self.model,
            "input": self._normalize_responses_input_items(
                self._inject_explicit_cache_markers_into_input(input_items)
            ),
            "tools": self._normalize_responses_tools(tools),
            "tool_choice": tool_choice,
            "temperature": temperature,
            "top_p": top_p,
            "stream": True,
        }
        if previous_response_id:
            payload["previous_response_id"] = previous_response_id
        if instructions:
            payload["instructions"] = instructions
        self._apply_thinking_options(payload)
        if self.max_output_tokens is not None:
            payload["max_output_tokens"] = self.max_output_tokens

        self._log_payload("responses_with_tools_stream", payload)
        result: dict[str, Any] = {
            "content_parts": [],
            "tool_calls": [],
            "thinking_parts": [],
            "response_id": None,
        }

        def gen() -> Generator[Any, None, None]:
            usage: int | None = None
            cached_tokens: int | None = None
            cache_creation_tokens: int | None = None
            tool_calls_by_key: dict[str, dict[str, Any]] = {}
            event_counts: dict[str, int] = {}
            first_event_types: list[str] = []
            saw_any_event = False
            with requests.post(url, headers=headers, json=payload, stream=True, timeout=300) as resp:
                try:
                    resp.raise_for_status()
                except requests.HTTPError as exc:
                    raise QwenRequestError(
                        f"Qwen responses stream failed: status={resp.status_code}, body={resp.text}",
                        response_text=resp.text,
                    ) from exc

                for line in resp.iter_lines():
                    if not line:
                        continue
                    try:
                        text = line.decode("utf-8").strip()
                    except Exception:
                        continue
                    if not text:
                        continue
                    if text.startswith("data:"):
                        text = text[len("data:") :].strip()
                    elif text.startswith(("id:", "event:", ":")):
                        continue
                    if text == "[DONE]":
                        break
                    try:
                        data = json.loads(text)
                    except json.JSONDecodeError:
                        text_logger.warning("qwen.responses_stream invalid_json line=%s", text[:400])
                        continue

                    event_type = str(data.get("type") or "").strip().lower()
                    saw_any_event = True
                    event_counts[event_type] = int(event_counts.get(event_type) or 0) + 1
                    if event_type and len(first_event_types) < 8:
                        first_event_types.append(event_type)
                    if event_type == "response.failed":
                        response_obj = data.get("response") if isinstance(data.get("response"), dict) else {}
                        error_obj = response_obj.get("error") if isinstance(response_obj.get("error"), dict) else {}
                        message = str(error_obj.get("message") or data)
                        text_logger.error(
                            "qwen.responses_stream failed model=%s response_id=%s first_events=%s error=%s",
                            self.model,
                            str(response_obj.get("id") or data.get("response_id") or "").strip() or None,
                            first_event_types,
                            message[:500],
                        )
                        raise QwenRequestError(f"Qwen responses stream failed: {message}")
                    if event_type.endswith("output_text.delta"):
                        delta = str(data.get("delta") or "")
                        if delta:
                            result["content_parts"].append(delta)
                            if return_events:
                                yield {"type": "delta", "content": delta}
                            else:
                                yield delta
                        continue
                    if "reasoning" in event_type and event_type.endswith(".delta"):
                        delta = str(data.get("delta") or "")
                        if delta:
                            result["thinking_parts"].append(delta)
                            if return_events:
                                yield {"type": "thinking", "content": delta}
                        continue
                    if event_type.endswith("output_item.done"):
                        item = data.get("item")
                        if isinstance(item, dict):
                            normalized_tool = self._normalize_responses_tool_item(item)
                            if normalized_tool:
                                key = str(normalized_tool.get("id") or normalized_tool.get("function", {}).get("name") or "")
                                tool_calls_by_key[key] = normalized_tool
                                continue
                            item_text = self._extract_responses_output_text(item)
                            if item_text:
                                result["content_parts"].append(item_text)
                                if return_events:
                                    yield {"type": "delta", "content": item_text}
                                else:
                                    yield item_text
                        continue
                    if event_type == "response.completed":
                        response_obj = data.get("response") if isinstance(data.get("response"), dict) else {}
                        response_id = str(response_obj.get("id") or data.get("response_id") or "").strip()
                        if response_id:
                            result["response_id"] = response_id
                        output_items = response_obj.get("output") if isinstance(response_obj.get("output"), list) else []
                        if output_items:
                            output_item_types = [
                                str(item.get("type") or "").strip()
                                for item in output_items
                                if isinstance(item, dict)
                            ]
                            text_logger.info(
                                "qwen.responses_stream completed_output model=%s response_id=%s status=%s output_types=%s output_len=%s first_events=%s",
                                self.model,
                                response_id or None,
                                str(response_obj.get("status") or "").strip() or None,
                                output_item_types[:8],
                                len(output_items),
                                first_event_types,
                            )
                        usage_obj = response_obj.get("usage") if isinstance(response_obj.get("usage"), dict) else {}
                        total_tokens = usage_obj.get("total_tokens")
                        if isinstance(total_tokens, int):
                            usage = total_tokens
                        c_val, cc_val = self._extract_cache_usage(usage_obj)
                        if isinstance(c_val, int):
                            cached_tokens = c_val
                        if isinstance(cc_val, int):
                            cache_creation_tokens = cc_val
                        continue

            if not saw_any_event:
                text_logger.warning(
                    "qwen.responses_stream empty_stream model=%s previous_response_id=%s",
                    self.model,
                    previous_response_id,
                )
            elif not result["content_parts"] and not tool_calls_by_key and not result["thinking_parts"]:
                text_logger.warning(
                    "qwen.responses_stream no_actionable_output model=%s response_id=%s event_counts=%s first_events=%s",
                    self.model,
                    result.get("response_id"),
                    event_counts,
                    first_event_types,
                )
            if isinstance(usage, int):
                result["usage"] = usage
                self._last_usage_total_tokens = usage
                text_logger.info(
                    "qwen.responses_stream usage model=%s tokens=%s cached_tokens=%s cache_creation_tokens=%s response_id=%s",
                    self.model,
                    usage,
                    cached_tokens,
                    cache_creation_tokens,
                    result.get("response_id"),
                )
            result["tool_calls"] = list(tool_calls_by_key.values())
            text_logger.info(
                "qwen.responses_stream summary model=%s response_id=%s text_parts=%s tool_calls=%s thinking_parts=%s event_counts=%s",
                self.model,
                result.get("response_id"),
                len(result.get("content_parts") or []),
                len(result.get("tool_calls") or []) if isinstance(result.get("tool_calls"), list) else len(tool_calls_by_key),
                len(result.get("thinking_parts") or []),
                event_counts,
            )

        return gen(), result

    def chat_stream(
        self,
        messages: List[dict],
        *,
        temperature: float = 0.2,
        top_p: float = 0.8,
        return_events: bool = False,
    ) -> tuple[Generator[Any, None, None], dict]:
        """Stream chat completions in an OpenAI-compatible way."""
        url = _build_dashscope_url(self.base_url, self._chat_path)
        headers = self._build_headers()
        payload = {
            "model": self.model,
            "messages": self._inject_explicit_cache_markers(messages),
            "temperature": temperature,
            "top_p": top_p,
            "stream": True,
        }
        self._apply_thinking_options(payload)
        if self.max_output_tokens is not None:
            payload["max_tokens"] = self.max_output_tokens
        self._log_payload("chat_stream", payload)
        result: dict[str, Any] = {"content_parts": [], "thinking_parts": []}

        def gen() -> Generator[Any, None, None]:
            usage: int | None = None
            cached_tokens: int | None = None
            cache_creation_tokens: int | None = None
            with requests.post(url, headers=headers, json=payload, stream=True, timeout=60) as resp:
                try:
                    resp.raise_for_status()
                except requests.HTTPError as exc:  # pragma: no cover - runtime failure
                    raise RuntimeError(
                        f"Qwen stream request failed: status={resp.status_code}, body={resp.text}"
                    ) from exc

                for line in resp.iter_lines():
                    if not line:
                        continue
                    try:
                        text = line.decode("utf-8").strip()
                    except Exception:
                        continue
                    if not text:
                        continue
                    if text.startswith("data: "):
                        text = text[len("data: ") :].strip()
                    if text == "[DONE]":
                        break
                    try:
                        data = json.loads(text)
                    except json.JSONDecodeError:
                        continue

                    usage_obj = data.get("usage")
                    if isinstance(usage_obj, dict):
                        u_val = usage_obj.get("total_tokens")
                        if isinstance(u_val, int):
                            usage = u_val
                        c_val, cc_val = self._extract_cache_usage(usage_obj)
                        if isinstance(c_val, int):
                            cached_tokens = c_val
                        if isinstance(cc_val, int):
                            cache_creation_tokens = cc_val

                    try:
                        choice = data["choices"][0]
                    except (KeyError, IndexError):  # pragma: no cover - defensive
                        choice = {}
                    delta = choice.get("delta") if isinstance(choice, dict) else {}
                    message = choice.get("message") if isinstance(choice, dict) else {}

                    thinking_delta = self._extract_thinking_from_delta(delta if isinstance(delta, dict) else {})
                    if thinking_delta:
                        result["thinking_parts"].append(thinking_delta)
                        if return_events:
                            yield {"type": "thinking", "content": thinking_delta}

                    delta_content = delta.get("content") if isinstance(delta, dict) else None
                    if isinstance(delta_content, list):
                        text_content, thinking_content = self._split_content_parts(delta_content)
                        if thinking_content:
                            result["thinking_parts"].append(thinking_content)
                            if return_events:
                                yield {"type": "thinking", "content": thinking_content}
                        if text_content:
                            result["content_parts"].append(text_content)
                            if return_events:
                                yield {"type": "delta", "content": text_content}
                            else:
                                yield str(text_content)
                        continue
                    if isinstance(delta_content, str) and delta_content:
                        result["content_parts"].append(delta_content)
                        if return_events:
                            yield {"type": "delta", "content": delta_content}
                        else:
                            yield str(delta_content)
                        continue

                    message_content = message.get("content") if isinstance(message, dict) else None
                    if isinstance(message_content, list):
                        text_content, thinking_content = self._split_content_parts(message_content)
                        if thinking_content:
                            result["thinking_parts"].append(thinking_content)
                            if return_events:
                                yield {"type": "thinking", "content": thinking_content}
                        if text_content:
                            result["content_parts"].append(text_content)
                            if return_events:
                                yield {"type": "delta", "content": text_content}
                            else:
                                yield str(text_content)
                    elif isinstance(message_content, str) and message_content:
                        result["content_parts"].append(message_content)
                        if return_events:
                            yield {"type": "delta", "content": message_content}
                        else:
                            yield str(message_content)

            if isinstance(usage, int):
                result["usage"] = usage
                text_logger.info(
                    "qwen.chat_stream usage model=%s tokens=%s cached_tokens=%s cache_creation_tokens=%s",
                    self.model,
                    usage,
                    cached_tokens,
                    cache_creation_tokens,
                )
                self._last_usage_total_tokens = usage

        return gen(), result

    @property
    def last_usage_total_tokens(self) -> int | None:
        return self._last_usage_total_tokens


class QwenEmbeddingClient:
    """DashScope /compatible-mode/v1/embeddings 封装，用于生成向量。"""

    def __init__(self) -> None:
        settings = get_settings()
        if not settings.alibaba_api_key:
            raise RuntimeError("ALIBABA_API_KEY is not configured")
        self.base_url = settings.alibaba_base_url.rstrip("/")
        self.api_key = settings.alibaba_api_key
        self.model = settings.alibaba_model_embedding
        self.dimensions = settings.alibaba_embedding_dimensions
        self._is_multimodal_native = self._is_multimodal_embedding_model(self.model)
        if not self._is_multimodal_native:
            raise RuntimeError("ALIBABA_MODEL_EMBEDDING must be a multimodal model")

    @staticmethod
    def _is_multimodal_embedding_model(model_name: str) -> bool:
        name = (model_name or "").strip().lower()
        return any(
            key in name
            for key in (
                "tongyi-embedding-vision",
                "multimodal-embedding",
                "qwen3-vl-embedding",
                "qwen2.5-vl-embedding",
            )
        )

    def _build_image_data_uri(self, image_ref: str) -> str:
        value = image_ref.strip()
        if not value:
            return value
        resolver = AssetResolver()
        return resolver.resolve_for_model(value)

    def _normalize_embedding_input(self, item: Any) -> dict[str, str] | None:
        if isinstance(item, dict):
            if isinstance(item.get("text"), str) and item["text"].strip():
                return {"text": item["text"].strip()}
            if isinstance(item.get("image"), str) and item["image"].strip():
                return {"image": self._build_image_data_uri(item["image"])}
            return None
        text_value = str(item or "").strip()
        if not text_value:
            return None
        return {"text": text_value}

    def _iter_embedding_batches(
        self,
        contents: list[dict[str, str]],
        *,
        batch_size: int = 10,
    ) -> list[list[dict[str, str]]]:
        return [contents[idx : idx + batch_size] for idx in range(0, len(contents), batch_size)]

    def _post_embedding_batch(self, contents: list[dict[str, str]]) -> list[list[float]]:
        path = (
            "api/v1/services/embeddings/multimodal-embedding/multimodal-embedding"
            if self._is_multimodal_native
            else "compatible-mode/v1/embeddings"
        )
        url = _build_dashscope_url(self.base_url, path)
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        if self._is_multimodal_native:
            parameters: dict[str, Any] = {"output_type": "dense"}
            if self.dimensions > 0:
                parameters["dimension"] = self.dimensions
            payload: dict[str, Any] = {
                "model": self.model,
                "input": {"contents": contents},
                "parameters": parameters,
            }
        else:
            payload = {
                "model": self.model,
                "input": {"contents": contents},
                "dimension": self.dimensions,
                "dimensions": self.dimensions,
            }
        try:
            serialized = json.dumps(self._sanitize_payload_for_log(payload), ensure_ascii=False)
        except TypeError:
            serialized = str(payload)
        embedding_logger.info(
            "qwen.embedding.payload model=%s batch=%s payload=%s",
            self.model,
            len(contents),
            serialized,
        )

        attempt = 0
        while True:
            start = time.perf_counter()
            resp = None
            try:
                resp = requests.post(url, headers=headers, json=payload, timeout=300)
                resp.raise_for_status()
                data = resp.json()
                items = ((data.get("output") or {}).get("embeddings") or [])
                indexed: dict[int, list[float]] = {}
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    idx = item.get("index")
                    if not isinstance(idx, int):
                        idx = item.get("text_index")
                    emb = item.get("embedding")
                    if not isinstance(idx, int) or not isinstance(emb, list):
                        continue
                    try:
                        indexed[idx] = [float(x) for x in emb]
                    except (TypeError, ValueError):
                        continue
                vectors = [indexed[idx] for idx in range(len(contents)) if idx in indexed]
                elapsed_ms = (time.perf_counter() - start) * 1000
                embedding_logger.info(
                    "qwen.embedding.success model=%s batch=%s elapsed_ms=%.1f dim=%s",
                    self.model,
                    len(vectors),
                    elapsed_ms,
                    len(vectors[0]) if vectors else 0,
                )
                return vectors
            except requests.HTTPError as exc:
                elapsed_ms = (time.perf_counter() - start) * 1000
                status = getattr(exc.response, "status_code", None) or getattr(resp, "status_code", None)
                body_preview = (getattr(resp, "text", "") or "")[:400]
                embedding_logger.exception(
                    "qwen.embedding.http_error model=%s status=%s elapsed_ms=%.1f body=%s",
                    self.model,
                    status,
                    elapsed_ms,
                    body_preview,
                )
                if status in (429, 500, 502, 503, 504) and attempt < 2:
                    time.sleep(2**attempt)
                    attempt += 1
                    continue
                raise QwenRequestError(
                    f"Qwen embedding failed: status={getattr(resp, 'status_code', status)}, body={getattr(resp, 'text', '')}",
                    response_text=getattr(resp, "text", None),
                ) from exc
            except requests.RequestException as exc:
                elapsed_ms = (time.perf_counter() - start) * 1000
                embedding_logger.exception(
                    "qwen.embedding.request_error model=%s elapsed_ms=%.1f",
                    self.model,
                    elapsed_ms,
                )
                if attempt < 2:
                    time.sleep(2**attempt)
                    attempt += 1
                    continue
                response_text = None
                if getattr(exc, "response", None) is not None:
                    try:
                        response_text = exc.response.text  # type: ignore[attr-defined]
                    except Exception:
                        response_text = None
                raise QwenRequestError(
                    f"Qwen embedding request error: {exc}", response_text=response_text
                ) from exc

    def _sanitize_payload_for_log(self, payload: Any) -> Any:
        if isinstance(payload, dict):
            return {str(k): self._sanitize_payload_for_log(v) for k, v in payload.items()}
        if isinstance(payload, list):
            return [self._sanitize_payload_for_log(v) for v in payload]
        if isinstance(payload, str):
            value = payload
            if value.startswith("data:image/"):
                head, _, b64 = value.partition(",")
                if b64:
                    preview = b64[:32]
                    return f"{head},<base64:{len(b64)} chars preview:{preview}...>"
                return value
            if len(value) > _MAX_LOG_STRING_CHARS:
                return f"{value[:_MAX_LOG_STRING_CHARS]}...[truncated {len(value) - _MAX_LOG_STRING_CHARS} chars]"
            return value
        return payload

    def embed(self, inputs: list[Any] | str) -> list[list[float]]:
        if isinstance(inputs, str):
            normalized = [self._normalize_embedding_input(inputs)]
        else:
            normalized = [self._normalize_embedding_input(item) for item in inputs]
        contents = [item for item in normalized if item is not None]
        if not contents:
            return []

        vectors: list[list[float]] = []
        for batch in self._iter_embedding_batches(contents):
            vectors.extend(self._post_embedding_batch(batch))
        return vectors

class QwenVisionClient:
    """Legacy stub: vision功能已禁用，保留类定义避免旧模块 import 报错。"""

    def __init__(self) -> None:
        raise RuntimeError("QwenVisionClient is no longer available; vision features have been removed.")

    def describe_exam_images(self, *_args, **_kwargs) -> str:
        raise RuntimeError("QwenVisionClient.describe_exam_images is disabled.")


