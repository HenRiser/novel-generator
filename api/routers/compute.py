"""Request-scoped computations. No project files, stored credentials or jobs."""
from __future__ import annotations

import asyncio
import json
import re
from threading import BoundedSemaphore
from time import monotonic
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import ValidationError
from deepseek_client import DeepSeekClientError, ProviderConfig, MODEL_TIMEOUT_SECONDS
from provider_catalog import catalog, normalize_connection, request_fingerprint, PROTOCOLS
from provider_transport import DestinationRejected
from model_client import ModelConfig
from services.compute_service import MODEL_OPERATIONS, OPERATIONS, STREAM_OPERATIONS, ComputeError, compute as run_compute, stream_compute

router = APIRouter(prefix="/api", tags=["compute"])
PROTOCOL_VERSION = 2
MAX_REQUEST_BYTES = 1024 * 1024
MAX_MODEL_SECONDS = MODEL_TIMEOUT_SECONDS
MAX_COMPUTE_SECONDS = 180.0
MAX_CONCURRENT_CALLS = 2
# ponytail: a process-local cap; run one worker until a shared admission limit is needed.
_CALLS = BoundedSemaphore(MAX_CONCURRENT_CALLS)
_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
HEADERS = {"Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no"}


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status, headers=HEADERS)


def _exception(exc: Exception) -> tuple[int, str, str]:
    if isinstance(exc, DestinationRejected):
        return 403, 'destination_rejected', str(exc)
    if isinstance(exc, ComputeError):
        return exc.status, exc.code, exc.message
    if isinstance(exc, asyncio.TimeoutError):
        return 504, "compute_timeout", "计算超时，已保存内容保留。请手动重试。"
    if isinstance(exc, DeepSeekClientError):
        return 502, "provider_error", str(exc)
    if isinstance(exc, (ValidationError, ValueError, TypeError, KeyError, RecursionError)):
        return 400, "invalid_input", "计算输入格式无效，请检查字段与版本。"
    return 500, "internal_error", "计算未完成，请稍后重试。"


def _check_tree(value: Any, depth: int = 0) -> None:
    if depth > 60:
        raise ComputeError("输入嵌套过深。")
    if isinstance(value, dict):
        for key, item in value.items():
            if key in {"__proto__", "constructor", "prototype", "base_url", "api_key", "credentials"}:
                raise ComputeError("输入包含不允许的字段。")
            _check_tree(item, depth + 1)
    elif isinstance(value, list):
        for item in value:
            _check_tree(item, depth + 1)


async def _parse(request: Request, operation: str):
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise ComputeError("请求必须使用 application/json。", "invalid_content_type", 415)
    length = request.headers.get("content-length")
    if length is not None:
        if not length.isdigit():
            raise ComputeError("请求长度无效。")
        if int(length) > MAX_REQUEST_BYTES:
            raise ComputeError("本次计算请求超过 1 MiB。", "request_too_large", 413)
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > MAX_REQUEST_BYTES:
            raise ComputeError("本次计算请求超过 1 MiB。", "request_too_large", 413)
        raw.extend(chunk)
    try:
        payload = json.loads(raw.decode("utf-8"), parse_constant=lambda _: None)
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise ComputeError("请求必须是有效 UTF-8 JSON。") from None
    if not isinstance(payload, dict) or set(payload) - {"run_id", "step_id", "attempt_id", "input_revision", "credentials", "input", "connection", "protocol_version", "request_fingerprint"}:
        raise ComputeError("请求结构无效。")
    identity = {name: payload.get(name) for name in ("run_id", "step_id", "attempt_id", "input_revision")}
    if any(not isinstance(identity[k], str) or not _ID_RE.fullmatch(identity[k]) for k in ("run_id", "step_id", "attempt_id")) or type(identity["input_revision"]) is not int or not 0 <= identity["input_revision"] <= 2**53 - 1:
        raise ComputeError("任务标识或输入版本无效。", "invalid_identity")
    credentials, data = payload.get("credentials", {}), payload.get("input")
    version = payload.get('protocol_version')
    is_v1 = version is None and 'protocol_version' not in payload and 'connection' not in payload
    if not is_v1 and (version != 2 or type(version) is not int or 'connection' not in payload):
        raise ComputeError('连接协议版本无效，请刷新客户端。', 'protocol_version', 400)
    if not isinstance(credentials, dict) or set(credentials) - ({'api_key','model'} if is_v1 else {'api_key'}):
        raise ComputeError('凭据结构无效。', 'invalid_credentials')
    if not isinstance(data, dict): raise ComputeError('input 必须是JSON对象。')
    _check_tree(data)
    if not is_v1:
        try: connection = normalize_connection(payload['connection'], verify=operation != 'validate_connection')
        except ValueError as exc: raise ComputeError(str(exc), 'invalid_connection') from None
        expected_fingerprint = request_fingerprint(connection, operation, data)
        if operation != 'validate_connection' and payload.get('request_fingerprint') != expected_fingerprint:
            raise ComputeError('本次请求参数指纹不匹配，未发送Key。', 'request_fingerprint')
        credentials = {**credentials, '_connection':connection}
        identity.update(protocol_version=2, request_fingerprint=expected_fingerprint, destination_fingerprint=connection['destination_fingerprint'], execution_fingerprint=connection['execution_fingerprint'])
        if operation in MODEL_OPERATIONS:
            try: ModelConfig(connection, credentials.get('api_key',''), operation)
            except (ValueError,TypeError): raise ComputeError('请提供此连接的有效API Key，或显式选择无认证模式。','invalid_credentials') from None
    elif operation in {'list_models','validate_connection'}:
        raise ComputeError('该操作需要v2连接协议。')
    elif operation in MODEL_OPERATIONS:
        try: ProviderConfig(credentials.get('api_key',''), credentials.get('model') or 'deepseek-v4-flash')
        except (DeepSeekClientError,TypeError): raise ComputeError('请提供本次DeepSeek请求的有效Key与模型名。','invalid_credentials') from None
    return identity, credentials, data


