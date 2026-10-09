"""Bounded, cancellable image computations with the existing v2 connection envelope."""
from __future__ import annotations

import asyncio
import json
from time import monotonic

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from api.routers import compute
import cover_generation
from deepseek_client import DeepSeekClientError
from image_provider import IMAGE_ERRORS, ImageConfig, ImageProviderError, list_models, normalize_image_connection, request_image, validate_input
from model_client import ModelConfig
from provider_catalog import request_fingerprint
from provider_transport import DestinationRejected
from services.compute_service import ComputeError

router = APIRouter(prefix="/api/compute/images", tags=["image-compute"])
MAX_REQUEST_BYTES = 12 * 1024 * 1024
MAX_ERROR_SEND_SECONDS = 1.0
MAX_COVER_LINE_BYTES = 12 * 1024 * 1024
MAX_COVER_STREAM_BYTES = 48 * 1024 * 1024
MAX_COVER_PARSE_SECONDS = 30.0
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
    is_cover = operation in {"cover_generate", "cover_edit"}
    if not isinstance(credentials, dict) or set(credentials) - ({"api_key", "text_api_key"} if is_cover else {"api_key"}):
        raise ComputeError("图片凭据结构无效。", "invalid_credentials")
    try:
        connection = normalize_image_connection(payload["connection"], verify=operation != "validate_connection")
    except (ValueError, TypeError):
        raise ComputeError("图片连接无效或指纹不匹配，请重新保存连接。", "invalid_connection") from None
    data = payload.get("input")
    try:
        if is_cover:
            text_connection = cover_generation.validate_input(operation, data)
        else:
            compute._check_tree(data)
            validate_input(operation, data)
    except ComputeError:
        if is_cover:
            raise
        raise ComputeError("图片输入无效：提示词最多 6000 字；编辑原图需为 8 MiB 内的 PNG、JPEG 或 WebP。") from None
    except (ValueError, TypeError):
        if is_cover:
            raise ComputeError("封面素材、文字连接或编辑原图无效。", "invalid_cover_input") from None
        raise ComputeError("图片输入无效：提示词最多 6000 字；编辑原图需为 8 MiB 内的 PNG、JPEG 或 WebP。") from None
    fingerprint = request_fingerprint(connection, operation, data)
    if operation != "validate_connection" and payload.get("request_fingerprint") != fingerprint:
        raise ComputeError("图片请求参数指纹不匹配，未发送 Key。", "request_fingerprint")
    config = None
    if is_cover or operation in {"generate", "edit"} or (operation == "models" and connection["preset"] == "custom"):
        try:
            config = ImageConfig(connection, credentials.get("api_key", ""))
            if is_cover:
                if not connection["model"]:
                    raise ValueError("Missing image model")
                config = (config, ModelConfig(text_connection, credentials.get("text_api_key", ""), "cover_plan", cover_generation.PLAN_SCHEMA))
        except (ValueError, TypeError):
            raise ComputeError("请提供此图片连接的有效 API Key，或显式选择无认证。", "invalid_credentials") from None
    identity.update(protocol_version=2, request_fingerprint=fingerprint, destination_fingerprint=connection["destination_fingerprint"], execution_fingerprint=connection["execution_fingerprint"])
    if is_cover:
        identity.update(text_destination_fingerprint=text_connection["destination_fingerprint"], text_execution_fingerprint=text_connection["execution_fingerprint"])
    return identity, connection, config, data


def _exception(exc):
    if isinstance(exc, DestinationRejected):
        return 403, "destination_rejected", "图片目的地或下载域名未通过安全检查。"
    if isinstance(exc, asyncio.TimeoutError):
        return 504, "compute_timeout", "图片计算超时，上游结果未知且可能已产生费用；请核对记录，勿自动重试。"
    if isinstance(exc, ImageProviderError):
        code = exc.code if exc.code in IMAGE_ERRORS else "image_outcome_unknown"
        status, message = IMAGE_ERRORS[code]
        return status, code, message
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
    if operation in {"generate", "edit"}:
        from api.main import PUBLIC_MODE
        if PUBLIC_MODE:
            return compute._error(400, "controlled_cover_required", "请使用受控封面生成或编辑接口。")
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


async def _cover_body(identity, operation, data, configs, deadline):
    completed = sequence = total = 0
    iterator = cover_generation.generate(operation, data, *configs, deadline)

    def encode(payload):
        nonlocal sequence, total
        event = {**payload, **identity, "event_version": 1, "seq": sequence + 1}
        line = (json.dumps(event, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
        if len(line) > MAX_COVER_LINE_BYTES or total + len(line) > MAX_COVER_STREAM_BYTES:
            raise ValueError("Cover response capacity exceeded")
        sequence += 1
        total += len(line)
        return line

    try:
        yield encode({"type": "started", "requested": data["count"]})
        async for event in iterator:
            line = encode(event)
            if event["type"] == "image":
                completed += 1
            yield line
        yield encode({"type": "done", "completed": completed, "requested": data["count"]})
    except Exception as exc:
        status, code, message = _cover_exception(exc)
        # _exception never interpolates provider text, prompts, keys or URLs.
        yield encode({"type": "error", "code": code, "message": message, "status": status,
                      "completed": completed, "requested": data["count"]})
    finally:
        await iterator.aclose()


def _cover_exception(exc):
    if isinstance(exc, ComputeError):
        fixed = {"cover_unsuitable": "当前素材不适合生成封面，请调整创意后重试。",
                 "cover_missing_appearance": "人物卡中未找到明确外观描述，请补充「外貌特征：」「服饰：」等字段后重试。",
                 "invalid_cover_plan": "文字模型未返回有效封面方案，请检查连接后手动重试。",
                 "compute_busy": "当前计算请求较多，请稍后重试。"}
        return exc.status, exc.code if exc.code in fixed else "invalid_cover_input", fixed.get(exc.code, "封面请求字段、连接或素材无效。")
    return _exception(exc)


@router.post("/cover/{operation}", response_model=None)
async def cover_endpoint(operation: str, request: Request):
    if operation not in {"generate", "edit"}:
        return compute._error(404, "unknown_operation", "不支持的封面计算操作。")
    operation = "cover_" + operation
    acquired = False
    started = monotonic()
    try:
        identity, _, configs, data = await asyncio.wait_for(_parse(request, operation), MAX_COVER_PARSE_SECONDS)
        deadline = started + cover_generation.budget_seconds(data["count"])
        if not compute._CALLS.acquire(blocking=False):
            raise ComputeError("当前计算请求较多，请稍后重试。", "compute_busy", 429)
        acquired = True
        response = compute._PlanningComputeStream(_cover_body(identity, operation, data, configs, deadline), deadline)
        acquired = False  # Response owns the single shared slot through send and cleanup.
        return response
    except Exception as exc:
        status, code, message = _cover_exception(exc)
        return _ImageResponse({"error": {"code": code, "message": message}}, status_code=status,
                              deadline=monotonic() + MAX_ERROR_SEND_SECONDS)
    finally:
        if acquired:
            compute._CALLS.release()
