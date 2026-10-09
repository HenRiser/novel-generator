from __future__ import annotations

import asyncio
import base64
import json
import struct
from threading import BoundedSemaphore
import unittest
from unittest.mock import AsyncMock, patch
import zlib

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from api.main import app
from api import main
from api.routers import compute, image_compute as route
from deepseek_client import DeepSeekClientError
import image_provider as images
from provider_catalog import CATALOG, PROTOCOLS, default_policy, normalize_connection, request_fingerprint
from provider_transport import DestinationRejected, SafeTransport


KEY = "fake-image-test-key"


def png(width=2, height=3):
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress((b"\0" + b"\x80" * width * 3) * height)) + chunk(b"IEND", b"")


PNG = png()
B64 = base64.b64encode(PNG).decode("ascii")
ORIGINAL = {"mime_type": "image/png", "data_base64": B64}


def connection(preset="seedream", **changes):
    entry = next((p for p in images.IMAGE_PROVIDERS if p["id"] == preset), None)
    return normalize_connection({"profile_id": "image-test", "revision": 1, "preset": preset,
        "protocol": entry["protocol"] if entry else "openai_images", "base_url": entry["url"] if entry else "https://image.example/v1",
        "model": entry["model"] if entry else "custom-image", "policy": default_policy("custom"), "auth_mode": "key", **changes})


def payload(operation="generate", conn=None, data=None, key=KEY):
    conn = conn or connection()
    data = data if data is not None else {"prompt": "雨城少年，小说封面", "size": "2K"}
    return {"run_id": "image-run", "step_id": "image-step", "attempt_id": "image-attempt", "input_revision": 1,
            "protocol_version": 2, "connection": conn, "credentials": {"api_key": key}, "input": data,
            "request_fingerprint": request_fingerprint(conn, operation, data)}


def response(value, status=200, headers=None):
    return httpx.Response(status, headers=headers, stream=httpx.ByteStream(value if isinstance(value, bytes) else json.dumps(value).encode()))


def factory(handler):
    return lambda url, custom=False: httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False, trust_env=False)


class ImageContracts(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_image_catalog_is_separate_and_original_text_catalog_preserved(self):
        result = self.client.get("/api/capabilities").json()
        self.assertEqual(len(CATALOG), 8)
        self.assertEqual(PROTOCOLS, ("chat_completions", "messages"))
        self.assertEqual(len(result["providers"]), 8)
        self.assertEqual({p["id"] for p in result["image_providers"]}, {"seedream", "openai", "gemini", "qwen"})
        self.assertEqual(result["image_limits"]["max_image_bytes"], 8 * 1024 * 1024)
        for p in result["image_providers"]:
            self.assertEqual(p["default_model"], p["model"])
            self.assertIn({"id": p["model"], "name": p["model"]}, p["models"])

    def test_validate_connection_normalizes_without_network_or_credentials(self):
        body = payload("validate_connection", data={}, key="")
        body["connection"]["destination_fingerprint"] = ""
        body["connection"]["execution_fingerprint"] = ""
        with patch.object(images, "_client") as network:
            result = self.client.post("/api/compute/images/validate_connection", json=body)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["result"]["connection"], connection())
        network.assert_not_called()

    def test_identity_and_both_fingerprints_are_checked_before_provider(self):
        cases = []
        body = payload(); body["run_id"] = "with spaces"; cases.append(body)
        body = payload(); body["protocol_version"] = True; cases.append(body)
        body = payload(); body["connection"]["base_url"] = "https://evil.example"; cases.append(body)
        body = payload(); body["connection"]["execution_fingerprint"] = "forged"; cases.append(body)
        body = payload(); body["request_fingerprint"] = "forged"; cases.append(body)
        body = payload(); body["credentials"]["base_url"] = "https://evil.example"; cases.append(body)
        with patch.object(images, "_client") as network:
            for body in cases:
                self.assertEqual(self.client.post("/api/compute/images/generate", json=body).status_code, 400)
        network.assert_not_called()

    def test_protocol_and_input_boundaries_reject_mixing_before_network(self):
        with patch.object(images, "_client") as network:
            for data in ({"prompt": ""}, {"prompt": "x" * 6001}, {"prompt": "image", "size": "4K"},
                         {"prompt": "image", "image": ORIGINAL}, {"prompt": "image", "base_url": "https://evil.example"}):
                self.assertEqual(self.client.post("/api/compute/images/generate", json=payload(data=data)).status_code, 400)
            for original in (None, {"mime_type": "image/svg+xml", "data_base64": B64}, {"mime_type": "image/png", "data_base64": "bad"}):
                self.assertEqual(self.client.post("/api/compute/images/edit", json=payload("edit", data={"prompt": "change", "image": original})).status_code, 400)
            result = self.client.post("/api/compute/validate_connection", json=payload("validate_connection", data={}))
            self.assertEqual(result.status_code, 400)
            self.assertEqual(result.json()["error"]["code"], "invalid_connection")
        network.assert_not_called()

    def test_presets_models_are_explicit_suggestions_and_need_no_key(self):
        with patch.object(images, "_client") as network:
            for entry in images.IMAGE_PROVIDERS:
                result = self.client.post("/api/compute/images/models", json=payload("models", connection(entry["id"]), {}, ""))
                self.assertEqual(result.status_code, 200, result.text)
                self.assertFalse(result.json()["result"]["catalog_supported"])
                self.assertTrue(result.json()["result"]["models"])
        network.assert_not_called()

    def test_request_size_and_shared_admission_are_enforced(self):
        with patch.object(route, "MAX_REQUEST_BYTES", 100), patch.object(images, "_client") as network:
            self.assertEqual(self.client.post("/api/compute/images/generate", json=payload()).status_code, 413)
            network.assert_not_called()
        slots = BoundedSemaphore(1); slots.acquire()
        try:
            with patch.object(compute, "_CALLS", slots), patch.object(images, "_client") as network:
                result = self.client.post("/api/compute/images/generate", json=payload())
                self.assertEqual(result.status_code, 429)
                network.assert_not_called()
        finally:
            slots.release()

    def test_raster_limits_and_mime_sniffing(self):
        self.assertEqual(images.image_info(PNG), ("image/png", 2, 3))
        huge = bytearray(PNG)
        huge[16:24] = struct.pack(">II", 10000, 5000)
        huge[29:33] = struct.pack(">I", zlib.crc32(huge[12:29]))
        for content, mime in ((PNG, "image/jpeg"), (PNG[:-2], None), (b"<svg></svg>", None), (bytes(huge), None)):
            with self.assertRaises(ValueError):
                images.image_info(content, mime)
        with patch.object(images, "MAX_IMAGE_BYTES", 20), self.assertRaises(ValueError):
            images._decode(B64)


