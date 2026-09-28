from __future__ import annotations

import json
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from api.main import app


class ComputeApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)
        self.identity = {
            "run_id": "run-1",
            "step_id": "step-1",
            "attempt_id": "attempt-1",
            "input_revision": 3,
        }

    def payload(self, **extra):
        body = {
            **self.identity,
            "credentials": {"api_key": "", "model": "deepseek-v4-flash"},
            "input": {"project_ref": "book:test"},
        }
        body.update(extra)
        return body

    def test_capabilities_advertise_stateless_boundary(self):
        response = self.client.get("/api/capabilities")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["protocol_version"], 2)
        self.assertIn("generate_chapter", payload["stream_operations"])
        self.assertFalse(payload["persistence"]["projects"])
        self.assertEqual(payload["limits"]["max_request_bytes"], 1024 * 1024)

    def test_invalid_identity_is_rejected_without_running_compute(self):
        body = self.payload(run_id="run with spaces")
        with patch("api.routers.compute.run_compute", new_callable=AsyncMock) as mocked:
            response = self.client.post("/api/compute/validate_project", json=body)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "invalid_identity")
        mocked.assert_not_awaited()

    def test_model_operation_rejects_missing_request_key(self):
        with patch("api.routers.compute.run_compute", new_callable=AsyncMock) as mocked:
            response = self.client.post("/api/compute/generate_outline", json=self.payload())
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "invalid_credentials")
        mocked.assert_not_awaited()

    def test_compute_response_keeps_identity_and_does_not_persist_credentials(self):
        async def fake_compute(operation, data, credentials, metrics):
            self.assertEqual(operation, "validate_project")
            self.assertEqual(credentials["api_key"], "sk-abcdefghijklmnop")
            self.assertNotIn("api_key", metrics)
            return {"ready": True}

        with patch("api.routers.compute.run_compute", side_effect=fake_compute):
            response = self.client.post(
                "/api/compute/validate_project",
                json=self.payload(credentials={"api_key": "sk-abcdefghijklmnop", "model": "deepseek-v4-flash"}),
            )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["run_id"], "run-1")
        self.assertEqual(payload["input_revision"], 3)
        self.assertEqual(payload["result"], {"ready": True})
        self.assertNotIn("credentials", payload)
        self.assertNotIn("sk-abcdefghijklmnop", json.dumps(payload))

    def test_stream_wraps_done_event_with_identity_and_metrics(self):
        async def fake_stream(operation, data, credentials, metrics):
            yield {"type": "delta", "text": "正文"}
            yield {"type": "done", "result": {"content": "正文"}}

        with patch("api.routers.compute.stream_compute", side_effect=fake_stream):
            response = self.client.post(
                "/api/compute/generate_chapter/stream",
                json=self.payload(credentials={"api_key": "sk-abcdefghijklmnop", "model": "deepseek-v4-flash"}),
            )
        self.assertEqual(response.status_code, 200)
        events = [json.loads(line) for line in response.text.splitlines()]
        self.assertEqual(events[0]["type"], "delta")
        self.assertEqual(events[0]["run_id"], "run-1")
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(events[-1]["result"]["content"], "正文")
        self.assertIn("metrics", events[-1])

    def test_request_limit_is_enforced_before_compute(self):
        oversized = self.payload(input={"text": "x" * (1024 * 1024)})
        with patch("api.routers.compute.run_compute", new_callable=AsyncMock) as mocked:
            response = self.client.post("/api/compute/validate_project", json=oversized)
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["error"]["code"], "request_too_large")
        mocked.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()

