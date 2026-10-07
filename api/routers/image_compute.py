"""Bounded, cancellable image computations with the existing v2 connection envelope."""
from __future__ import annotations

import asyncio
import json
from time import monotonic

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from api.routers import compute
from deepseek_client import DeepSeekClientError
from image_provider import ImageConfig, list_models, normalize_image_connection, request_image, validate_input
from provider_catalog import request_fingerprint
from provider_transport import DestinationRejected
from services.compute_service import ComputeError

router = APIRouter(prefix="/api/compute/images", tags=["image-compute"])
MAX_REQUEST_BYTES = 12 * 1024 * 1024
MAX_ERROR_SEND_SECONDS = 1.0
OPERATIONS = {"validate_connection", "models", "generate", "edit"}


async def _parse(request, operation):
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise ComputeError("请求必须使用 application/json。", "invalid_content_type", 415)
    length = request.headers.get("content-length")
    if length is not None and (not length.isdigit() or int(length) > MAX_REQUEST_BYTES):
        raise ComputeError("图片请求长度无效或超过 12 MiB。", "request_too_large", 413)
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > MAX_REQUEST_BYTES:
            raise ComputeError("图片请求超过 12 MiB。", "request_too_large", 413)
        raw.extend(chunk)
    try:
        payload = json.loads(raw.decode("utf-8"), parse_constant=lambda _: None)
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise ComputeError("请求必须是有效 UTF-8 JSON。") from None
    fields = {"run_id", "step_id", "attempt_id", "input_revision", "credentials", "input", "connection", "protocol_version", "request_fingerprint"}
    if not isinstance(payload, dict) or set(payload) - fields:
        raise ComputeError("图片请求结构无效。")
    identity = {name: payload.get(name) for name in ("run_id", "step_id", "attempt_id", "input_revision")}
    if any(not isinstance(identity[k], str) or not compute._ID_RE.fullmatch(identity[k]) for k in ("run_id", "step_id", "attempt_id")) or type(identity["input_revision"]) is not int or not 0 <= identity["input_revision"] <= 2**53 - 1:
        raise ComputeError("任务标识或输入版本无效。", "invalid_identity")
    if type(payload.get("protocol_version")) is not int or payload["protocol_version"] != 2 or "connection" not in payload:
        raise ComputeError("图片计算需要 v2 连接协议。", "protocol_version")
    credentials = payload.get("credentials", {})
    if not isinstance(credentials, dict) or set(credentials) - {"api_key"}:
        raise ComputeError("图片凭据结构无效。", "invalid_credentials")
    try:
        connection = normalize_image_connection(payload["connection"], verify=operation != "validate_connection")
    except (ValueError, TypeError):
        raise ComputeError("图片连接无效或指纹不匹配，请重新保存连接。", "invalid_connection") from None
    data = payload.get("input")
    compute._check_tree(data)
    try:
        validate_input(operation, data)
    except (ValueError, TypeError):
        raise ComputeError("图片输入无效：提示词最多 6000 字；编辑原图需为 8 MiB 内的 PNG、JPEG 或 WebP。") from None
    fingerprint = request_fingerprint(connection, operation, data)
    if operation != "validate_connection" and payload.get("request_fingerprint") != fingerprint:
        raise ComputeError("图片请求参数指纹不匹配，未发送 Key。", "request_fingerprint")
    config = None
    if operation in {"generate", "edit"} or (operation == "models" and connection["preset"] == "custom"):
        try:
            config = ImageConfig(connection, credentials.get("api_key", ""))
        except (ValueError, TypeError):
            raise ComputeError("请提供此图片连接的有效 API Key，或显式选择无认证。", "invalid_credentials") from None
    identity.update(protocol_version=2, request_fingerprint=fingerprint, destination_fingerprint=connection["destination_fingerprint"], execution_fingerprint=connection["execution_fingerprint"])
    return identity, connection, config, data