def _acquire(operation: str) -> bool:
    if operation not in MODEL_OPERATIONS:
        return False
    if not _CALLS.acquire(blocking=False):
        raise ComputeError("当前计算请求较多，请稍后重试。", "compute_busy", 429)
    return True


def _metrics(operation: str, started: float, metrics: dict[str, Any]):
    fields = {"call_count", "prompt_tokens", "completion_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens", "reasoning_tokens", "first_content_ms", "body_complete_ms", "repair_used"}
    return {**{k: v for k, v in metrics.items() if k in fields and (v is None or type(v) in (int, float, bool))},
            "operation": operation, "protocol_version": PROTOCOL_VERSION, "elapsed_ms": round((monotonic() - started) * 1000, 1)}


async def _disconnect(request: Request):
    while (await request.receive())["type"] != "http.disconnect":
        pass


async def _connected(request: Request, coroutine):
    work = asyncio.create_task(coroutine)
    disconnected = asyncio.create_task(_disconnect(request))
    try:
        done, _ = await asyncio.wait({work, disconnected}, return_when=asyncio.FIRST_COMPLETED)
        if disconnected in done and work not in done:
            raise asyncio.CancelledError()
        return await work
    finally:
        for task in (work, disconnected):
            if not task.done():
                task.cancel()
        await asyncio.gather(work, disconnected, return_exceptions=True)


@router.get("/capabilities", response_model=None)
async def capabilities():
    return JSONResponse({"protocol_version": PROTOCOL_VERSION, "operations": sorted(OPERATIONS), "stream_operations": sorted(STREAM_OPERATIONS),
        "provider": {"name": "deepseek", "official_base_url": "https://api.deepseek.com"}, "providers": catalog(), "supported_protocols": PROTOCOLS,
        "limits": {"max_request_bytes": MAX_REQUEST_BYTES, "max_concurrent_calls": MAX_CONCURRENT_CALLS, "max_model_seconds": MAX_MODEL_SECONDS, "max_compute_seconds": MAX_COMPUTE_SECONDS},
        "persistence": {"projects": False, "chapters": False, "credentials": False, "background_tasks": False}}, headers=HEADERS)


@router.post("/compute/{operation}", response_model=None)
async def compute_endpoint(operation: str, request: Request):
    if operation not in OPERATIONS:
        return _error(404, "unknown_operation", "不支持的计算操作。")
    acquired = False
    try:
        identity, credentials, data = await asyncio.wait_for(_parse(request, operation), MAX_COMPUTE_SECONDS)
        acquired = _acquire(operation)
        metrics: dict[str, Any] = {}
        started = monotonic()
        result = await _connected(request, asyncio.wait_for(run_compute(operation, data, credentials, metrics), MAX_COMPUTE_SECONDS))
        return JSONResponse({**identity, "result": result, "metrics": _metrics(operation, started, metrics)}, headers=HEADERS)
    except Exception as exc:
        return _error(*_exception(exc))
    finally:
        if acquired:
            _CALLS.release()


class _ComputeStream(StreamingResponse):
    # Own admission for the entire ASGI response, even when disconnected before iteration.
    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            try:
                await self.body_iterator.aclose()
            except Exception:
                pass  # A cleanup error must not log provider bodies after response headers were sent.
            finally:
                _CALLS.release()


async def _stream_body(operation, identity, data, credentials):
    started = monotonic()
    metrics: dict[str, Any] = {}
    iterator = stream_compute(operation, data, credentials, metrics)
    try:
        while True:
            remaining = MAX_COMPUTE_SECONDS - (monotonic() - started)
            if remaining <= 0:
                raise asyncio.TimeoutError()
            try:
                event = await asyncio.wait_for(iterator.__anext__(), remaining)
            except StopAsyncIteration:
                break
            event = {**event, **identity}
            if event.get("type") == "done":
                event["metrics"] = _metrics(operation, started, metrics)
            yield (json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8")
    except Exception as exc:
        status, code, message = _exception(exc)
        yield (json.dumps({**identity, "type": "error", "code": code, "message": message, "status": status}, ensure_ascii=False) + "\n").encode("utf-8")
    finally:
        try:
            await iterator.aclose()
        except Exception:
            pass  # Admission release is owned by _ComputeStream, not this iterator.


@router.post("/compute/{operation}/stream", response_model=None)
async def compute_stream_endpoint(operation: str, request: Request):
    if operation not in STREAM_OPERATIONS:
        return _error(400, "stream_not_supported", "该操作不支持流式计算。")
    try:
        identity, credentials, data = await asyncio.wait_for(_parse(request, operation), MAX_COMPUTE_SECONDS)
        _acquire(operation)
    except Exception as exc:
        return _error(*_exception(exc))
    return _ComputeStream(_stream_body(operation, identity, data, credentials), media_type="application/x-ndjson", headers=HEADERS)
