"""services 层公共工具函数。

从各服务文件抽离的重复实现（此前 _read_json / _write_json_atomic /
_timestamp / _workspace_context / _clean_text 在 10+ 个文件中复制粘贴）。
统一行为说明：
- read_json：文件缺失返回 None；JSON 非法或非对象时抛 ValueError。
- timestamp：默认秒级精度，可传 timespec 参数（个别服务需要微秒级）。
- resolve_workspace_context：返回 (ctx, message, status_code, error_code)；
  FileNotFoundError 统一返回固定文案 "Project not found."（此前少数文件
  泄漏底层异常原文，已统一为更友好的固定文案）。
"""

from __future__ import annotations

import json
import secrets
from datetime import datetime
from pathlib import Path
from typing import Any

import file_manager

WORKSPACE_STORAGE_KIND = "workspace"


def clean_text(value: Any) -> str:
    """将任意值规整为去掉首尾空白的字符串。"""
    return str(value or "").strip()


def read_json(path: Path) -> dict[str, Any] | None:
    """读取 JSON 文件。文件不存在返回 None；内容非法或非对象抛 ValueError。"""
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path.name} is not valid JSON.") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{path.name} must be a JSON object.")
    return data


def write_json_atomic(path: Path, data: dict[str, Any]) -> None:
    """原子写入 JSON：先写临时文件再替换，避免写一半损坏数据。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    temp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_path.replace(path)


def timestamp(timespec: str = "seconds") -> str:
    """当前本地时区 ISO 时间戳，默认秒级精度。"""
    return datetime.now().astimezone().isoformat(timespec=timespec)


def resolve_workspace_context(
    project_ref: str,
    books_root: Path | None = None,
    *,
    resolve: Any = None,
    storage_message: str = "",
    storage_error_code: str = "",
) -> tuple[Any | None, str, int, str]:
    """解析 workspace 项目上下文，返回 (ctx, message, status_code, error_code)。

    - resolve：项目解析函数，默认 file_manager.resolve_project_context。
      各服务包装时传入本模块导入的 resolve_project_context 引用，
      以便测试可通过 patch 服务模块命名空间注入 mock。
    - 成功：ctx 为 ProjectContext，message/status_code/error_code 为空。
    - 失败：ctx 为 None，并带错误消息与 HTTP 状态码、错误码。
    """
    resolver = resolve if resolve is not None else file_manager.resolve_project_context
    ref = clean_text(project_ref)
    if not ref:
        return None, "Unknown project_ref.", 404, "project_not_found"
    try:
        ctx = resolver(ref, books_root=books_root)
    except FileNotFoundError:
        return None, "Project not found.", 404, "project_not_found"
    except ValueError as exc:
        return (
            None,
            str(exc) or "Unknown project_ref.",
            404,
            "project_not_found",
        )
    if ctx.storage_kind != WORKSPACE_STORAGE_KIND:
        return (
            None,
            storage_message or "Workspace project is required.",
            400,
            storage_error_code or "unsupported_project",
        )
    return ctx, "", 200, ""
