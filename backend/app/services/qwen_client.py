from typing import Generator, List, Tuple

import json
import logging
import tempfile
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse, urlunparse

import requests

from ..config import get_settings


logger = logging.getLogger("agent.vision")
text_logger = logging.getLogger("agent.qwen")


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


def _emit_vision_debug(message: str) -> None:
    try:
        print(f"[vision-debug] {message}", flush=True)
    except Exception:
        pass
    try:
        log_path = Path(tempfile.gettempdir()) / "vision_client.log"
        with log_path.open("a", encoding="utf-8") as fp:
            fp.write(message + "\n")
    except Exception:
        pass


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

    def _log_payload(self, label: str, payload: dict) -> None:
        try:
            serialized = json.dumps(payload, ensure_ascii=False)
        except TypeError:
            serialized = str(payload)
        text_logger.info(
            "qwen.payload label=%s length=%s payload=%s",
            label,
            len(serialized),
            serialized,
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
            "messages": messages,
            "temperature": temperature,
            "top_p": top_p,
        }
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
        if isinstance(usage, int):
            self._last_usage_total_tokens = usage
        elapsed_ms = (time.perf_counter() - start) * 1000
        text_logger.info(
            "qwen.chat success model=%s tokens=%s elapsed_ms=%.1f",
            self.model,
            usage,
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
            "messages": messages,
            "temperature": temperature,
            "top_p": top_p,
            "tools": tools,
            "tool_choice": tool_choice,
        }
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
        if isinstance(usage, int):
            self._last_usage_total_tokens = usage
        elapsed_ms = (time.perf_counter() - start) * 1000
        text_logger.info(
            "qwen.chat_tools success model=%s tokens=%s elapsed_ms=%.1f tool_calls=%s",
            self.model,
            usage,
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
    ) -> tuple[Generator[str, None, None], dict]:
        url = _build_dashscope_url(self.base_url, self._chat_path)
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload: dict = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "top_p": top_p,
            "tools": tools,
            "tool_choice": tool_choice,
            "stream": True,
        }
        if self.max_output_tokens is not None:
            payload["max_tokens"] = self.max_output_tokens

        self._log_payload("chat_with_tools_stream", payload)
        result: dict = {"content_parts": [], "tool_calls": []}

        def gen() -> Generator[str, None, None]:
            tool_calls_by_index: dict[int, dict] = {}
            saw_delta = False
            usage: int | None = None
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

                    try:
                        choice = data["choices"][0]
                        delta = choice.get("delta") or {}
                    except (KeyError, IndexError):
                        # 非标准 choices 结构（例如 ping / system 事件），直接跳过
                        text_logger.warning(
                            "qwen.chat_tools_stream missing_choices payload=%s", text[:400]
                        )
                        continue

                    delta_content = delta.get("content")
                    if isinstance(delta_content, str) and delta_content:
                        saw_delta = True
                        result["content_parts"].append(delta_content)
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
                    "qwen.chat_tools_stream usage model=%s tokens=%s",
                    self.model,
                    usage,
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

    def chat_stream(
        self,
        messages: List[dict],
        *,
        temperature: float = 0.2,
        top_p: float = 0.8,
    ) -> Generator[str, None, None]:
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
            "messages": messages,
            "temperature": temperature,
            "top_p": top_p,
            "stream": True,
        }
        if self.max_output_tokens is not None:
            payload["max_tokens"] = self.max_output_tokens
        usage: int | None = None
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

                try:
                    delta = data["choices"][0]["delta"].get("content")
                except (KeyError, IndexError):  # pragma: no cover - defensive
                    delta = None
                if delta:
                    yield str(delta)

        if isinstance(usage, int):
            text_logger.info(
                "qwen.chat_stream usage model=%s tokens=%s",
                self.model,
                usage,
            )
            self._last_usage_total_tokens = usage


    @property
    def last_usage_total_tokens(self) -> int | None:
        return self._last_usage_total_tokens


