"""Bound request-local input memory before any computation reads its body."""
from __future__ import annotations

import asyncio
from threading import Lock
from time import monotonic

import anyio
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from services.compute_service import ComputeError

MAX_TEXT_REQUEST_BYTES = 1024 * 1024
MAX_IMAGE_REQUEST_BYTES = 12 * 1024 * 1024
MAX_INGRESS_REQUESTS = 4
MAX_INGRESS_BYTES = 24 * 1024 * 1024
MAX_READ_SECONDS = 30.0
MAX_SEND_SECONDS = 30.0
MAX_REJECTION_SEND_SECONDS = 1.0


class _Admission:
    # ponytail: process-local reservations; keep one worker until a shared cap is needed.
    def __init__(self):
        self.lock = Lock()
        self.requests = self.bytes = 0

    def acquire(self, size: int) -> bool:
        with self.lock:
            if self.requests >= MAX_INGRESS_REQUESTS or self.bytes + size > MAX_INGRESS_BYTES:
                return False
            self.requests += 1
            self.bytes += size
            return True

    def release(self, size: int) -> None:
        with self.lock:
            self.requests -= 1
            self.bytes -= size


_ADMISSION = _Admission()


class _SendAborted(Exception):
    """An ASGI send has failed; another response cannot safely be sent."""


async def _bounded_io(coroutine, seconds: float):
    # The timeout cancels only this wait. Cancel the I/O task once outside the
    # AnyIO scope so its asynchronous cleanup survives repeated cancellation.
    work = asyncio.create_task(coroutine)
    try:
        with anyio.fail_after(seconds):
            return await asyncio.shield(work)
    finally:
        if not work.done():
            work.cancel()
        closing = asyncio.gather(work, return_exceptions=True)
        cancelled = False
        while not closing.done():
            try:
                await asyncio.shield(closing)
            except asyncio.CancelledError:
                cancelled = True
        closing.result()
        if cancelled:
            raise asyncio.CancelledError()


class ComputeIngressMiddleware:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] != "POST" or not scope["path"].startswith("/api/compute/"):
            await self.app(scope, receive, send)
            return

        limit = MAX_IMAGE_REQUEST_BYTES if scope["path"].startswith("/api/compute/images/") else MAX_TEXT_REQUEST_BYTES
        admission = _ADMISSION
        acquired = admission.acquire(limit)
        read_deadline = monotonic() + MAX_READ_SECONDS
        rejection_deadline = monotonic() + MAX_REJECTION_SEND_SECONDS
        body_complete = disconnected = False
        response_started = False
        response_finished = asyncio.Event()
        received = 0

        async def bounded_receive():
            nonlocal body_complete, disconnected, received
            if response_started and not body_complete:
                # Error responses must not drain a rejected or oversized upload while
                # their existing disconnect listener waits for the send to finish.
                await response_finished.wait()
                return {"type": "http.disconnect"}
            if body_complete:
                return await receive()
            try:
                remaining = read_deadline - monotonic()
                if remaining <= 0:
                    raise TimeoutError()
                message = await _bounded_io(receive(), remaining)
                if monotonic() >= read_deadline:
                    raise TimeoutError()
            except TimeoutError:
                raise ComputeError("请求上传超时，请手动重试。", "request_timeout", 408) from None
            if message["type"] == "http.disconnect":
                disconnected = body_complete = True
            elif message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise ComputeError("请求体超过大小限制。", "request_too_large", 413)
                body_complete = not message.get("more_body", False)
            return message

        async def bounded_send(message):
            nonlocal response_started
            response_started = True
            if disconnected:
                raise _SendAborted()
            remaining = MAX_SEND_SECONDS if acquired else min(MAX_SEND_SECONDS, rejection_deadline - monotonic())
            try:
                if remaining <= 0:
                    raise TimeoutError()
                await _bounded_io(send(message), remaining)
                if message["type"] == "http.response.body" and not message.get("more_body", False):
                    response_finished.set()
            except Exception:
                # Do not echo transport exceptions or send a second set of headers.
                raise _SendAborted() from None

        try:
            if not acquired:
                response = JSONResponse(
                    {"error": {"code": "compute_busy", "message": "当前计算请求较多，请稍后重试。"}},
                    status_code=429,
                    headers={"Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no"},
                )
                await response(scope, receive, bounded_send)
                return
            await self.app(scope, bounded_receive, bounded_send)
        except _SendAborted:
            pass
        finally:
            if acquired:
                admission.release(limit)