def _exception(exc):
    if isinstance(exc, DestinationRejected):
        return 403, "destination_rejected", "图片目的地或下载域名未通过安全检查。"
    if isinstance(exc, asyncio.TimeoutError):
        return 504, "compute_timeout", "图片计算超时，请手动重试。"
    if isinstance(exc, DeepSeekClientError):
        return 502, "provider_error", "图片服务请求失败，请检查 Key、模型权限、额度及参数后手动重试。"
    if isinstance(exc, ComputeError):
        return exc.status, exc.code, exc.message
    if isinstance(exc, (ValueError, TypeError, KeyError, RecursionError)):
        return 400, "invalid_input", "图片请求字段或连接无效。"
    return 500, "internal_error", "图片计算未完成，请手动重试。"


class _ImageResponse(JSONResponse):
    """Own admission through the real ASGI send and its cancellation cleanup."""

    def __init__(self, content, *, deadline, release=None, status_code=200):
        super().__init__(content, status_code=status_code, headers=compute.HEADERS)
        self.deadline, self.release = deadline, release

    async def __call__(self, scope, receive, send):
        async def send_before_deadline(message):
            if monotonic() >= self.deadline:
                raise asyncio.TimeoutError()
            await send(message)

        work = asyncio.create_task(super().__call__(scope, receive, send_before_deadline))
        disconnected = asyncio.create_task(compute._disconnect(Request(scope, receive)))
        try:
            finished, _ = await asyncio.wait({work, disconnected}, timeout=max(0, self.deadline - monotonic()),
                                              return_when=asyncio.FIRST_COMPLETED)
            if work in finished:
                try:
                    await work
                except Exception:
                    pass  # A failed or expired send cannot safely receive another response.
        finally:
            async def cleanup():
                try:
                    for task in (work, disconnected):
                        if not task.done():
                            task.cancel()
                    await asyncio.gather(work, disconnected, return_exceptions=True)
                finally:
                    if self.release is not None:
                        self.release()
            closing = asyncio.create_task(cleanup())
            cancelled = False
            while not closing.done():
                try:
                    await asyncio.shield(closing)
                except asyncio.CancelledError:
                    cancelled = True
            await closing
            if cancelled:
                raise asyncio.CancelledError()


@router.post("/{operation}", response_model=None)
async def image_endpoint(operation: str, request: Request):
    if operation not in OPERATIONS:
        return compute._error(404, "unknown_operation", "不支持的图片计算操作。")
    acquired = False
    started = monotonic()
    deadline = started + compute.MAX_COMPUTE_SECONDS
    try:
        identity, connection, config, data = await asyncio.wait_for(_parse(request, operation), max(0, deadline - monotonic()))
        metrics = {}
        if operation == "validate_connection":
            result = {"connection": connection}
        else:
            if operation in {"generate", "edit"} or connection["preset"] == "custom":
                if not compute._CALLS.acquire(blocking=False):
                    raise ComputeError("当前计算请求较多，请稍后重试。", "compute_busy", 429)
                acquired = True
            if operation == "models":
                # Preset suggestions need no credentials and do not assert account access.
                result = await compute._connected(request, asyncio.wait_for(list_models(config or connection), max(0, deadline - monotonic())))
            else:
                result = await compute._connected(request, asyncio.wait_for(request_image(config, operation, data, metrics), max(0, deadline - monotonic())))
        response = _ImageResponse({**identity, "result": result, "metrics": compute._metrics("image_" + operation, started, metrics)},
                                  deadline=deadline, release=compute._CALLS.release if acquired else None)
        acquired = False  # The ASGI response now owns this slot through its final send cleanup.
        return response
    except Exception as exc:
        status, code, message = _exception(exc)
        # Cancellation cleanup can finish after the computation deadline. Allow only the
        # small error JSON a fresh, bounded send window so clients can receive the 504.
        response = _ImageResponse({"error": {"code": code, "message": message}}, deadline=monotonic() + MAX_ERROR_SEND_SECONDS,
                                  release=compute._CALLS.release if acquired else None, status_code=status)
        acquired = False
        return response
    finally:
        if acquired:
            compute._CALLS.release()