class ImageAdapters(unittest.IsolatedAsyncioTestCase):
    async def test_seedream_exact_payload_and_result_download_has_no_credentials(self):
        seen = []
        url = "https://ark-content.tos-cn-beijing.volces.com/result.png?signature=secret-url"
        def upstream(req):
            seen.append(req)
            if req.method == "POST":
                return response({"data": [{"url": url}], "usage": {"output_tokens": 3, "untrusted": KEY}}, headers={"set-cookie": "upstream-session=" + KEY})
            return response(PNG, headers={"content-type": "image/png"})
        with patch.object(images, "_client", factory(upstream)):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                result = await client.post("/api/compute/images/generate", json=payload())
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(str(seen[0].url), "https://ark.cn-beijing.volces.com/api/v3/images/generations")
        self.assertEqual(json.loads(seen[0].content), {"model": "doubao-seedream-5-0-flash-260915", "prompt": "雨城少年，小说封面", "response_format": "url", "size": "2K", "stream": False, "watermark": True, "sequential_image_generation": "disabled"})
        self.assertEqual(seen[0].headers["authorization"], "Bearer " + KEY)
        self.assertEqual(seen[1].method, "GET")
        self.assertFalse(any(k in seen[1].headers for k in ("authorization", "x-goog-api-key", "cookie")))
        body = result.json()
        self.assertEqual(body["result"]["image"], {**ORIGINAL, "width": 2, "height": 3})
        self.assertEqual(body["metrics"]["call_count"], 1)
        self.assertEqual(body["attempt_id"], "image-attempt")
        self.assertNotIn(KEY, result.text); self.assertNotIn("signature", result.text)

    async def test_seedream_edit_uses_validated_original_as_data_url(self):
        seen = []
        def upstream(req):
            seen.append(req); return response({"data": [{"b64_json": B64}]})
        with patch.object(images, "_client", factory(upstream)):
            result = await images.request_image(images.ImageConfig(connection(), KEY), "edit", {"prompt": "改为雪夜", "image": ORIGINAL}, {})
        self.assertEqual(json.loads(seen[0].content)["image"], "data:image/png;base64," + B64)
        self.assertEqual(result["image"]["width"], 2)

    async def test_openai_generation_and_multipart_edit(self):
        seen = []
        def upstream(req):
            seen.append(req); return response({"data": [{"b64_json": B64}], "usage": {"input_tokens": 4, "output_tokens": 5}})
        with patch.object(images, "_client", factory(upstream)):
            config = images.ImageConfig(connection("openai"), KEY)
            await images.request_image(config, "generate", {"prompt": "封面"}, {})
            metrics = {}; result = await images.request_image(config, "edit", {"prompt": "加雪", "image": ORIGINAL}, metrics)
        self.assertEqual(seen[0].url.path, "/v1/images/generations")
        self.assertEqual(json.loads(seen[0].content)["size"], "1024x1536")
        self.assertEqual(seen[1].url.path, "/v1/images/edits")
        self.assertTrue(seen[1].headers["content-type"].startswith("multipart/form-data; boundary="))
        self.assertIn(b'name="image"; filename="original.png"', seen[1].content)
        self.assertIn(PNG, seen[1].content)
        self.assertEqual(metrics["prompt_tokens"], 4); self.assertEqual(result["usage"]["output_tokens"], 5)

    async def test_gemini_json_edit_omits_thought_images_and_uses_header_key(self):
        seen = []
        def upstream(req):
            seen.append(req)
            return response({"candidates": [{"finishReason": "STOP", "content": {"parts": [{"thought": True, "inlineData": {"data": "bad"}}, {"inlineData": {"mimeType": "image/png", "data": B64}}]}}], "usageMetadata": {"promptTokenCount": 4}})
        with patch.object(images, "_client", factory(upstream)):
            result = await images.request_image(images.ImageConfig(connection("gemini"), KEY), "edit", {"prompt": "加雪", "image": ORIGINAL}, {})
        req = seen[0]; body = json.loads(req.content)
        self.assertEqual(req.url.path, "/v1beta/models/gemini-3.1-flash-image:generateContent")
        self.assertNotIn("key=", str(req.url)); self.assertNotIn("authorization", req.headers)
        self.assertEqual(req.headers["x-goog-api-key"], KEY)
        self.assertEqual(body["contents"][0]["parts"][0]["inlineData"], {"mimeType": "image/png", "data": B64})
        self.assertEqual(body["generationConfig"]["responseFormat"]["image"], {"aspectRatio": "2:3", "imageSize": "2K"})
        self.assertEqual(result["image"]["data_base64"], B64)

    async def test_gemini_auth_key_is_opaque_and_only_sent_in_header(self):
        key = "AQ.fake.auth-key-for-mock-only"
        seen = []
        def upstream(req):
            seen.append(req)
            return response({"candidates": [{"finishReason": "STOP", "content": {"parts": [{"inlineData": {"mimeType": "image/png", "data": B64}}]}}]})
        with patch.object(images, "_client", factory(upstream)):
            result = await images.request_image(images.ImageConfig(connection("gemini"), key), "generate", {"prompt": "封面"}, {})
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0].headers["x-goog-api-key"], key)
        self.assertNotIn("authorization", seen[0].headers)
        self.assertNotIn(key, str(seen[0].url)); self.assertNotIn(key.encode(), seen[0].content)
        self.assertNotIn(key, json.dumps(result))

    async def test_gemini_structured_errors_are_fixed_sanitized_and_never_retried(self):
        cases = ((401, "UNAUTHENTICATED", "image_auth_error", 401),
                 (403, "PERMISSION_DENIED", "image_permission_denied", 403),
                 (429, "RESOURCE_EXHAUSTED", "image_quota_or_rate_limited", 429),
                 (400, "INVALID_ARGUMENT", "image_invalid_request", 400),
                 (400, "FAILED_PRECONDITION", "image_invalid_request", 400),
                 (404, "NOT_FOUND", "image_invalid_request", 400),
                 (503, "UNAVAILABLE", "image_unavailable", 503),
                 (500, "INTERNAL", "image_unavailable", 503),
                 (504, "DEADLINE_EXCEEDED", "image_outcome_unknown", 502),
                 (200, "RESOURCE_EXHAUSTED", "image_quota_or_rate_limited", 429),
                 (403, None, "image_permission_denied", 403),
                 (200, "unknown " + KEY, "image_outcome_unknown", 502))
        for upstream_http, upstream_status, code, expected_http in cases:
            with self.subTest(status=upstream_http, upstream_status=upstream_status):
                seen = []
                def upstream(req):
                    seen.append(req)
                    return response({"error": {"status": upstream_status, "message": "SAFETY quota freeTierNotAvailable " + KEY,
                        "details": [{"reason": KEY, "url": "https://signed.example/?secret"}]}}, upstream_http,
                        {"set-cookie": KEY, "x-provider-secret": KEY})
                with patch.object(images, "_client", factory(upstream)):
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                        result = await client.post("/api/compute/images/generate", json=payload(conn=connection("gemini")))
                self.assertEqual(result.status_code, expected_http, result.text)
                self.assertEqual(result.json()["error"]["code"], code)
                self.assertEqual(len(seen), 1)
                self.assertNotIn(KEY, result.text); self.assertNotIn("signed.example", result.text)
                self.assertNotIn("freeTierNotAvailable", result.text)
                self.assertNotIn("set-cookie", result.headers); self.assertNotIn("x-provider-secret", result.headers)

    async def test_gemini_content_rejection_and_unknown_output_stay_distinct(self):
        blocked = [{"promptFeedback": {"blockReason": reason, "blockReasonMessage": KEY}}
                   for reason in ("SAFETY", "OTHER", "BLOCKLIST", "PROHIBITED_CONTENT", "IMAGE_SAFETY")]
        blocked += [{"candidates": [{"finishReason": reason, "finishMessage": KEY, "content": {"parts": [{"inlineData": {"mimeType": "image/png", "data": B64}}]}}]}
                    for reason in ("SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION", "ESCALATION", "PUP_LIMITED_DISABLED")]
        unknown = [{}, {"promptFeedback": {"blockReason": "unknown " + KEY}},
                   {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "SAFETY " + KEY}]}}]}]
        unknown += [{"candidates": [{"finishReason": reason}]} for reason in ("MAX_TOKENS", "IMAGE_OTHER", "NO_IMAGE", "unknown " + KEY)]
        for raw, code in [(raw, "image_content_rejected") for raw in blocked] + [(raw, "image_outcome_unknown") for raw in unknown]:
            seen = []
            def upstream(req):
                seen.append(req); return response(raw)
            with patch.object(images, "_client", factory(upstream)), self.assertRaises(images.ImageProviderError) as caught:
                await images.request_image(images.ImageConfig(connection("gemini"), KEY), "generate", {"prompt": "封面"}, {})
            self.assertEqual(caught.exception.code, code)
            self.assertNotIn(KEY, str(caught.exception)); self.assertEqual(len(seen), 1)

    async def test_gemini_malformed_bounded_response_and_network_failure_are_unknown(self):
        failures = (response(b"not-json"), response({"error": {"status": "RESOURCE_EXHAUSTED", "message": KEY}}, 429, {"content-length": "100000"}),
                    response({"error": {"status": "RESOURCE_EXHAUSTED"}}, 429, {"content-encoding": "gzip"}),
                    response(b"x" * (64 * 1024 + 1), 429), response({"candidates": [{"content": {"parts": [{"inlineData": {"data": "bad"}}]}}]}))
        for failure in failures:
            seen = []
            def upstream(req):
                seen.append(req); return failure
            with patch.object(images, "_client", factory(upstream)), self.assertRaises(images.ImageProviderError) as caught:
                await images.request_image(images.ImageConfig(connection("gemini"), KEY), "generate", {"prompt": "封面"}, {})
            self.assertEqual(caught.exception.code, "image_outcome_unknown"); self.assertEqual(len(seen), 1)
        seen = []
        def disconnected(req):
            seen.append(req); raise httpx.ReadError(KEY)
        with patch.object(images, "_client", factory(disconnected)), self.assertRaises(images.ImageProviderError) as caught:
            await images.request_image(images.ImageConfig(connection("gemini"), KEY), "generate", {"prompt": "封面"}, {})
        self.assertEqual(caught.exception.code, "image_outcome_unknown"); self.assertNotIn(KEY, str(caught.exception))
        self.assertEqual(len(seen), 1)

    async def test_gemini_transport_timeout_keeps_unknown_outcome_without_retry(self):
        seen = []
        def upstream(req):
            seen.append(req); raise httpx.ReadTimeout(KEY)
        with patch.object(images, "_client", factory(upstream)):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                result = await client.post("/api/compute/images/generate", json=payload(conn=connection("gemini")))
        self.assertEqual(result.status_code, 504, result.text)
        self.assertEqual(result.json()["error"]["code"], "compute_timeout")
        self.assertIn("结果未知", result.json()["error"]["message"])
        self.assertNotIn(KEY, result.text); self.assertEqual(len(seen), 1)

    async def test_qwen_synchronous_generate_and_edit_use_same_model(self):
        seen = []
        def upstream(req):
            seen.append(req)
            if req.method == "GET":
                return response(PNG, headers={"content-type": "image/png"})
            return response({"output": {"choices": [{"finish_reason": "stop", "message": {"content": [{"image": "https://dashscope-result.oss-cn-beijing.aliyuncs.com/image.png?Expires=999"}]}}]}})
        with patch.object(images, "_client", factory(upstream)):
            config = images.ImageConfig(connection("qwen"), KEY)
            await images.request_image(config, "generate", {"prompt": "封面"}, {})
            await images.request_image(config, "edit", {"prompt": "改雪", "image": ORIGINAL}, {})
        bodies = [json.loads(req.content) for req in seen if req.method == "POST"]
        self.assertTrue(all(b["model"] == "qwen-image-3.0-pro" for b in bodies))
        self.assertTrue(all(req.url.path.endswith("/services/aigc/multimodal-generation/generation") for req in seen if req.method == "POST"))
        self.assertEqual(bodies[1]["input"]["messages"][0]["content"][0]["image"], "data:image/png;base64," + B64)
        self.assertEqual(bodies[0]["parameters"], {"size": "1536*2048", "n": 1})

    async def test_download_domain_boundaries_and_https_only(self):
        config = images.ImageConfig(connection(), KEY)
        for url in ("http://example.com/image", "https://127.0.0.1/image", "https://volces.com.attacker.example/image", "https://attacker-volces.com/image", "https://u:p@x.volces.com/image", "https://x.volces.com:444/image", "https://x.volces.com/image#fragment"):
            with self.subTest(url=url), patch.object(images, "_client") as network:
                with self.assertRaises(DestinationRejected):
                    await images._download(config, url)
                network.assert_not_called()
        custom = images.ImageConfig(connection("custom"), KEY)
        self.assertEqual(images._download_url(custom, "https://image.example/a?signature=opaque"), "https://image.example/a?signature=opaque")
        with self.assertRaises(DestinationRejected):
            images._download_url(custom, "https://cdn.image.example/a")

    async def test_download_redirect_compression_and_size_fail_without_retry(self):
        config = images.ImageConfig(connection(), KEY)
        for bad in (response(b"", 302, {"location": "https://other.volces.com/a"}), response(b"compressed", headers={"content-encoding": "gzip"}), response(b"x" * 60), response(PNG, headers={"content-length": "1000"})):
            seen = []
            def upstream(req):
                seen.append(req); return bad
            with patch.object(images, "_client", factory(upstream)), patch.object(images, "MAX_IMAGE_BYTES", 50):
                with self.assertRaises(DeepSeekClientError):
                    await images._download(config, "https://x.volces.com/image?signature=secret")
            self.assertEqual(len(seen), 1)

    async def test_provider_status_response_limit_and_body_errors_do_not_echo_secrets(self):
        for bad in (response({"error": {"message": KEY + " https://signed.example/?secret"}}, 401), response({"data": [{"b64_json": "invalid"}]}), response(b"x" * 200)):
            with patch.object(images, "_client", factory(lambda _: bad)), patch.object(images, "MAX_JSON_BYTES", 100):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                    result = await client.post("/api/compute/images/generate", json=payload())
            self.assertEqual(result.status_code, 502, result.text)
            self.assertNotIn(KEY, result.text); self.assertNotIn("signed.example", result.text)

    async def test_safe_binary_transport_is_reused_with_environment_proxy_disabled(self):
        with patch("provider_transport.configured_self_addresses", return_value=set()):
            async with images._client("https://images.example") as client:
                self.assertIsInstance(client._transport, SafeTransport)
                self.assertFalse(client._trust_env)
                self.assertFalse(client.follow_redirects)
                self.assertEqual(client._transport.backend.host, "images.example")

    async def test_custom_model_catalog_filters_ids_and_has_safe_fallback(self):
        for raw, status, supported, ids in (({"data": [{"id": "gpt-image-custom"}, {"id": KEY}, {"id": "bad id"}, {"id": "gpt-image-custom"}]}, 200, True, ["gpt-image-custom"]),
                                             ({"error": {"message": KEY}}, 404, False, [])):
            seen = []
            def upstream(req):
                seen.append(req); return response(raw, status)
            with patch.object(images, "_client", factory(upstream)):
                result = await images.list_models(images.ImageConfig(connection("custom"), KEY))
            self.assertEqual(result["catalog_supported"], supported)
            self.assertEqual([model["id"] for model in result["models"]], ids)
            self.assertEqual(seen[0].method, "GET"); self.assertEqual(seen[0].url.path, "/v1/models")
        with patch.object(images, "_client", factory(lambda _: response(b"invalid"))), self.assertRaises(DeepSeekClientError):
            await images.list_models(images.ImageConfig(connection("custom"), KEY))

    async def test_custom_model_catalog_truncates_only_after_valid_json_and_id_filtering(self):
        raw = {"data": [{"id": f"image-{number:04d}"} for number in reversed(range(6000))] + [{"id": "bad id"}, {"id": KEY}]}
        with patch.object(images, "_client", factory(lambda _: response(raw))):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                result = await client.post("/api/compute/images/models", json=payload("models", connection("custom"), {}))
        self.assertEqual(result.status_code, 200, result.text)
        catalog = result.json()["result"]
        self.assertTrue(catalog["truncated"]); self.assertTrue(catalog["catalog_supported"])
        self.assertEqual(len(catalog["models"]), 1000)
        self.assertEqual(catalog["models"][0]["id"], "image-0000")
        self.assertEqual(catalog["models"][-1]["id"], "image-0999")
        # A large but incomplete response must never become a successful truncated directory.
        with patch.object(images, "_client", factory(lambda _: response(json.dumps(raw).encode()[:-1]))), self.assertRaises(DeepSeekClientError):
            await images.list_models(images.ImageConfig(connection("custom"), KEY))

    async def test_arbitrary_adapter_exception_is_sanitized_at_http_boundary(self):
        with patch.object(route, "request_image", side_effect=DeepSeekClientError(KEY + " https://signed.example/?signature=secret")):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                result = await client.post("/api/compute/images/generate", json=payload())
        self.assertEqual(result.status_code, 502)
        self.assertNotIn(KEY, result.text); self.assertNotIn("signed.example", result.text)

    async def test_chunked_request_is_stopped_at_limit(self):
        chunks = [b"x" * 70, b"x" * 70, b"x" * 70]; reads = 0
        async def receive():
            nonlocal reads
            reads += 1
            return {"type": "http.request", "body": chunks[reads - 1], "more_body": reads < 3}
        request = Request({"type": "http", "headers": [(b"content-type", b"application/json")]}, receive)
        with patch.object(route, "MAX_REQUEST_BYTES", 100), self.assertRaises(Exception) as caught:
            await route._parse(request, "generate")
        self.assertEqual(caught.exception.status, 413); self.assertEqual(reads, 2)

    async def test_disconnect_cancels_upstream_and_releases_shared_slot(self):
        began, closed = asyncio.Event(), asyncio.Event()
        async def upstream(*args):
            began.set()
            try:
                await asyncio.Event().wait()
            finally:
                closed.set()
        raw = json.dumps(payload()).encode(); reads = 0
        async def receive():
            nonlocal reads
            reads += 1
            if reads == 1:
                return {"type": "http.request", "body": raw, "more_body": False}
            await began.wait()
            return {"type": "http.disconnect"}
        request = Request({"type": "http", "headers": [(b"content-type", b"application/json")]}, receive)
        slots = BoundedSemaphore(1)
        with patch.object(compute, "_CALLS", slots), patch.object(route, "request_image", side_effect=upstream):
            with self.assertRaises(asyncio.CancelledError):
                await route.image_endpoint("generate", request)
        self.assertTrue(closed.is_set()); self.assertTrue(slots.acquire(False)); slots.release()

    async def test_timeout_closes_and_releases_without_automatic_retry(self):
        ended = asyncio.Event(); count = 0
        async def upstream(*args):
            nonlocal count
            count += 1
            try:
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(.05)  # Finish provider cancellation after the overall deadline.
                ended.set()
        slots = BoundedSemaphore(1)
        with patch.object(compute, "_CALLS", slots), patch.object(compute, "MAX_COMPUTE_SECONDS", .02), patch.object(route, "request_image", side_effect=upstream):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                result = await client.post("/api/compute/images/generate", json=payload())
        self.assertEqual(result.status_code, 504, result.text)
        self.assertEqual(count, 1); self.assertTrue(ended.is_set()); self.assertTrue(slots.acquire(False)); slots.release()


