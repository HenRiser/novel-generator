from __future__ import annotations

import asyncio
import json
from threading import BoundedSemaphore
from time import monotonic
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from api import ingress, main
from api.routers import compute, image_compute


def payload():
    return json.dumps({"run_id": "ingress", "step_id": "test", "attempt_id": "once", "input_revision": 0,
                       "credentials": {}, "input": {}}).encode()


class IngressHarness:
    def __init__(self, path="/api/compute/validate_project", *, chunks=None, more_body=False,
                 length=None, delay=0, send_hook=None, spec="2.4", content_type=b"application/json"):
        self.path = path
        self.chunks = list(chunks if chunks is not None else [payload()])
        self.more_body, self.length, self.delay = more_body, length, delay
        self.send_hook, self.spec, self.content_type = send_hook, spec, content_type
        self.disconnect = asyncio.Event()
        self.waiting = asyncio.Event()
        self.reads = self.active_readers = self.max_readers = 0
        self.messages, self.send_attempts = [], []

    async def receive(self):
        self.reads += 1
        self.active_readers += 1
        self.max_readers = max(self.max_readers, self.active_readers)
        try:
            if self.chunks:
                if self.delay:
                    await asyncio.sleep(self.delay)
                chunk = self.chunks.pop(0)
                return {"type": "http.request", "body": chunk, "more_body": bool(self.chunks) or self.more_body}
            self.waiting.set()
            await self.disconnect.wait()
            return {"type": "http.disconnect"}
        finally:
            self.active_readers -= 1

    async def send(self, message):
        self.send_attempts.append(message)
        if self.send_hook is not None:
            await self.send_hook(message)
        self.messages.append(message)

    async def run(self):
        headers = [(b"content-type", self.content_type), (b"origin", b"https://braipen.world")]
        if self.length is not None:
            headers.append((b"content-length", str(self.length).encode()))
        scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": self.spec},
                 "http_version": "1.1", "method": "POST", "scheme": "http", "path": self.path,
                 "raw_path": self.path.encode(), "query_string": b"", "root_path": "",
                 "server": ("test", 80), "client": ("test", 123), "headers": headers}
        await main.app(scope, self.receive, self.send)

    @property
    def status(self):
        return next((message["status"] for message in self.messages if message["type"] == "http.response.start"), None)

    @property
    def error(self):
        return json.loads(b"".join(message.get("body", b"") for message in self.messages))["error"]


class ComputeIngressTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.admission = ingress._Admission()
        self.calls = BoundedSemaphore(2)
        self.tasks = []
        for replacement in (patch.object(ingress, "_ADMISSION", self.admission),
                            patch.object(compute, "_CALLS", self.calls), patch.object(main, "PUBLIC_MODE", True)):
            replacement.start()
            self.addCleanup(replacement.stop)

    async def asyncTearDown(self):
        for task in self.tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)

    def start(self, harness):
        task = asyncio.create_task(harness.run())
        self.tasks.append(task)
        return task

    def assert_free(self):
        self.assertEqual((self.admission.requests, self.admission.bytes), (0, 0))
        self.assertTrue(self.calls.acquire(False))
        self.assertTrue(self.calls.acquire(False))
        self.assertFalse(self.calls.acquire(False))
        self.calls.release()
        self.calls.release()

    async def test_request_capacity_rejects_before_receive_even_when_model_slots_are_full(self):
        self.calls.acquire()
        self.calls.acquire()
        uploads = [IngressHarness(chunks=[b"{"], more_body=True) for _ in range(4)]
        tasks = [self.start(upload) for upload in uploads]
        try:
            await asyncio.wait_for(asyncio.gather(*(upload.waiting.wait() for upload in uploads)), 2)
            self.assertEqual((self.admission.requests, self.admission.bytes), (4, 4 * 1024 * 1024))
            rejected = IngressHarness()
            await rejected.run()
            self.assertEqual(rejected.reads, 0)
            self.assertEqual(rejected.status, 429)
            self.assertEqual(rejected.error["code"], "compute_busy")
            self.assertIn((b"access-control-allow-origin", b"https://braipen.world"), rejected.messages[0]["headers"])
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            self.calls.release()
            self.calls.release()
        self.assertTrue(all(upload.active_readers == 0 for upload in uploads))
        self.assert_free()

    async def test_image_reservations_bound_total_raw_body_capacity(self):
        uploads = [IngressHarness("/api/compute/images/cover/generate", chunks=[b"{"], more_body=True) for _ in range(2)]
        tasks = [self.start(upload) for upload in uploads]
        try:
            await asyncio.wait_for(asyncio.gather(*(upload.waiting.wait() for upload in uploads)), 2)
            self.assertEqual((self.admission.requests, self.admission.bytes), (2, 24 * 1024 * 1024))
            for path in ("/api/compute/validate_project", "/api/compute/images/validate_connection"):
                rejected = IngressHarness(path)
                await rejected.run()
                self.assertEqual(rejected.reads, 0)
                self.assertEqual(rejected.status, 429)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        self.assert_free()

    async def test_upload_deadline_is_absolute_for_text_stream_image_and_cover(self):
        paths = ("/api/compute/validate_project", "/api/compute/generate_chapter/stream",
                 "/api/compute/images/validate_connection", "/api/compute/images/cover/generate")
        with patch.object(ingress, "MAX_READ_SECONDS", .05), patch.object(compute, "run_compute") as work, \
                patch.object(compute, "stream_compute") as stream, patch.object(image_compute, "request_image") as image:
            for path in paths:
                with self.subTest(path=path):
                    upload = IngressHarness(path, chunks=[b" "] * 100, more_body=True, delay=.01)
                    started = monotonic()
                    await asyncio.wait_for(upload.run(), 1)
                    self.assertEqual(upload.status, 408)
                    self.assertEqual(upload.error["code"], "request_timeout")
                    self.assertLess(monotonic() - started, .5)
                    self.assertGreater(upload.reads, 1)
                    self.assertLess(upload.reads, 100)
                    self.assertEqual((upload.max_readers, upload.active_readers), (1, 0))
                    self.assert_free()
            work.assert_not_called()
            stream.assert_not_called()
            image.assert_not_called()

    async def test_body_limit_checks_real_chunks_with_missing_or_false_content_length(self):
        paths = ("/api/compute/validate_project", "/api/compute/images/validate_connection", "/api/compute/images/cover/generate")
        with patch.object(ingress, "MAX_TEXT_REQUEST_BYTES", 100), patch.object(ingress, "MAX_IMAGE_REQUEST_BYTES", 100):
            for path in paths:
                for length in (None, 1):
                    with self.subTest(path=path, length=length):
                        upload = IngressHarness(path, chunks=[b" " * 70] * 3, length=length)
                        await upload.run()
                        self.assertEqual(upload.status, 413)
                        self.assertEqual(upload.error["code"], "request_too_large")
                        self.assertEqual(upload.reads, 2)
                        self.assert_free()
            with patch.object(compute, "MAX_REQUEST_BYTES", 100), patch.object(image_compute, "MAX_REQUEST_BYTES", 100):
                for path in paths:
                    upload = IngressHarness(path, length=101)
                    await upload.run()
                    self.assertEqual(upload.status, 413)
                    self.assertEqual(upload.error["code"], "request_too_large")
                    self.assertEqual(upload.reads, 0)
                    self.assert_free()

    async def test_invalid_json_validation_disconnect_and_cancel_release_once(self):
        for raw in (b"{", b"\xff", b"{}"):
            upload = IngressHarness(chunks=[raw])
            with patch.object(self.admission, "release", wraps=self.admission.release) as release:
                await upload.run()
                self.assertEqual(upload.status, 400)
                release.assert_called_once_with(ingress.MAX_TEXT_REQUEST_BYTES)
            self.assert_free()
        upload = IngressHarness("/api/compute/images/cover/generate", content_type=b"text/plain")
        await upload.run()
        self.assertEqual(upload.status, 415)
        self.assertEqual(upload.error["code"], "invalid_content_type")
        self.assertEqual(upload.reads, 0)
        self.assert_free()
        for cancel in (False, True):
            upload = IngressHarness(chunks=[], more_body=True)
            with patch.object(self.admission, "release", wraps=self.admission.release) as release:
                task = self.start(upload)
                await asyncio.wait_for(upload.waiting.wait(), 1)
                if cancel:
                    task.cancel()
                    task.cancel()
                else:
                    upload.disconnect.set()
                await asyncio.gather(task, return_exceptions=True)
                release.assert_called_once_with(ingress.MAX_TEXT_REQUEST_BYTES)
            self.assertEqual(upload.active_readers, 0)
            self.assertEqual(upload.send_attempts, [])
            self.assert_free()

    async def test_body_completion_disables_upload_deadline_and_preserves_model_disconnect(self):
        entered, closed = asyncio.Event(), asyncio.Event()
        async def model(*args):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                closed.set()
        upload = IngressHarness("/api/compute/connection_test")
        with patch.object(ingress, "MAX_READ_SECONDS", .2), patch.object(compute, "ProviderConfig"), \
                patch.object(compute, "run_compute", side_effect=model):
            task = self.start(upload)
            await asyncio.wait_for(entered.wait(), 1)
            await asyncio.sleep(.25)
            self.assertFalse(task.done())
            self.assertEqual(self.admission.requests, 1)
            upload.disconnect.set()
            await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 1)
        self.assertTrue(closed.is_set())
        self.assertEqual(upload.max_readers, 1)
        self.assert_free()

    async def test_repeated_cancel_holds_admission_until_stream_cleanup_finishes(self):
        for spec in ("2.3", "2.4"):
            entered, cleanup, allow, closed = (asyncio.Event() for _ in range(4))
            async def stream(*args):
                try:
                    yield {"type": "started"}
                    entered.set()
                    await asyncio.Event().wait()
                finally:
                    cleanup.set()
                    await allow.wait()
                    closed.set()
            upload = IngressHarness("/api/compute/generate_chapter/stream", spec=spec)
            with patch.object(compute, "ProviderConfig"), patch.object(compute, "stream_compute", side_effect=stream), \
                    patch.object(self.admission, "release", wraps=self.admission.release) as release:
                task = self.start(upload)
                try:
                    await asyncio.wait_for(entered.wait(), 1)
                    upload.disconnect.set()
                    await asyncio.wait_for(cleanup.wait(), 1)
                    task.cancel()
                    task.cancel()
                    await asyncio.sleep(0)
                    self.assertFalse(task.done())
                    self.assertFalse(closed.is_set())
                    self.assertEqual(self.admission.requests, 1)
                    release.assert_not_called()
                finally:
                    allow.set()
                await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 1)
                self.assertTrue(closed.is_set())
                release.assert_called_once_with(ingress.MAX_TEXT_REQUEST_BYTES)
            self.assert_free()

    async def test_slow_json_header_body_and_error_send_are_bounded_without_second_response(self):
        for public in (False, True):
            for spec in ("2.3", "2.4"):
                for invalid in (False, True):
                    for phase in ("http.response.start", "http.response.body"):
                        with self.subTest(public=public, spec=spec, invalid=invalid, phase=phase):
                            async def send(message):
                                self.assertEqual(self.admission.requests, 1)
                                if message["type"] == phase:
                                    await asyncio.Event().wait()
                            upload = IngressHarness(chunks=[b"{" if invalid else payload()], send_hook=send, spec=spec)
                            with patch.object(main, "PUBLIC_MODE", public), patch.object(ingress, "MAX_SEND_SECONDS", .02), \
                                    patch.object(compute, "run_compute", AsyncMock(return_value={})), \
                                    patch.object(self.admission, "release", wraps=self.admission.release) as release:
                                await asyncio.wait_for(upload.run(), 1)
                                release.assert_called_once_with(ingress.MAX_TEXT_REQUEST_BYTES)
                            self.assertEqual(sum(message["type"] == "http.response.start" for message in upload.send_attempts), 1)
                            self.assertEqual(upload.send_attempts[0]["status"], 400 if invalid else 200)
                            self.assert_free()

    async def test_send_failure_does_not_expose_transport_error_or_attempt_second_headers(self):
        for phase in ("http.response.start", "http.response.body"):
            async def send(message):
                if message["type"] == phase:
                    raise OSError("PRIVATE_TRANSPORT_SENTINEL")
            upload = IngressHarness(send_hook=send)
            with patch.object(compute, "run_compute", AsyncMock(return_value={})), \
                    patch.object(self.admission, "release", wraps=self.admission.release) as release:
                await upload.run()
                release.assert_called_once_with(ingress.MAX_TEXT_REQUEST_BYTES)
            self.assertEqual(sum(message["type"] == "http.response.start" for message in upload.send_attempts), 1)
            self.assertNotIn("PRIVATE_TRANSPORT_SENTINEL", repr(upload.send_attempts))
            self.assert_free()

    async def test_busy_response_has_one_total_send_budget_without_reading_body(self):
        for _ in range(4):
            self.assertTrue(self.admission.acquire(ingress.MAX_TEXT_REQUEST_BYTES))
        async def send(message):
            await asyncio.sleep(.16)
        rejected = IngressHarness(send_hook=send)
        started = monotonic()
        try:
            with patch.object(ingress, "MAX_REJECTION_SEND_SECONDS", .25):
                await asyncio.wait_for(rejected.run(), 1)
            self.assertEqual(rejected.reads, 0)
            self.assertEqual(len(rejected.send_attempts), 2)
            self.assertEqual(len(rejected.messages), 1)
            self.assertLess(monotonic() - started, .75)
            self.assertEqual(self.admission.requests, 4)
        finally:
            for _ in range(4):
                self.admission.release(ingress.MAX_TEXT_REQUEST_BYTES)
        self.assert_free()

    async def test_cover_idle_model_time_is_not_limited_by_read_or_single_send_deadline(self):
        async def parse(request, operation):
            async for _ in request.stream():
                pass
            return {}, {}, None, {"count": 4}
        async def body(*args):
            yield b'{"type":"started"}\n'
            await asyncio.sleep(.08)
            self.assertEqual(self.admission.requests, 1)
            yield b'{"type":"done"}\n'
        upload = IngressHarness("/api/compute/images/cover/generate")
        with patch.object(ingress, "MAX_READ_SECONDS", .02), patch.object(ingress, "MAX_SEND_SECONDS", .02), \
                patch.object(image_compute, "_parse", side_effect=parse), patch.object(image_compute, "_cover_body", side_effect=body):
            await asyncio.wait_for(upload.run(), 1)
        self.assertEqual(upload.status, 200)
        self.assertIn(b'"done"', b"".join(message.get("body", b"") for message in upload.messages))
        self.assert_free()

    async def test_receive_cleanup_retains_admission_after_timeout_and_repeated_cancel(self):
        paths = ("/api/compute/validate_project", "/api/compute/generate_chapter/stream",
                 "/api/compute/images/validate_connection", "/api/compute/images/cover/generate")
        for path in paths:
            for trigger in ("timeout", "cancel"):
                with self.subTest(path=path, trigger=trigger):
                    entered, cleanup, allow, closed = (asyncio.Event() for _ in range(4))
                    upload = IngressHarness(path, chunks=[])
                    active = 0
                    async def receive():
                        nonlocal active
                        active += 1
                        entered.set()
                        try:
                            await asyncio.Event().wait()
                        finally:
                            cleanup.set()
                            await allow.wait()
                            active -= 1
                            closed.set()
                    upload.receive = receive
                    before = asyncio.all_tasks()
                    with patch.object(ingress, "MAX_READ_SECONDS", .02 if trigger == "timeout" else 10), \
                            patch.object(self.admission, "release", wraps=self.admission.release) as release:
                        task = self.start(upload)
                        try:
                            await asyncio.wait_for(entered.wait(), 1)
                            if trigger == "cancel":
                                task.cancel()
                            await asyncio.wait_for(cleanup.wait(), 1)
                            for _ in range(3):
                                task.cancel()
                                await asyncio.sleep(0)
                            for _ in range(5):
                                await asyncio.sleep(0)
                            self.assertEqual(self.admission.requests, 1)
                            self.assertFalse(task.done())
                            self.assertEqual(active, 1)
                            self.assertFalse(closed.is_set())
                            release.assert_not_called()
                        finally:
                            allow.set()
                            await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 1)
                            # Drain independently owned parser/I/O tasks even on a failed assertion.
                            pending = asyncio.all_tasks() - before
                            if pending:
                                await asyncio.wait_for(asyncio.gather(*pending, return_exceptions=True), 1)
                        self.assertEqual(active, 0)
                        self.assertTrue(closed.is_set())
                        release.assert_called_once()
                    self.assertEqual(asyncio.all_tasks() - before, set())
                    self.assert_free()

    async def test_send_cleanup_retains_admission_after_timeout_and_repeated_cancel(self):
        for spec in ("2.3", "2.4"):
            for phase in ("http.response.start", "http.response.body"):
                with self.subTest(spec=spec, phase=phase):
                    cleanup, allow, closed = (asyncio.Event() for _ in range(3))
                    async def send(message):
                        if message["type"] == phase:
                            try:
                                await asyncio.Event().wait()
                            finally:
                                cleanup.set()
                                await allow.wait()
                                closed.set()
                    upload = IngressHarness(send_hook=send, spec=spec)
                    before = asyncio.all_tasks()
                    with patch.object(ingress, "MAX_SEND_SECONDS", .02), \
                            patch.object(compute, "run_compute", AsyncMock(return_value={})), \
                            patch.object(self.admission, "release", wraps=self.admission.release) as release:
                        task = self.start(upload)
                        try:
                            await asyncio.wait_for(cleanup.wait(), 1)
                            for _ in range(3):
                                task.cancel()
                                await asyncio.sleep(0)
                            self.assertFalse(task.done())
                            self.assertFalse(closed.is_set())
                            self.assertEqual(self.admission.requests, 1)
                            release.assert_not_called()
                        finally:
                            allow.set()
                            await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 1)
                        self.assertTrue(closed.is_set())
                        release.assert_called_once()
                    self.assertEqual(asyncio.all_tasks() - before, set())
                    self.assert_free()

    async def test_json_provider_cleanup_retains_both_slots_after_timeout_disconnect_and_cancel(self):
        for image in (False, True):
            for trigger in ("timeout", "disconnect"):
                with self.subTest(image=image, trigger=trigger):
                    entered, cleanup, allow, closed = (asyncio.Event() for _ in range(4))
                    async def model(*args):
                        entered.set()
                        try:
                            await asyncio.Event().wait()
                        finally:
                            cleanup.set()
                            await allow.wait()
                            closed.set()
                    async def parse_image(request, operation):
                        async for _ in request.stream():
                            pass
                        return {}, {"preset": "custom"}, object(), {}
                    path = "/api/compute/images/models" if image else "/api/compute/connection_test"
                    upload = IngressHarness(path)
                    before = asyncio.all_tasks()
                    connected = compute._connected
                    async def bounded_model(request, coroutine, timeout=None):
                        # Isolate the model timer from application/parse scheduling overhead.
                        return await connected(request, coroutine, .1 if trigger == "timeout" else timeout)
                    with patch.object(compute, "MAX_COMPUTE_SECONDS", 10), \
                            patch.object(compute, "_connected", side_effect=bounded_model), \
                            patch.object(compute, "ProviderConfig"), \
                            patch.object(compute, "run_compute", side_effect=model), \
                            patch.object(image_compute, "_parse", side_effect=parse_image), \
                            patch.object(image_compute, "list_models", side_effect=model), \
                            patch.object(self.admission, "release", wraps=self.admission.release) as release:
                        task = self.start(upload)
                        try:
                            await asyncio.wait_for(entered.wait(), 1)
                            if trigger == "disconnect":
                                upload.disconnect.set()
                            await asyncio.wait_for(cleanup.wait(), 1)
                            for _ in range(3):
                                task.cancel()
                                await asyncio.sleep(0)
                            self.assertFalse(task.done())
                            self.assertFalse(closed.is_set())
                            self.assertEqual(self.admission.requests, 1)
                            self.assertTrue(self.calls.acquire(False))
                            try:
                                self.assertFalse(self.calls.acquire(False))
                            finally:
                                self.calls.release()
                            release.assert_not_called()
                        finally:
                            allow.set()
                            await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 1)
                        self.assertTrue(closed.is_set())
                        release.assert_called_once()
                    self.assertEqual(upload.active_readers, 0)
                    self.assertEqual(asyncio.all_tasks() - before, set())
                    self.assert_free()

    async def test_health_capabilities_preflight_and_public_local_boundaries_bypass_full_gate(self):
        for _ in range(4):
            self.assertTrue(self.admission.acquire(ingress.MAX_TEXT_REQUEST_BYTES))
        try:
            for public in (False, True):
                with patch.object(main, "PUBLIC_MODE", public), patch.object(main.projects, "list_project_summaries", return_value=[]):
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test") as client:
                        origin = {"Origin": "https://braipen.world"}
                        for path in ("/api/health", "/api/capabilities"):
                            result = await client.get(path, headers=origin)
                            self.assertEqual(result.status_code, 200)
                            self.assertEqual(result.headers["access-control-allow-origin"], origin["Origin"])
                        result = await client.options("/api/compute/validate_project", headers={**origin, "Access-Control-Request-Method": "POST"})
                        self.assertEqual(result.status_code, 200)
                        result = await client.get("/api/projects", headers=origin)
                        self.assertEqual(result.status_code, 404 if public else 200)
                        self.assertEqual(self.admission.requests, 4)
        finally:
            for _ in range(4):
                self.admission.release(ingress.MAX_TEXT_REQUEST_BYTES)
        self.assert_free()


if __name__ == "__main__":
    unittest.main()
