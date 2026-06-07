import os
import re
from typing import Any

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