class ImageSendHarness:
    """Exercise the actual router or production public/CORS ASGI stack."""

    def __init__(self, application, send_hook, spec_version="2.4"):
        self.application, self.send_hook, self.spec_version = application, send_hook, spec_version
        self.raw = json.dumps(payload()).encode()
        self.read = False
        self.disconnect = asyncio.Event()
        self.messages = []

    async def receive(self):
        if not self.read:
            self.read = True
            return {"type": "http.request", "body": self.raw, "more_body": False}
        await self.disconnect.wait()
        return {"type": "http.disconnect"}

    async def send(self, message):
        await self.send_hook(message)
        self.messages.append(message)

    async def run(self):
        path = "/api/compute/images/generate"
        scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": self.spec_version},
                 "http_version": "1.1", "method": "POST", "scheme": "http", "path": path,
                 "raw_path": path.encode(), "query_string": b"", "root_path": "", "server": ("test", 80), "client": ("test", 123),
                 "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(self.raw)).encode()),
                             (b"origin", b"https://braipen.world")]}
        await self.application(scope, self.receive, self.send)


class ImageResponseLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.slots = BoundedSemaphore(1)
        self.admission = patch.object(compute, "_CALLS", self.slots)
        self.admission.start(); self.addCleanup(self.admission.stop)
        self.tasks = []
        self.router_app = FastAPI(); self.router_app.include_router(route.router)
        self.result = {"image": {**ORIGINAL, "width": 2, "height": 3}, "model": "test-image"}

    async def asyncTearDown(self):
        for task in self.tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)

    def assert_free(self):
        self.assertTrue(self.slots.acquire(False)); self.assertFalse(self.slots.acquire(False)); self.slots.release()

    async def test_real_header_and_large_body_send_share_deadline_and_hold_admission_through_cleanup(self):
        for application in (self.router_app, main.app):
            for version in ("2.3", "2.4"):
                for phase in ("http.response.start", "http.response.body"):
                    with self.subTest(public=application is main.app, asgi=version, phase=phase):
                        blocked, cleanup_began, cleanup_allow, cleaned = (asyncio.Event() for _ in range(4))
                        async def send(message):
                            if message["type"] == phase:
                                if phase == "http.response.body":
                                    self.assertGreater(len(message["body"]), 10 * 1024 * 1024)
                                blocked.set()
                                try:
                                    await asyncio.Event().wait()
                                finally:
                                    cleanup_began.set()
                                    await cleanup_allow.wait()
                                    cleaned.set()
                        large = {**self.result, "image": {**self.result["image"], "data_base64": "A" * (11 * 1024 * 1024)}}
                        harness = ImageSendHarness(application, send, version)
                        with patch.object(main, "PUBLIC_MODE", False), patch.object(compute, "MAX_COMPUTE_SECONDS", .2), \
                                patch.object(route, "request_image", AsyncMock(return_value=large if phase == "http.response.body" else self.result)), \
                                patch.object(self.slots, "release", wraps=self.slots.release) as released:
                            task = asyncio.create_task(harness.run()); self.tasks.append(task)
                            try:
                                await asyncio.wait_for(blocked.wait(), 2)
                                self.assertFalse(self.slots.acquire(False)); released.assert_not_called()
                                await asyncio.wait_for(cleanup_began.wait(), 2)
                                self.assertFalse(task.done()); self.assertFalse(cleaned.is_set())
                                self.assertFalse(self.slots.acquire(False)); released.assert_not_called()
                                task.cancel(); task.cancel()
                                await asyncio.sleep(0)
                                self.assertFalse(task.done()); released.assert_not_called()
                            finally:
                                cleanup_allow.set()
                            await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 2)
                            self.assertTrue(cleaned.is_set()); released.assert_called_once_with()
                        self.assertEqual([m["type"] for m in harness.messages], [] if phase == "http.response.start" else ["http.response.start"])
                        self.assert_free()

    async def test_client_disconnect_cancels_real_send_and_keeps_slot_until_cleanup_finishes(self):
        for application in (self.router_app, main.app):
            for version in ("2.3", "2.4"):
                with self.subTest(public=application is main.app, asgi=version):
                    blocked, cleanup_began, cleanup_allow = (asyncio.Event() for _ in range(3))
                    async def send(message):
                        if message["type"] == "http.response.body":
                            blocked.set()
                            try:
                                await asyncio.Event().wait()
                            finally:
                                cleanup_began.set()
                                await cleanup_allow.wait()
                    harness = ImageSendHarness(application, send, version)
                    with patch.object(main, "PUBLIC_MODE", False), patch.object(route, "request_image", AsyncMock(return_value=self.result)), \
                            patch.object(self.slots, "release", wraps=self.slots.release) as released:
                        task = asyncio.create_task(harness.run()); self.tasks.append(task)
                        try:
                            await asyncio.wait_for(blocked.wait(), 2)
                            harness.disconnect.set()
                            await asyncio.wait_for(cleanup_began.wait(), 2)
                            self.assertFalse(task.done()); self.assertFalse(self.slots.acquire(False)); released.assert_not_called()
                        finally:
                            cleanup_allow.set()
                        await asyncio.wait_for(task, 2)
                        released.assert_called_once_with()
                    self.assert_free()

    async def test_computation_time_is_deducted_from_real_send_deadline(self):
        for application in (self.router_app, main.app):
            entered, cancelled = asyncio.Event(), asyncio.Event()
            async def generate(*args):
                await asyncio.sleep(.25)
                return self.result
            async def send(message):
                if message["type"] == "http.response.start":
                    entered.set()
                    try:
                        await asyncio.Event().wait()
                    finally:
                        cancelled.set()
            harness = ImageSendHarness(application, send)
            from time import monotonic
            started = monotonic()
            with patch.object(main, "PUBLIC_MODE", False), patch.object(compute, "MAX_COMPUTE_SECONDS", .4), patch.object(route, "request_image", side_effect=generate):
                task = asyncio.create_task(harness.run()); self.tasks.append(task)
                await asyncio.wait_for(task, 2)
            self.assertTrue(entered.is_set()); self.assertTrue(cancelled.is_set())
            self.assertLess(monotonic() - started, .6)
            self.assert_free()

    async def test_successful_real_send_releases_once_after_body_and_preserves_cors(self):
        for application in (self.router_app, main.app):
            async def send(message):
                self.assertFalse(self.slots.acquire(False))
            harness = ImageSendHarness(application, send)
            with patch.object(main, "PUBLIC_MODE", False), patch.object(route, "request_image", AsyncMock(return_value=self.result)), \
                    patch.object(self.slots, "release", wraps=self.slots.release) as released:
                task = asyncio.create_task(harness.run()); self.tasks.append(task)
                await asyncio.wait_for(task, 2)
                released.assert_called_once_with()
            self.assertEqual([m["type"] for m in harness.messages], ["http.response.start", "http.response.body"])
            self.assertEqual(json.loads(harness.messages[1]["body"])["result"], self.result)
            if application is main.app:
                self.assertIn((b"access-control-allow-origin", b"https://braipen.world"), harness.messages[0]["headers"])
            self.assert_free()

    async def test_overall_timeout_cleanup_returns_504_with_bounded_error_send_grace(self):
        for application in (self.router_app, main.app):
            for version in ("2.3", "2.4"):
                with self.subTest(public=application is main.app, asgi=version):
                    provider_cleaned = asyncio.Event()
                    async def generate(*args):
                        try:
                            await asyncio.Event().wait()
                        finally:
                            await asyncio.sleep(.05)
                            provider_cleaned.set()
                    async def send(message):
                        self.assertTrue(provider_cleaned.is_set())
                        self.assertFalse(self.slots.acquire(False))
                    harness = ImageSendHarness(application, send, version)
                    with patch.object(main, "PUBLIC_MODE", False), patch.object(compute, "MAX_COMPUTE_SECONDS", .02), \
                            patch.object(route, "request_image", side_effect=generate), \
                            patch.object(self.slots, "release", wraps=self.slots.release) as released:
                        task = asyncio.create_task(harness.run()); self.tasks.append(task)
                        await asyncio.wait_for(task, 2)
                        released.assert_called_once_with()
                    self.assertEqual(harness.messages[0]["status"], 504)
                    self.assertEqual(json.loads(harness.messages[1]["body"])["error"]["code"], "compute_timeout")
                    self.assert_free()

    async def test_slow_timeout_error_send_obeys_its_grace_and_retains_slot_during_send_cleanup(self):
        for application in (self.router_app, main.app):
            for phase in ("http.response.start", "http.response.body"):
                with self.subTest(public=application is main.app, phase=phase):
                    blocked, cleanup_began, cleanup_allow = (asyncio.Event() for _ in range(3))
                    async def generate(*args):
                        await asyncio.Event().wait()
                    async def send(message):
                        if message["type"] == phase:
                            blocked.set()
                            try:
                                await asyncio.Event().wait()
                            finally:
                                cleanup_began.set()
                                await cleanup_allow.wait()
                    harness = ImageSendHarness(application, send)
                    with patch.object(main, "PUBLIC_MODE", False), patch.object(compute, "MAX_COMPUTE_SECONDS", .02), \
                            patch.object(route, "MAX_ERROR_SEND_SECONDS", .08), patch.object(route, "request_image", side_effect=generate), \
                            patch.object(self.slots, "release", wraps=self.slots.release) as released:
                        task = asyncio.create_task(harness.run()); self.tasks.append(task)
                        try:
                            await asyncio.wait_for(blocked.wait(), 2)
                            await asyncio.wait_for(cleanup_began.wait(), 2)
                            self.assertFalse(task.done()); self.assertFalse(self.slots.acquire(False)); released.assert_not_called()
                        finally:
                            cleanup_allow.set()
                        await asyncio.wait_for(task, 2)
                        released.assert_called_once_with()
                    self.assertEqual([m["type"] for m in harness.messages], [] if phase == "http.response.start" else ["http.response.start"])
                    self.assert_free()


if __name__ == "__main__":
    unittest.main()
