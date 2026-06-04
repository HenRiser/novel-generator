from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

from dotenv import dotenv_values

from config import DEEPSEEK_BASE_URL, DEFAULT_MODEL, DEEPSEEK_MODELS, PROJECT_ROOT


API_KEY_PLACEHOLDER = "your_api_key_here"
DEFAULT_ENV_LINES = [
    "DEEPSEEK_API_KEY=your_api_key_here",
    f"DEEPSEEK_BASE_URL={DEEPSEEK_BASE_URL}",
    f"DEFAULT_MODEL={DEFAULT_MODEL}",
]
_ENV_KEY_PATTERN = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")


def get_project_root() -> Path:
    return PROJECT_ROOT


def get_env_path() -> Path:
    return get_project_root() / ".env"


def _get_env_example_path() -> Path:
    return get_project_root() / ".env.example"


def _is_real_api_key(value: str | None) -> bool:
    api_key = (value or "").strip()
    return bool(api_key and api_key != API_KEY_PLACEHOLDER)


def _read_env_values() -> dict[str, str]:
    env_path = get_env_path()
    if not env_path.exists():
        return {}

    values = dotenv_values(env_path)
    return {key: (value or "").strip() for key, value in values.items() if key}


def _read_configured_api_key() -> str:
    values = _read_env_values()
    file_value = values.get("DEEPSEEK_API_KEY", "")
    if _is_real_api_key(file_value):
        return file_value

    process_value = os.getenv("DEEPSEEK_API_KEY", "").strip()
    if _is_real_api_key(process_value):
        return process_value

    return ""


def has_api_key() -> bool:
    return bool(_read_configured_api_key())


def get_current_default_model() -> str:
    values = _read_env_values()
    model = values.get("DEFAULT_MODEL") or os.getenv("DEFAULT_MODEL", "") or DEFAULT_MODEL
    model = model.strip()
    if not model or model == "custom":
        return DEFAULT_MODEL
    return model


def get_current_base_url() -> str:
    values = _read_env_values()
    base_url = values.get("DEEPSEEK_BASE_URL") or os.getenv("DEEPSEEK_BASE_URL", "") or DEEPSEEK_BASE_URL
    return base_url.strip() or DEEPSEEK_BASE_URL


def get_api_key_status() -> dict[str, object]:
    values = _read_env_values()
    file_value = values.get("DEEPSEEK_API_KEY", "")
    process_value = os.getenv("DEEPSEEK_API_KEY", "").strip()
    file_configured = _is_real_api_key(file_value)
    process_configured = _is_real_api_key(process_value)

    if file_configured:
        source = ".env"
    elif process_configured:
        source = "environment"
    else:
        source = "missing"

    return {
        "env_exists": get_env_path().exists(),
        "env_path": str(get_env_path()),
        "configured": file_configured or process_configured,
        "placeholder": file_value == API_KEY_PLACEHOLDER or process_value == API_KEY_PLACEHOLDER,
        "source": source,
        "default_model": get_current_default_model(),
        "base_url": get_current_base_url(),
    }


def _ensure_env_file() -> Path:
    env_path = get_env_path()
    if env_path.exists():
        return env_path

    example_path = _get_env_example_path()
    if example_path.exists():
        shutil.copyfile(example_path, env_path)
    else:
        env_path.write_text("\n".join(DEFAULT_ENV_LINES) + "\n", encoding="utf-8")

    return env_path


def _line_ending(line: str) -> str:
    if line.endswith("\r\n"):
        return "\r\n"
    if line.endswith("\n"):
        return "\n"
    return "\n"


def update_env_value(key: str, value: str) -> None:
    key = key.strip()
    value = value.strip()
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
        raise ValueError("环境变量名不合法。")
    if key == "DEEPSEEK_API_KEY" and not _is_real_api_key(value):
        raise ValueError("请填写有效的 DeepSeek API Key。")
    if key == "DEFAULT_MODEL" and not value:
        raise ValueError("默认模型名不能为空。")

    env_path = _ensure_env_file()
    lines = env_path.read_text(encoding="utf-8").splitlines(keepends=True)
    updated_lines: list[str] = []
    found = False

    for line in lines:
        match = _ENV_KEY_PATTERN.match(line)
        if match and match.group(1) == key:
            updated_lines.append(f"{key}={value}{_line_ending(line)}")
            found = True
        else:
            updated_lines.append(line)

    if not found:
        if updated_lines and not updated_lines[-1].endswith(("\n", "\r")):
            updated_lines[-1] += "\n"
        updated_lines.append(f"{key}={value}\n")

    env_path.write_text("".join(updated_lines), encoding="utf-8")
    os.environ[key] = value


def get_available_models() -> list[str]:
    return list(DEEPSEEK_MODELS)


def resolve_selected_model(model_choice: str, custom_model: str) -> str:
    model_choice = (model_choice or "").strip()
    custom_model = (custom_model or "").strip()

    if model_choice == "custom":
        return custom_model or DEFAULT_MODEL
    if model_choice:
        return model_choice
    return DEFAULT_MODEL


def _validate_base_url(base_url: str) -> str:
    cleaned = (base_url or "").strip() or DEEPSEEK_BASE_URL
    if not cleaned.startswith(("http://", "https://")):
        raise ValueError("Base URL 必须以 http:// 或 https:// 开头。")
    return cleaned.rstrip("/")


def save_api_config(
    api_key: str,
    default_model: str,
    custom_model: str = "",
    base_url: str = "",
    require_api_key: bool = True,
) -> str:
    selected_model = resolve_selected_model(default_model, custom_model)
    cleaned_api_key = (api_key or "").strip()
    if cleaned_api_key:
        if not _is_real_api_key(cleaned_api_key):
            raise ValueError("请填写有效的 DeepSeek API Key 后再保存。")
        update_env_value("DEEPSEEK_API_KEY", cleaned_api_key)
    elif require_api_key or not _read_configured_api_key():
        raise ValueError("请填写有效的 DeepSeek API Key 后再保存。")

    update_env_value("DEEPSEEK_BASE_URL", _validate_base_url(base_url))
    update_env_value("DEFAULT_MODEL", selected_model)
    return selected_model


def test_api_connection(api_key: str, model: str) -> tuple[bool, str]:
    from deepseek_client import test_deepseek_connection

    effective_api_key = (api_key or "").strip() or _read_configured_api_key()
    if not _is_real_api_key(effective_api_key):
        return False, "请先输入有效的 DeepSeek API Key，或先在本地 .env 中配置。"

    return test_deepseek_connection(api_key=effective_api_key, model=model)
