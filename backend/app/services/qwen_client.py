from typing import Any, Dict, Generator, Iterable, List, Tuple

import json
import logging
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse, urlunparse

import requests

from ..config import get_settings


text_logger = logging.getLogger("agent.qwen")
embedding_logger = logging.getLogger("agent.embedding")


_MAX_LOG_PAYLOAD_CHARS = 6000
_EXPLICIT_CACHE_MAX_MARKERS = 4


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
    ) -> None:
        settings = get_settings()
        if not settings.alibaba_api_key:
            raise RuntimeError("ALIBABA_API_KEY is not configured")
        self.base_url = settings.alibaba_base_url.rstrip("/")
        self._chat_path = "compatible-mode/v1/chat/completions"
        self.api_key = settings.alibaba_api_key
        self.model = model or settings.alibaba_model_qwen_plus
        self.max_output_tokens = max_output_tokens
        self._last_usage_total_tokens: int | None = None
        self._explicit_cache_enabled = bool(getattr(settings, "alibaba_explicit_cache_enabled", False))
        self._enable_thinking = bool(getattr(settings, "alibaba_enable_thinking", False))
        self._thinking_budget = int(getattr(settings, "alibaba_thinking_budget", 0) or 0)

    def _is_explicit_cache_supported_model(self) -> bool:
        model_name = (self.model or "").strip().lower()
        if not model_name:
            return False
        return model_name == "qwen3.5-plus"

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
                role in ("system", "user")
                and isinstance(content, str)
                and content.strip()
                and markers_used < _EXPLICIT_CACHE_MAX_MARKERS
            ):
                cloned["content"] = [
                    {
                        "type": "text",
                        "text": content,
                        "cache_control": {"type": "ephemeral"},
                    }
                ]
                markers_used += 1
            prepared.append(cloned)
        return prepared

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
            serialized = json.dumps(payload, ensure_ascii=False)
        except TypeError:
            serialized = str(payload)

        preview = serialized
        if len(preview) > _MAX_LOG_PAYLOAD_CHARS:
            preview = preview[:_MAX_LOG_PAYLOAD_CHARS] + f" ...[truncated {len(serialized) - _MAX_LOG_PAYLOAD_CHARS} chars]"

        text_logger.info(
            "qwen.payload label=%s length=%s payload=%s",
            label,
            len(serialized),
            preview,
        )

    def chat(
        self,
        messages: List[dict],
        *,
        temperature: float = 0.2,
        top_p: float = 0.8,
    ) -> Tuple[str, int | None]:
        url = _build_dashscope_url(self.base_url, self._chat_path)
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.model,
            "messages": self._inject_explicit_cache_markers(messages),
            "temperature": temperature,
            "top_p": top_p,
        }
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
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
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
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
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

    def embed(self, inputs: list[str] | str) -> list[list[float]]:
        if isinstance(inputs, str):
            batch = [inputs]
        else:
            batch = [str(x) for x in inputs if str(x).strip()]
        if not batch:
            return []

        url = _build_dashscope_url(self.base_url, "compatible-mode/v1/embeddings")
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload: dict = {
            "model": self.model,
            "input": batch,
            "dimensions": self.dimensions,
        }
        try:
            serialized = json.dumps(payload, ensure_ascii=False)
        except TypeError:
            serialized = str(payload)
        embedding_logger.info(
            "qwen.embedding.payload model=%s batch=%s payload=%s",
            self.model,
            len(batch),
            serialized,
        )

        start = time.perf_counter()
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=300)
            resp.raise_for_status()
        except requests.HTTPError as exc:
            elapsed_ms = (time.perf_counter() - start) * 1000
            status = getattr(exc.response, "status_code", None) or resp.status_code
            body_preview = (resp.text or "")[:400]
            embedding_logger.exception(
                "qwen.embedding.http_error model=%s status=%s elapsed_ms=%.1f body=%s",
                self.model,
                status,
                elapsed_ms,
                body_preview,
            )
            raise QwenRequestError(
                f"Qwen embedding failed: status={resp.status_code}, body={resp.text}",
                response_text=resp.text,
            ) from exc
        except requests.RequestException as exc:
            elapsed_ms = (time.perf_counter() - start) * 1000
            embedding_logger.exception(
                "qwen.embedding.request_error model=%s elapsed_ms=%.1f",
                self.model,
                elapsed_ms,
            )
            response_text = None
            if getattr(exc, "response", None) is not None:
                try:
                    response_text = exc.response.text  # type: ignore[attr-defined]
                except Exception:
                    response_text = None
            raise QwenRequestError(
                f"Qwen embedding request error: {exc}", response_text=response_text
            ) from exc

        data = resp.json()
        vectors: list[list[float]] = []
        try:
            items = data["data"]
        except (KeyError, TypeError):
            embedding_logger.warning("qwen.embedding.malformed_response data=%s", data)
            return []

        for item in items:
            if not isinstance(item, dict):
                continue
            emb = item.get("embedding")
            if not isinstance(emb, list):
                continue
            try:
                vec = [float(x) for x in emb]
            except (TypeError, ValueError):
                continue
            vectors.append(vec)

        elapsed_ms = (time.perf_counter() - start) * 1000
        embedding_logger.info(
            "qwen.embedding.success model=%s batch=%s elapsed_ms=%.1f dim=%s",
            self.model,
            len(vectors),
            elapsed_ms,
            len(vectors[0]) if vectors else 0,
        )
        return vectors

    def chat_stream(
        self,
        messages: List[dict],
        *,
        temperature: float = 0.2,
        top_p: float = 0.8,
        return_events: bool = False,
    ) -> Generator[Any, None, None]:
        """Stream chat completions in an OpenAI-compatible way.

        每次 yield 一小段新增的文本，供上层通过 StreamingResponse 直接透传给前端。
        """
        url = _build_dashscope_url(self.base_url, self._chat_path)
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
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
                    delta = data["choices"][0]["delta"]
                except (KeyError, IndexError):  # pragma: no cover - defensive
                    delta = {}

                thinking_delta = self._extract_thinking_from_delta(delta)
                if thinking_delta:
                    if return_events:
                        yield {"type": "thinking", "content": thinking_delta}

                delta_content = delta.get("content")
                if isinstance(delta_content, list):
                    text_content, thinking_content = self._split_content_parts(delta_content)
                    if thinking_content and return_events:
                        yield {"type": "thinking", "content": thinking_content}
                    if text_content:
                        if return_events:
                            yield {"type": "delta", "content": text_content}
                        else:
                            yield str(text_content)
                elif isinstance(delta_content, str) and delta_content:
                    if return_events:
                        yield {"type": "delta", "content": delta_content}
                    else:
                        yield str(delta_content)

        if isinstance(usage, int):
            text_logger.info(
                "qwen.chat_stream usage model=%s tokens=%s cached_tokens=%s cache_creation_tokens=%s",
                self.model,
                usage,
                cached_tokens,
                cache_creation_tokens,
            )
            self._last_usage_total_tokens = usage


    @property
    def last_usage_total_tokens(self) -> int | None:
        return self._last_usage_total_tokens


class QwenVisionClient:
    """Legacy stub: vision功能已禁用，保留类定义避免旧模块 import 报错。"""

    def __init__(self) -> None:
        raise RuntimeError("QwenVisionClient is no longer available; vision features have been removed.")

    def describe_exam_images(self, *_args, **_kwargs) -> str:
        raise RuntimeError("QwenVisionClient.describe_exam_images is disabled.")


