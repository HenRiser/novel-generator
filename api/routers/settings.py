from __future__ import annotations

from fastapi import APIRouter, HTTPException

from api.schemas import (
    ApiConfigStatusResponse,
    ApiConfigTestRequest,
    ApiConfigTestResponse,
    SaveApiConfigRequest,
    SaveApiConfigResponse,
)
from config_manager import (
    get_api_key_status,
    save_api_config,
    test_api_connection,
)


router = APIRouter(prefix="/api/settings", tags=["settings"])


def _error(status_code: int, code: str, message: str) -> None:
    raise HTTPException(
        status_code=status_code,
        detail={"error": {"code": code, "message": message}},
    )


@router.get("/api-config", response_model=ApiConfigStatusResponse)
def get_api_config_status() -> ApiConfigStatusResponse:
    """查看 API Key 配置状态（不返回明文 Key）。"""
    status = get_api_key_status()
    return ApiConfigStatusResponse(
        ok=True,
        configured=bool(status["configured"]),
        source=str(status["source"]),
        placeholder=bool(status["placeholder"]),
        env_exists=bool(status["env_exists"]),
        env_path=str(status["env_path"]),
        default_model=str(status["default_model"]),
        base_url=str(status["base_url"]),
        message="",
    )


@router.post("/api-config", response_model=SaveApiConfigResponse)
def save_api_config_endpoint(request: SaveApiConfigRequest) -> SaveApiConfigResponse:
    """保存 API Key / 默认模型 / Base URL 到本地 .env。

    - api_key 为空时保留现有 Key（用于只改模型或 Base URL）。
    - 写入后立即生效（更新进程环境变量），无需重启后端。
    """
    try:
        selected_model = save_api_config(
            api_key=request.api_key or "",
            default_model=request.default_model or "deepseek-v4-flash",
            custom_model=request.custom_model or "",
            base_url=request.base_url or "",
            require_api_key=bool(request.require_api_key),
        )
    except ValueError as exc:
        _error(400, "api_config_invalid", str(exc))
    return SaveApiConfigResponse(
        ok=True,
        default_model=selected_model,
        message="API 配置已保存到 .env。",
    )


@router.post("/api-config/test", response_model=ApiConfigTestResponse)
def test_api_config_endpoint(request: ApiConfigTestRequest) -> ApiConfigTestResponse:
    """使用给定（或已配置的）API Key 测试 DeepSeek 连接。"""
    ok, message = test_api_connection(
        api_key=request.api_key or "",
        model=request.model or "deepseek-v4-flash",
    )
    return ApiConfigTestResponse(ok=ok, message=message)
