from __future__ import annotations

import asyncio
import json
import threading
import unittest
from time import monotonic
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from api import main
from api.routers import compute as route
from services import compute_service as service
from services.chapter_workflow_service import WorkflowError
from tests.test_chapter_planning_api import payload
from tests.test_chapter_planning_contract import candidate, constraints
from tests.test_chapter_planning_stream import StreamHarness, checked, frames


class PublicStreamHarness(StreamHarness):
    """Use the production app, including its public boundary and CORS stack."""

    async def run(self):
        scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": self.spec_version},
                 "http_version": "1.1", "method": "POST", "scheme": "http",
                 "path": "/api/compute/plan_chapter/stream", "raw_path": b"/api/compute/plan_chapter/stream",
                 "query_string": b"", "root_path": "", "server": ("test", 80), "client": ("test", 123),
                 "headers": [(b"content-type", b"application/json"),
                             (b"content-length", str(len(self.raw)).encode()), (b"origin", b"https://braipen.world")]}
        await main.app(scope, self.receive, self.send)


class PublicBoundaryTests(unittest.TestCase):
    def test_public_and_local_paths_cors_and_options_keep_their_original_semantics(self):
        origin = {"Origin": "https://braipen.world"}
        pure_input = {"candidate": candidate(), "constraints": constraints()}
        pure_body = {"run_id": "public-pure", "step_id": "pure", "attempt_id": "once", "input_revision": 0,
                     "credentials": {}, "input": pure_input}
        for public in (False, True):
            with self.subTest(public=public), patch.object(main, "PUBLIC_MODE", public), \
                    patch.object(main.projects, "list_project_summaries", return_value=[]) as projects, \
                    patch.object(main.settings, "get_api_key_status", side_effect=AssertionError("Must not read local credentials")) as credentials, \
                    patch.object(service, "request_text", new_callable=AsyncMock) as model, \
                    TestClient(main.app, raise_server_exceptions=False) as client:
                self.assertIs(main.app.user_middleware[0].cls, main.PublicBoundaryMiddleware)
                for path in ("/api/health", "/api/capabilities"):
                    response = client.get(path, headers=origin)
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.headers["access-control-allow-origin"], origin["Origin"])
                    self.assertNotIn("access-control-allow-credentials", response.headers)
                response = client.get("/api/projects", headers=origin)
                if public:
                    self.assertEqual(response.status_code, 404)
                    self.assertEqual(response.json(), {"error": {"code": "public_mode", "message": "该接口在浏览器本地数据模式下不可用。"}})
                    self.assertNotIn("access-control-allow-origin", response.headers)
                    projects.assert_not_called()
                    self.assertEqual(client.get("/api/settings/api-config").json()["error"]["code"], "public_mode")
                else:
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json(), [])
                    projects.assert_called_once_with()
                    self.assertEqual(response.headers["access-control-allow-origin"], origin["Origin"])
                preflight = client.options("/api/projects", headers={**origin, "Access-Control-Request-Method": "GET"})
                self.assertEqual(preflight.status_code, 200)
                self.assertEqual(preflight.headers["access-control-allow-origin"], origin["Origin"])
                self.assertEqual(client.options("/api/projects").status_code, 405)
                self.assertEqual(client.get("/not-an-api").json()["error"]["code"], "http_error")
                self.assertEqual(client.post("/api/compute/unknown-operation", json=pure_body).json()["error"]["code"], "unknown_operation")
                response = client.post("/api/compute/validate_planning_candidate", json=pure_body, headers=origin)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["result"]["issues"], [])
                self.assertEqual(response.headers["access-control-allow-origin"], origin["Origin"])
                credentials.assert_not_called()
                model.assert_not_awaited()

    def test_local_exception_json_status_handlers_are_preserved(self):
        with patch.object(main, "PUBLIC_MODE", False), TestClient(main.app, raise_server_exceptions=False) as client:
            with patch.object(main.projects, "create_workspace_project", side_effect=AssertionError("Must not create a real project")) as created:
                response = client.post("/api/projects", json={"title": {}})
                created.assert_not_called()
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json()["error"]["code"], "invalid_request")
            for failure, status, code, message in ((WorkflowError("offline conflict", "offline_conflict"), 409, "offline_conflict", "offline conflict"),
                                                   (RuntimeError("RAW_ERROR_SENTINEL"), 500, "internal_error", "Internal server error.")):
                with self.subTest(code=code), patch.object(main.projects, "list_project_summaries", side_effect=failure):
                    response = client.get("/api/projects")
                    self.assertEqual(response.status_code, status)
                    self.assertEqual(response.json(), {"error": {"code": code, "message": message}})

    def test_full_stack_success_returns_a_valid_planning_stream_in_both_modes(self):
        slots = threading.BoundedSemaphore(2)
        body = payload()
        for public in (False, True):
            with self.subTest(public=public), patch.object(main, "PUBLIC_MODE", public), patch.object(route, "_CALLS", slots), \
                    patch.object(service, "request_text", AsyncMock(return_value=json.dumps(candidate()))) as model, \
                    TestClient(main.app, raise_server_exceptions=False) as client:
                response = client.post("/api/compute/plan_chapter/stream", json=body, headers={"Origin": "https://braipen.world"})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(checked(body, frames(response.content))["status"], "draft_ready")
                self.assertEqual(response.headers["access-control-allow-origin"], "https://braipen.world")
                model.assert_awaited_once()
                self.assertTrue(slots.acquire(False)); self.assertTrue(slots.acquire(False)); self.assertFalse(slots.acquire(False))
                slots.release(); slots.release()


class PublicPlanningStreamSendTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.slots = threading.BoundedSemaphore(2)
        admission = patch.object(route, "_CALLS", self.slots)
        admission.start()
        self.addCleanup(admission.stop)
        self.tasks = []

    async def asyncTearDown(self):
        for task in self.tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)

    def assert_free(self):
        self.assertTrue(self.slots.acquire(False)); self.assertTrue(self.slots.acquire(False)); self.assertFalse(self.slots.acquire(False))
        self.slots.release(); self.slots.release()

    async def test_real_response_start_send_obeys_deadline_without_starting_model(self):
        for public in (False, True):
            for version in ("2.3", "2.4"):
                with self.subTest(public=public, asgi=version):
                    blocked = asyncio.Event()

                    async def send(message):
                        if message["type"] == "http.response.start":
                            blocked.set()
                            await asyncio.Event().wait()

                    harness = PublicStreamHarness(payload(), send, spec_version=version)
                    began = monotonic()
                    with patch.object(main, "PUBLIC_MODE", public), patch.object(route, "MAX_COMPUTE_SECONDS", .3), \
                            patch.object(service, "request_text", new_callable=AsyncMock) as model, \
                            patch.object(self.slots, "release", wraps=self.slots.release) as released:
                        task = asyncio.create_task(harness.run()); self.tasks.append(task)
                        await asyncio.wait_for(blocked.wait(), 2)
                        await asyncio.wait_for(task, 2)
                        model.assert_not_awaited()
                        released.assert_called_once_with()
                    self.assertLess(monotonic() - began, 1.5)
                    self.assertEqual(harness.messages, [])
                    self.assert_free()

    async def test_real_body_send_deadline_keeps_admission_until_model_cleanup_finishes(self):
        for public in (False, True):
            for version in ("2.3", "2.4"):
                with self.subTest(public=public, asgi=version):
                    entered, blocked = asyncio.Event(), asyncio.Event()
                    cleanup_began, cleanup_allow, cleaned = asyncio.Event(), asyncio.Event(), asyncio.Event()

                    async def model(*args, **kwargs):
                        entered.set()
                        try:
                            await asyncio.Event().wait()
                        finally:
                            cleanup_began.set()
                            await cleanup_allow.wait()
                            cleaned.set()

                    async def send(message):
                        if message["type"] == "http.response.body" and b"initial_proposal" in message.get("body", b""):
                            await entered.wait()
                            blocked.set()
                            await asyncio.Event().wait()

                    harness = PublicStreamHarness(payload(), send, spec_version=version)
                    began = monotonic()
                    release_spare = self.slots.release
                    with patch.object(main, "PUBLIC_MODE", public), patch.object(route, "MAX_COMPUTE_SECONDS", .8), \
                            patch.object(service, "request_text", side_effect=model) as caller, \
                            patch.object(self.slots, "release", wraps=self.slots.release) as released:
                        task = asyncio.create_task(harness.run()); self.tasks.append(task)
                        try:
                            await asyncio.wait_for(blocked.wait(), 2)
                            await asyncio.wait_for(cleanup_began.wait(), 2)
                            self.assertFalse(task.done())
                            self.assertFalse(cleaned.is_set())
                            released.assert_not_called()
                            self.assertTrue(self.slots.acquire(False))
                            self.assertFalse(self.slots.acquire(False))
                            release_spare()  # Do not count the test's spare-slot return as response cleanup.
                            released.assert_not_called()
                        finally:
                            cleanup_allow.set()
                        await asyncio.wait_for(task, 2)
                        self.assertTrue(cleaned.is_set())
                        caller.assert_awaited_once()
                        released.assert_called_once_with()
                    self.assertLess(monotonic() - began, 1.5)
                    self.assertFalse(any(event["type"] == "done" for event in harness.events))
                    self.assert_free()


if __name__ == "__main__":
    unittest.main()
