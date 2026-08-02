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


def _extract_message_text(message: Any) -> str:
    """Extract readable text from OpenAI-style message objects or dicts."""
    candidates = [
        getattr(message, "content", None),
        # Some DeepSeek models return readable text in reasoning_content; keep
        # connection tests and generation behavior consistent by sharing fallback.
        getattr(message, "reasoning_content", None),
    ]
    if isinstance(message, dict):
        candidates.extend([message.get("content"), message.get("reasoning_content")])

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

    content = _extract_message_text(response.choices[0].message)
    if not content:
        return False, "API 请求完成，但模型返回内容为空。"

    return True, f"连接成功，模型 {safe_model} 返回了有效响应。"


def generate_text(
    messages: list[dict[str, str]],
    model: str | None = None,
    temperature: float = 0.7,
    max_tokens: int = 4000,
) -> str:
    """Call DeepSeek through the OpenAI-compatible Chat Completions API."""
    if not messages:
        raise DeepSeekClientError("Prompt 为空，无法生成内容。")

    api_key = _get_api_key()
    client = OpenAI(api_key=api_key, base_url=_get_base_url())

    try:
        response: Any = client.chat.completions.create(
            model=(model or DEFAULT_MODEL).strip() or DEFAULT_MODEL,
            messages=messages,
            temperature=float(temperature),
            max_tokens=int(max_tokens),
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

    if not getattr(response, "choices", None):
        raise DeepSeekClientError("模型没有返回候选结果。")

    content = _extract_message_text(response.choices[0].message)
    if not content:
        raise DeepSeekClientError("模型返回内容为空，请调整 Prompt 或稍后重试。")

    return content


def stream_generate_text_events(
    messages: list[dict[str, str]],
    model: str | None = None,
    temperature: float = 0.7,
    max_tokens: int = 4000,
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

    try:
        stream = client.chat.completions.create(
            model=(model or DEFAULT_MODEL).strip() or DEFAULT_MODEL,
            messages=messages,
            temperature=float(temperature),
            max_tokens=int(max_tokens),
            stream=True,
        )
        seen_content = False
        reasoning_fallback_chunks: list[str] = []
        for chunk in stream:
            delta = _stream_chunk_delta(chunk)
            content = _extract_delta_field_text(delta, "content")
            if content:
                if not seen_content:
                    seen_content = True
                    reasoning_fallback_chunks.clear()
                yield {"kind": "content", "text": content}
                continue

            reasoning_content = _extract_delta_field_text(delta, "reasoning_content")
            if reasoning_content:
                reasoning_fallback_chunks.append(reasoning_content)
                yield {"kind": "reasoning", "text": reasoning_content}

        if not seen_content and reasoning_fallback_chunks:
            raise DeepSeekClientError(
                "Model stream ended without final content. Increase max_tokens or use a non-reasoning model for streaming generation."
            )
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
