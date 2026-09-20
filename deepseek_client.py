import os
import re
from typing import Any, Iterator

from dotenv import load_dotenv
from openai import (
    APIConnectionError,
    APIError,
    AuthenticationError,
    BadRequestError,
    OpenAI,
    OpenAIError,
    RateLimitError,
)

from config import DEEPSEEK_BASE_URL, DEFAULT_MODEL


class DeepSeekClientError(Exception):
    """Raised when the DeepSeek request cannot be completed safely."""


def _sanitize_error_message(exc: Exception, api_key: str) -> str:
    message = str(exc)
    if api_key:
        message = message.replace(api_key, "[redacted]")
    message = re.sub(
        r"(?i)(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;)}\]]+",
        r"\1[redacted]",
        message,
    )
    message = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._\-]+", r"\1[redacted]", message)
    message = re.sub(r"(?i)(api[-_ ]?key\s*[:=]\s*)[^\s,;)}\]]+", r"\1[redacted]", message)
    return message


def _message_detail(message: str) -> str:
    return f"：{message}" if message else ""


def _extract_message_text(message: Any, allow_reasoning: bool = False) -> str:
    """Extract final content; reasoning is useful only for connectivity checks."""
    fields = ("content", "reasoning_content") if allow_reasoning else ("content",)
    candidates = [message.get(field) if isinstance(message, dict) else getattr(message, field, None)
                  for field in fields]

    for value in candidates:
        if value is None:
            continue
        text = value if isinstance(value, str) else str(value)
        text = text.strip()
        if text:
            return text
    return ""


def _extract_delta_text(delta: Any) -> str:
    """Extract readable text from OpenAI-style stream delta objects or dicts."""
    candidates = [
        getattr(delta, "content", None),
        getattr(delta, "reasoning_content", None),
    ]
    if isinstance(delta, dict):
        candidates.extend([delta.get("content"), delta.get("reasoning_content")])

    for value in candidates:
        if value is None:
            continue
        text = value if isinstance(value, str) else str(value)
        if text:
            return text
    return ""


def _extract_delta_field_text(delta: Any, field_name: str) -> str:
    value = getattr(delta, field_name, None)
    if isinstance(delta, dict):
        value = delta.get(field_name)
    if value is None:
        return ""
    return value if isinstance(value, str) else str(value)


def _stream_chunk_delta(chunk: Any) -> Any:
    choices = getattr(chunk, "choices", None)
    if isinstance(chunk, dict):
        choices = chunk.get("choices")
    if not choices:
        return None

    choice = choices[0]
    delta = getattr(choice, "delta", None)
    if isinstance(choice, dict):
        delta = choice.get("delta")
    return delta


def _finish_reason(choice: Any) -> str:
    value = choice.get("finish_reason") if isinstance(choice, dict) else getattr(choice, "finish_reason", None)
    return str(value or "").strip().lower()


def _raise_if_truncated(finish_reason: str) -> None:
    if finish_reason == "length":
        raise DeepSeekClientError(
            "模型输出达到 Token 上限，内容可能被截断，未作为完整结果保存。请提高 max_tokens 或缩小生成范围后重试。"
        )


def _capture_usage(response: Any, metrics: dict[str, Any] | None) -> None:
    """Copy only numeric usage; absent provider statistics remain unknown."""
    if metrics is None:
        return

    def field(value: Any, name: str) -> Any:
        return value.get(name) if isinstance(value, dict) else getattr(value, name, None)

    usage = field(response, "usage")
    if usage is None:
        return
    values: dict[str, int] = {}
    for name in ("prompt_tokens", "completion_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens"):
        value = field(usage, name)
        if type(value) is int and value >= 0:
            values[name] = value
    for name, detail, key in (
        ("prompt_cache_hit_tokens", "prompt_tokens_details", "cached_tokens"),
        ("reasoning_tokens", "completion_tokens_details", "reasoning_tokens"),
    ):
        value = field(field(usage, detail), key)
        if name not in values and type(value) is int and value >= 0:
            values[name] = value
    prompt, hit = values.get("prompt_tokens"), values.get("prompt_cache_hit_tokens")
    if "prompt_cache_miss_tokens" not in values and prompt is not None and hit is not None and hit <= prompt:
        values["prompt_cache_miss_tokens"] = prompt - hit
    metrics.update(values)


def _get_api_key() -> str:
    load_dotenv()
    api_key = os.getenv("DEEPSEEK_API_KEY", "").strip()

    if not api_key or api_key == "your_api_key_here":
        raise DeepSeekClientError(
            "未检测到有效的 DEEPSEEK_API_KEY。请复制 .env.example 为 .env，并填写你的 DeepSeek API Key。"
        )

    return api_key