class QwenVisionClient:
    """Qwen 多模态视觉模型客户端，用于对题目图像进行文字描述。

    使用 ALIBABA_MODEL_QWEN_VL_FLASH（例如 qwen3-vl-flash），
    通过 OpenAI 兼容的 /chat/completions 接口，以 image_url + text 的形式提交图像。
    """

    def __init__(self) -> None:
        settings = get_settings()
        if not settings.alibaba_api_key:
            raise RuntimeError("ALIBABA_API_KEY is not configured")
        self.base_url = settings.alibaba_base_url.rstrip("/")
        self.api_key = settings.alibaba_api_key
        # 使用专用视觉模型
        self.model = settings.alibaba_model_qwen_vl_flash
        self._chat_path = "compatible-mode/v1/chat/completions"
        logger.info(
            "vision.client.init base_url=%s chat_path=%s model=%s module=%s",
            self.base_url,
            self._chat_path,
            self.model,
            __file__,
        )
        _emit_vision_debug(
            f"init base_url={self.base_url} chat_path={self._chat_path} model={self.model} module={__file__}"
        )

    def describe_exam_images(self, items: List[dict], *, doc_title: str | None = None) -> str:
        """对试卷中的图例进行整体描述。

        items: List[{"index": int, "page": Optional[int], "urls": List[str], "content": Optional[str]}]
        返回一段中文文本，按题目顺序描述每张图像的关键信息。
        """

        if not items:
            return ""

        # 记录视觉 Agent 的输入概要，便于排查图像 URL / 题号是否正确
        try:
            preview_items = [
                {
                    "index": it.get("index"),
                    "page": it.get("page"),
                    "url_count": len(it.get("urls") or []),
                    "urls_preview": (it.get("urls") or [])[:3],
                }
                for it in items
            ]
            logger.info("vision.describe_exam_images start items=%s detail=%s", len(items), preview_items)
        except Exception:
            # 日志本身容错，避免影响主流程
            logger.info("vision.describe_exam_images start items=%s", len(items))

        # 构造多模态内容：按题号顺序依次给出文本提示 + 对应图像
        intro_lines: List[str] = [
            "下面是试卷中若干题目的图像，请你只进行图像理解，不要解题、不给答案。",
            "严禁推理、推导、计算或给出结论，只能客观描述图像中看到的元素、标注、形状、位置、数值、表格内容等。",
            "请按题号分段描述，保持结构化；说明画面元素、标注、轴/刻度、关键点、趋势、相对位置等。",
        ]
        if doc_title:
            intro_lines.append(f"试卷标题：{doc_title}")

        content_parts: List[dict] = [
            {"type": "text", "text": "\n".join(intro_lines)},
        ]

        for item in items:
            index = item.get("index")
            page = item.get("page")
            urls = item.get("urls") or []
            q_content = item.get("content") or ""
            if not urls:
                continue

            prefix = f"\n第{index}题"
            if page is not None:
                prefix += f"（第{page}页）"
            prefix += " 的图像："

            content_parts.append({"type": "text", "text": prefix})
            if q_content:
                content_parts.append({"type": "text", "text": f"题目文本：{q_content}"})
            for url in urls:
                if not url:
                    continue
                content_parts.append(
                    {
                        "type": "image_url",
                        "image_url": {"url": str(url)},
                    }
                )

        messages = [
            {
                "role": "user",
                "content": content_parts,
            }
        ]

        url = _build_dashscope_url(self.base_url, self._chat_path)
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.2,
            "top_p": 0.8,
        }
        logger.info(
            "vision.describe_exam_images request url=%s model=%s item_count=%s doc_title=%s",
            url,
            self.model,
            len(items),
            doc_title,
        )
        _emit_vision_debug(
            f"request url={url} model={self.model} item_count={len(items)} doc_title={doc_title}"
        )
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=60)
            resp.raise_for_status()
        except requests.HTTPError as exc:
            status = getattr(exc.response, "status_code", None) or resp.status_code
            body_preview = (resp.text or "")[:400]
            logger.warning(
                "vision.describe_exam_images http_error url=%s status=%s body_preview=%s",
                url,
                status,
                body_preview,
            )
            _emit_vision_debug(
                f"http_error url={url} status={status} body_preview={body_preview}"
            )
            raise RuntimeError(
                f"Qwen vision request failed: url={url} status={status}, body={resp.text}"
            ) from exc
        except requests.RequestException as exc:
            logger.warning(
                "vision.describe_exam_images request_error url=%s error=%s",
                url,
                exc,
            )
            _emit_vision_debug(f"request_error url={url} error={exc}")
            raise RuntimeError(f"Qwen vision request error: url={url} error={exc}") from exc

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

        # 记录视觉 Agent 的完整输出，便于排查（用户要求不截断）
        logger.info(
            "vision.describe_exam_images result_len=%s content=%s",
            len(content),
            content,
        )

        return content
