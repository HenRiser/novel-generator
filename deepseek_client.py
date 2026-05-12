import os
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


def _get_api_key() -> str:
    load_dotenv()
    api_key = os.getenv("DEEPSEEK_API_KEY", "").strip()

    if not api_key or api_key == "your_api_key_here":
        raise DeepSeekClientError(
            "未检测到有效的 DEEPSEEK_API_KEY。请复制 .env.example 为 .env，并填写你的 DeepSeek API Key。"
        )

    return api_key


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
    client = OpenAI(api_key=api_key, base_url=DEEPSEEK_BASE_URL)

    try:
        response: Any = client.chat.completions.create(
            model=(model or DEFAULT_MODEL).strip() or DEFAULT_MODEL,
            messages=messages,
            temperature=float(temperature),
            max_tokens=int(max_tokens),
        )
    except AuthenticationError as exc:
        raise DeepSeekClientError("DeepSeek API Key 校验失败，请检查 .env 中的 DEEPSEEK_API_KEY。") from exc
    except RateLimitError as exc:
        raise DeepSeekClientError("DeepSeek API 请求过于频繁或额度受限，请稍后再试。") from exc
    except BadRequestError as exc:
        raise DeepSeekClientError(f"DeepSeek API 拒绝了本次请求：{exc}") from exc
    except APIConnectionError as exc:
        raise DeepSeekClientError("无法连接 DeepSeek API，请检查网络连接或代理设置。") from exc
    except APIError as exc:
        raise DeepSeekClientError(f"DeepSeek API 返回异常：{exc}") from exc
    except OpenAIError as exc:
        raise DeepSeekClientError(f"OpenAI SDK 调用 DeepSeek 时发生错误：{exc}") from exc
    except Exception as exc:
        raise DeepSeekClientError(f"生成失败：{exc}") from exc

    if not getattr(response, "choices", None):
        raise DeepSeekClientError("模型没有返回候选结果。")

    content = response.choices[0].message.content
    if not content or not content.strip():
        raise DeepSeekClientError("模型返回内容为空，请调整 Prompt 或稍后重试。")

    return content.strip()