def _get_base_url() -> str:
    load_dotenv()
    return os.getenv("DEEPSEEK_BASE_URL", DEEPSEEK_BASE_URL).strip() or DEEPSEEK_BASE_URL


def test_deepseek_connection(api_key: str, model: str) -> tuple[bool, str]:
    """Test DeepSeek with a temporary API key without reading or writing .env."""
    safe_api_key = (api_key or "").strip()
    safe_model = (model or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    if not safe_api_key or safe_api_key == "your_api_key_here":
        return False, "请先填写有效的 DeepSeek API Key。"

    client = OpenAI(api_key=safe_api_key, base_url=_get_base_url())

    try:
        response: Any = client.chat.completions.create(
            model=safe_model,
            messages=[{"role": "user", "content": "请只回复 OK"}],
            temperature=0,
            max_tokens=16,
        )
    except AuthenticationError:
        return False, "DeepSeek API Key 校验失败，请检查 Key 是否正确。"
    except RateLimitError:
        return False, "DeepSeek API 请求过于频繁或额度受限，请稍后再试。"
    except BadRequestError as exc:
        return False, f"DeepSeek API 拒绝了测试请求：{_sanitize_error_message(exc, safe_api_key)}"
    except APIConnectionError:
        return False, "无法连接 DeepSeek API，请检查网络连接或代理设置。"
    except APIError as exc:
        return False, f"DeepSeek API 返回异常：{_sanitize_error_message(exc, safe_api_key)}"
    except OpenAIError as exc:
        return False, f"OpenAI SDK 调用 DeepSeek 时发生错误：{_sanitize_error_message(exc, safe_api_key)}"
    except Exception as exc:
        return False, f"连接测试失败：{_sanitize_error_message(exc, safe_api_key)}"

    if not getattr(response, "choices", None):
        return False, "API 请求完成，但模型没有返回候选结果。"

    content = _extract_message_text(response.choices[0].message, allow_reasoning=True)
    if not content:
        return False, "API 请求完成，但模型返回内容为空。"

    return True, f"连接成功，模型 {safe_model} 返回了有效响应。"


def generate_text(
    messages: list[dict[str, str]],
    model: str | None = None,
    temperature: float = 0.7,
    max_tokens: int = 4000,
    usage_metrics: dict[str, Any] | None = None,
    *,
    json_mode: bool = False,
) -> str:
    """Generate text, optionally constraining JSON syntax; callers validate fields."""
    if not messages:
        raise DeepSeekClientError("Prompt 为空，无法生成内容。")
    if json_mode and not any(
        message.get("role") in {"system", "user"}
        and "json" in str(message.get("content") or "").casefold()
        for message in messages
    ):
        raise DeepSeekClientError("JSON 模式需要在 system 或 user 提示词中明确要求 JSON 输出并提供格式样例。")

    api_key = _get_api_key()
    client = OpenAI(api_key=api_key, base_url=_get_base_url())

    try:
        response: Any = client.chat.completions.create(
            model=(model or DEFAULT_MODEL).strip() or DEFAULT_MODEL,
            messages=messages,
            temperature=float(temperature),
            max_tokens=int(max_tokens),
            **({"response_format": {"type": "json_object"}} if json_mode else {}),
        )
    except AuthenticationError as exc:
        safe_message = _sanitize_error_message(exc, api_key)
        raise DeepSeekClientError(
            f"DeepSeek API Key 校验失败，请检查 .env 中的 DEEPSEEK_API_KEY。{_message_detail(safe_message)}"
        ) from exc
    except RateLimitError as exc:
        safe_message = _sanitize_error_message(exc, api_key)
        raise DeepSeekClientError(f"DeepSeek API 请求过于频繁或额度受限，请稍后再试。{_message_detail(safe_message)}") from exc
    except BadRequestError as exc:
        safe_message = _sanitize_error_message(exc, api_key)
        raise DeepSeekClientError(f"DeepSeek API 拒绝了本次请求：{safe_message}") from exc
    except APIConnectionError as exc:
        safe_message = _sanitize_error_message(exc, api_key)
        raise DeepSeekClientError(f"无法连接 DeepSeek API，请检查网络连接或代理设置。{_message_detail(safe_message)}") from exc
    except APIError as exc:
        safe_message = _sanitize_error_message(exc, api_key)
        raise DeepSeekClientError(f"DeepSeek API 返回异常：{safe_message}") from exc
    except OpenAIError as exc:
        safe_message = _sanitize_error_message(exc, api_key)
        raise DeepSeekClientError(f"OpenAI SDK 调用 DeepSeek 时发生错误：{safe_message}") from exc
    except Exception as exc:
        safe_message = _sanitize_error_message(exc, api_key)
        raise DeepSeekClientError(f"生成失败：{safe_message}") from exc

    _capture_usage(response, usage_metrics)
    if not getattr(response, "choices", None):
        raise DeepSeekClientError("模型没有返回候选结果。")

    _raise_if_truncated(_finish_reason(response.choices[0]))
    content = _extract_message_text(response.choices[0].message)
    if not content:
        raise DeepSeekClientError("模型返回内容为空，请调整 Prompt 或稍后重试。")

    return content


def stream_generate_text_events(
    messages: list[dict[str, str]],
    model: str | None = None,
    temperature: float = 0.7,
    max_tokens: int = 4000,
    usage_metrics: dict[str, Any] | None = None,
) -> Iterator[dict[str, str]]:
    """流式生成，产出结构化事件（不直接透出底层 chunk）。

    yield 事件：
      {"kind": "reasoning", "text": str}  —— 模型推理过程（仅展示用，不落盘）
      {"kind": "content",   "text": str}  —— 最终正文（唯一应写入文件的文本）

    reasoning 事件始终产出（不论正文是否开始），由调用方决定是否透传给用户。
    """
    if not messages:
        raise DeepSeekClientError("Prompt is empty; cannot generate content.")

    api_key = _get_api_key()
    client = OpenAI(api_key=api_key, base_url=_get_base_url())

    stream = None
    try:
        stream = client.chat.completions.create(
            model=(model or DEFAULT_MODEL).strip() or DEFAULT_MODEL,
            messages=messages,
            temperature=float(temperature),
            max_tokens=int(max_tokens),
            stream=True,
        )
        seen_content = False
        truncated = False
        for chunk in stream:
            # DeepSeek attaches usage to the final choice; compatible providers
            # may instead send a usage-only chunk with no choices.
            _capture_usage(chunk, usage_metrics)
            choices = chunk.get("choices") if isinstance(chunk, dict) else getattr(chunk, "choices", None)
            if choices and _finish_reason(choices[0]) == "length":
                truncated = True
            delta = _stream_chunk_delta(chunk)
            content = _extract_delta_field_text(delta, "content")
            if content:
                if content.strip():
                    seen_content = True
                yield {"kind": "content", "text": content}
                continue

            reasoning_content = _extract_delta_field_text(delta, "reasoning_content")
            if reasoning_content:
                yield {"kind": "reasoning", "text": reasoning_content}

        _raise_if_truncated("length" if truncated else "")
        if not seen_content:
            raise DeepSeekClientError(
                "Model stream ended without final content. Increase max_tokens or use a non-reasoning model for streaming generation."
            )
    except DeepSeekClientError:
        raise
    except AuthenticationError as exc:
        safe_message = _sanitize_error_message(exc, api_key)
        detail = f" Details: {safe_message}" if safe_message else ""
        raise DeepSeekClientError(
            f"DeepSeek API key validation failed. Check DEEPSEEK_API_KEY in .env.{detail}"
        ) from exc
    except RateLimitError as exc:
        safe_message = _sanitize_error_message(exc, api_key)
        detail = f" Details: {safe_message}" if safe_message else ""
        raise DeepSeekClientError(f"DeepSeek API rate limit or quota was reached. Try again later.{detail}") from exc
    except BadRequestError as exc:
        safe_message = _sanitize_error_message(exc, api_key)
        raise DeepSeekClientError(f"DeepSeek API rejected this request: {safe_message}") from exc
    except APIConnectionError as exc:
        safe_message = _sanitize_error_message(exc, api_key)
        detail = f" Details: {safe_message}" if safe_message else ""
        raise DeepSeekClientError(f"Unable to connect to DeepSeek API. Check network or proxy settings.{detail}") from exc
    except APIError as exc:
        safe_message = _sanitize_error_message(exc, api_key)
        raise DeepSeekClientError(f"DeepSeek API returned an error: {safe_message}") from exc
    except OpenAIError as exc:
        safe_message = _sanitize_error_message(exc, api_key)
        raise DeepSeekClientError(f"OpenAI SDK error while calling DeepSeek: {safe_message}") from exc
    except Exception as exc:
        safe_message = _sanitize_error_message(exc, api_key)
        raise DeepSeekClientError(f"Generation failed: {safe_message}") from exc
    finally:
        close = getattr(stream, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                pass


def stream_generate_text(
    messages: list[dict[str, str]],
    model: str | None = None,
    temperature: float = 0.7,
    max_tokens: int = 4000,
) -> Iterator[str]:
    """流式生成正文文本（不含推理过程）。

    仅产出 content；需要推理事件的调用方请使用 stream_generate_text_events。
    """
    for event in stream_generate_text_events(
        messages=messages,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
    ):
        if event["kind"] == "content":
            yield event["text"]
