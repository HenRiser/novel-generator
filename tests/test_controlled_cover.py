from __future__ import annotations

import asyncio
import base64
import json
import os
from pathlib import Path
import subprocess
from threading import BoundedSemaphore
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI

from api import main
from api.routers import compute, image_compute as route
import cover_generation as covers
from deepseek_client import DeepSeekClientError
from image_provider import ImageProviderError
import provider_catalog
from provider_catalog import default_policy, normalize_connection, request_fingerprint
from tests.test_image_compute import connection, ORIGINAL, payload as legacy_payload
from tests.test_image_metadata import metadata_png, SECRET

TEXT_KEY = "fake-cover-text-key"
IMAGE_KEY = "fake-cover-image-key"
PRIVATE = "PRIVATE_GENERATED_SCENE_SENTINEL"


def text_connection(**changes):
    return normalize_connection({"profile_id": "cover-text", "revision": 1, "preset": "deepseek", "protocol": "chat_completions",
        "base_url": "https://api.deepseek.com", "model": "deepseek-chat", "policy": default_policy("deepseek", "deepseek-chat"), "auth_mode": "key", **changes})


def plan(count, **changes):
    return {"suitable": True, "variants": [{key: PRIVATE + str(index) for key in ("subject", "setting", "composition", "lighting", "palette")} for index in range(count)], **changes}


def payload(count=1, operation="generate", **changes):
    image = connection()
    data = {"source": {"idea": "", "characters": "- **姓名**：阿晏\n- **外貌特征**：黑色短发，灰色眼睛\n- **服饰**：黑色风衣"},
            "style_id": "cinematic", "count": count, "size": "2K", "text_connection": text_connection()}
    if operation == "edit":
        data.update(image=ORIGINAL, edit_kind="restyle")
    data.update(changes)
    return {"run_id": "cover-run", "step_id": "cover-step", "attempt_id": "cover-attempt", "input_revision": 1,
        "protocol_version": 2, "connection": image, "credentials": {"api_key": IMAGE_KEY, "text_api_key": TEXT_KEY},
        "input": data, "request_fingerprint": request_fingerprint(image, "cover_" + operation, data)}


RESULT = {"image": {**ORIGINAL, "width": 2, "height": 3}, "model": "untrusted-provider-model", "revised_prompt": PRIVATE, "reasoning": PRIVATE}


class ControlledCoverTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.slots = BoundedSemaphore(1)
        self.admission = patch.object(compute, "_CALLS", self.slots)
        self.admission.start(); self.addCleanup(self.admission.stop)
        self.public = patch.object(main, "PUBLIC_MODE", True)
        self.public.start(); self.addCleanup(self.public.stop)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    def assert_free(self):
        self.assertTrue(self.slots.acquire(False)); self.assertFalse(self.slots.acquire(False)); self.slots.release()

    async def post(self, body, operation="generate"):
        return await self.client.post("/api/compute/images/cover/" + operation, json=body)

    def events(self, response):
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("application/x-ndjson", response.headers["content-type"])
        self.assertEqual(response.headers["cache-control"], "no-store, no-transform")
        return [json.loads(line) for line in response.text.splitlines()]

    async def test_one_text_call_then_four_sequential_single_image_calls_and_no_private_output(self):
        order, active, peak = [], 0, 0
        body = payload(4)
        async def text(config, messages, **options):
            nonlocal active, peak
            active += 1; peak = max(peak, active); order.append("text")
            self.assertEqual(config.api_key, TEXT_KEY)
            self.assertEqual(options["max_tokens"], 6000); self.assertTrue(options["json_mode"])
            self.assertEqual(messages[0]["role"], "system")
            sent = json.loads(messages[1]["content"])
            self.assertEqual(sent["characters"], covers._appearance_source(body["input"]["source"]["characters"]))
            self.assertEqual(set(sent), {"characters", "count", "edit_kind"})
            await asyncio.sleep(0); active -= 1
            return json.dumps(plan(4))
        async def image(config, operation, data, metrics):
            nonlocal active, peak
            active += 1; peak = max(peak, active); order.append("image")
            self.assertEqual(config.api_key, IMAGE_KEY); self.assertEqual(operation, "generate")
            self.assertEqual(set(data), {"prompt", "size"}); self.assertIn(PRIVATE, data["prompt"])
            await asyncio.sleep(0); active -= 1
            return RESULT
        with patch.object(covers.model_client, "request_text", side_effect=text) as t, patch.object(covers, "request_image", side_effect=image) as i:
            response = await self.post(body)
        events = self.events(response)
        self.assertEqual(order, ["text"] + ["image"] * 4); self.assertEqual(peak, 1)
        self.assertEqual(t.call_count, 1); self.assertEqual(i.call_count, 4)
        self.assertEqual([e["type"] for e in events], ["started", "text_started", "text_done"] + [kind for _ in range(4) for kind in ("image_started", "image")] + ["done"])
        self.assertEqual([e["index"] for e in events if e["type"] == "image"], [0, 1, 2, 3])
        for seq, event in enumerate(events, 1):
            self.assertEqual(event["seq"], seq); self.assertEqual(event["event_version"], 1)
            for key in ("run_id", "step_id", "attempt_id", "input_revision", "protocol_version", "request_fingerprint"):
                self.assertEqual(event[key], body[key])
            self.assertEqual(event["text_execution_fingerprint"], body["input"]["text_connection"]["execution_fingerprint"])
        self.assertEqual(events[-1]["completed"], 4); self.assertEqual(events[-1]["requested"], 4)
        for word in (PRIVATE, IMAGE_KEY, TEXT_KEY, "revised_prompt", "reasoning", covers.SYSTEM, covers.STYLES["cinematic"][1]):
            self.assertNotIn(word, response.text)
        self.assert_free()

    async def test_actual_model_client_closed_schema_and_provider_text_do_not_escape(self):
        seen = []
        def upstream(request):
            seen.append(request)
            return httpx.Response(200, stream=httpx.ByteStream(json.dumps({"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(plan(1)), "reasoning_content": PRIVATE}}]}).encode()))
        text = normalize_connection({"profile_id": "json-text", "revision": 1, "preset": "openai", "protocol": "chat_completions", "base_url": "https://api.openai.com/v1",
                                    "model": "gpt-4o", "policy": default_policy("openai", "gpt-4o"), "auth_mode": "key"})
        def factory(config):
            return httpx.AsyncClient(transport=httpx.MockTransport(upstream), follow_redirects=False, trust_env=False)
        with patch.object(covers.model_client, "_client", side_effect=factory), patch.object(covers, "request_image", AsyncMock(return_value=RESULT)):
            response = await self.post(payload(text_connection=text))
        self.assertEqual(self.events(response)[-1]["type"], "done"); self.assertEqual(len(seen), 1)
        body = json.loads(seen[0].content)
        self.assertFalse(body["stream"]); self.assertEqual(body["max_completion_tokens"], 6000)
        self.assertEqual(body["response_format"]["json_schema"]["schema"], covers.PLAN_SCHEMA)
        self.assertTrue(body["response_format"]["json_schema"]["strict"])
        self.assertNotIn(PRIVATE, response.text); self.assert_free()

    async def test_all_five_styles_and_counts_and_edit_operations_work(self):
        for style in covers.STYLES:
            for count in covers.COUNTS:
                for operation in ("generate", "edit"):
                    with self.subTest(style=style, count=count, operation=operation), \
                         patch.object(covers.model_client, "request_text", AsyncMock(return_value=json.dumps(plan(count)))), \
                         patch.object(covers, "request_image", AsyncMock(return_value=RESULT)) as upstream:
                        events = self.events(await self.post(payload(count, operation, style_id=style), operation))
                    self.assertEqual(events[-1]["type"], "done")
                    self.assertEqual(upstream.call_count, count)
                    self.assertEqual(upstream.call_args.args[1], operation)
                    self.assertEqual(events[-2]["result"]["style_id"], style)
        for edit in covers.EDIT_KINDS:
            with patch.object(covers.model_client, "request_text", AsyncMock(return_value=json.dumps(plan(1)))), \
                 patch.object(covers, "request_image", AsyncMock(return_value=RESULT)) as image:
                self.assertEqual(self.events(await self.post(payload(operation="edit", edit_kind=edit), "edit"))[-1]["type"], "done")
                self.assertNotEqual(image.call_args.args[2]["prompt"], "")

    async def test_text_failure_unsuitable_schema_count_length_and_json_never_call_images_or_retry(self):
        long_plan = plan(1); long_plan["variants"][0]["subject"] = "x" * 501
        extra_plan = plan(1); extra_plan["reasoning"] = PRIVATE
        duplicate = json.dumps(plan(1)).replace('"suitable": true', '"suitable": false, "suitable": true')
        cases = [DeepSeekClientError(PRIVATE + TEXT_KEY), json.dumps(plan(1, suitable=False, variants=[])), duplicate,
                 json.dumps(plan(2)), json.dumps(long_plan), json.dumps(extra_plan), "{broken", "```json\n" + json.dumps(plan(1)) + "\n```"]
        for result in cases:
            with self.subTest(result_type=type(result)), patch.object(covers.model_client, "request_text", AsyncMock(side_effect=result if isinstance(result, Exception) else None, return_value=result)) as text, \
                 patch.object(covers, "request_image", AsyncMock()) as image:
                response = await self.post(payload())
                events = self.events(response)
                self.assertEqual(events[-1]["type"], "error"); self.assertEqual(events[-1]["completed"], 0)
                self.assertNotIn(PRIVATE, response.text); self.assertNotIn(TEXT_KEY, response.text)
                text.assert_awaited_once(); image.assert_not_called()
            self.assert_free()

    async def test_only_explicit_visible_fields_reach_text_and_image_models(self):
        biography = "BIOGRAPHY_MUST_NOT_LEAVE_CARD"
        cards = "\n".join(("# 人物设定表", "- **姓名：**阿晏", "- **身份**：" + biography,
            "- **外貌特征**：黑色短发，经历（摘要）：" + biography, "  灰色眼睛", "  - **经历**",
            "    " + biography, "- 外貌：黑色短发", "  - **过去经历（摘要）**：" + biography,
            "    " + biography, "- 服饰：黑色风衣；经历：" + biography, "- 可见饰物：银色耳环",
            "## 经历", "  " + biography, "姓名：小舟", "外观：栗色头发。经历：" + biography, "隐藏秘密：" + biography))
        body = payload(source={"idea": "", "characters": cards})
        text = AsyncMock(return_value=json.dumps(plan(2)))
        image = AsyncMock(return_value=RESULT)
        body["input"]["count"] = 2
        body["request_fingerprint"] = request_fingerprint(body["connection"], "cover_generate", body["input"])
        with patch.object(covers.model_client, "request_text", text), patch.object(covers, "request_image", image):
            events = self.events(await self.post(body))
        self.assertEqual(events[-1]["type"], "done"); text.assert_awaited_once(); self.assertEqual(image.call_count, 2)
        messages = text.call_args.args[1]
        self.assertNotIn(biography, json.dumps(messages, ensure_ascii=False))
        user = json.loads(messages[1]["content"])
        self.assertEqual(set(user), {"characters", "count", "edit_kind"})
        for visible in ("阿晏", "黑色短发", "灰色眼睛", "黑色风衣", "银色耳环", "小舟", "栗色头发"):
            self.assertIn(visible, user["characters"])
            for call in image.call_args_list:
                self.assertIn(visible, call.args[2]["prompt"])
                self.assertNotIn(biography, call.args[2]["prompt"])
                self.assertIn(covers.STYLES["cinematic"][1], call.args[2]["prompt"])
        self.assertNotIn(user["characters"], response_text := "\n".join(json.dumps(event, ensure_ascii=False) for event in events))
        self.assertNotIn(PRIVATE, response_text); self.assert_free()

    async def test_missing_appearance_rejects_unlabeled_cards_before_any_model_call(self):
        cards = ("", " ", "姓名：阿晏\n身份：侦探\n经历：穿越了城市", "黑色短发，灰色眼睛，黑色风衣",
                 "姓名：阿晏\n  别名一\n  别名二", "外貌特征：\n经历：穿黑色风衣", "# 外貌特征\n黑色短发")
        with patch.object(covers.model_client, "request_text") as text, patch.object(covers, "request_image") as image:
            for characters in cards:
                response = await self.post(payload(source={"idea": "", "characters": characters}))
                self.assertEqual(response.status_code, 400 if not characters.strip() else 422, response.text)
                if characters.strip():
                    self.assertEqual(response.json()["error"]["code"], "cover_missing_appearance")
            text.assert_not_called(); image.assert_not_called()
        self.assert_free()

    async def test_appearance_limit_and_later_invalid_variant_stop_before_first_image(self):
        with patch.object(covers.model_client, "request_text") as text, patch.object(covers, "request_image") as image:
            response = await self.post(payload(source={"idea": "", "characters": "外貌特征：" + "x" * 2400}))
            self.assertEqual(response.status_code, 400); text.assert_not_called(); image.assert_not_called()
        invalid = plan(2); invalid["variants"][1]["subject"] = ""
        with patch.object(covers.model_client, "request_text", AsyncMock(return_value=json.dumps(invalid))) as text, patch.object(covers, "request_image") as image:
            events = self.events(await self.post(payload(2)))
        self.assertEqual(events[-1]["code"], "invalid_cover_plan"); text.assert_awaited_once(); image.assert_not_called()
        self.assert_free()

    async def test_explicit_prompt_only_accepts_one_fenced_json_without_repair(self):
        policy = {**default_policy("custom"), "structured": "prompt_only"}
        text = text_connection(preset="custom", base_url="https://text.example/v1", policy=policy)
        with patch.object(covers.model_client, "request_text", AsyncMock(return_value="```json\n" + json.dumps(plan(1)) + "\n```")), patch.object(covers, "request_image", AsyncMock(return_value=RESULT)):
            self.assertEqual(self.events(await self.post(payload(text_connection=text)))[-1]["type"], "done")

    async def test_partial_success_survives_later_failure_without_retry(self):
        with patch.object(covers.model_client, "request_text", AsyncMock(return_value=json.dumps(plan(4)))), \
             patch.object(covers, "request_image", AsyncMock(side_effect=[RESULT, RESULT, DeepSeekClientError(PRIVATE + IMAGE_KEY)])) as image:
            response = await self.post(payload(4))
        events = self.events(response)
        self.assertEqual(len([event for event in events if event["type"] == "image"]), 2)
        self.assertEqual(events[-1]["type"], "error"); self.assertEqual(events[-1]["completed"], 2)
        self.assertEqual(events[-1]["requested"], 4); self.assertEqual(image.call_count, 3)
        self.assertNotIn(PRIVATE, response.text); self.assertNotIn(IMAGE_KEY, response.text); self.assert_free()

    async def test_classified_image_failure_preserves_cover_event_identity_and_partial_results(self):
        for code, status in (("image_content_rejected", 422), ("image_quota_or_rate_limited", 429), ("image_outcome_unknown", 502)):
            body = payload(2)
            image = AsyncMock(side_effect=[RESULT, ImageProviderError(code)])
            with patch.object(covers.model_client, "request_text", AsyncMock(return_value=json.dumps(plan(2)))), patch.object(covers, "request_image", image):
                response = await self.post(body)
            events = self.events(response)
            self.assertEqual([event["type"] for event in events], ["started", "text_started", "text_done", "image_started", "image", "image_started", "error"])
            self.assertEqual(image.call_count, 2)
            self.assertEqual(events[-1]["code"], code); self.assertEqual(events[-1]["status"], status)
            self.assertEqual(events[-1]["completed"], 1); self.assertEqual(events[-1]["requested"], 2)
            for seq, event in enumerate(events, 1):
                self.assertEqual(event["seq"], seq)
                self.assertEqual(event["request_fingerprint"], body["request_fingerprint"])
                self.assertEqual(event["execution_fingerprint"], body["connection"]["execution_fingerprint"])
                self.assertEqual(event["text_execution_fingerprint"], body["input"]["text_connection"]["execution_fingerprint"])
            self.assertNotIn(PRIVATE, response.text); self.assertNotIn(IMAGE_KEY, response.text); self.assertNotIn(TEXT_KEY, response.text)
            self.assert_free()

    async def test_request_boundary_rejects_raw_prompt_and_tampering_before_either_key_is_sent(self):
        cases = []
        for field, value in (("prompt", PRIVATE), ("style_id", "custom"), ("count", True), ("count", 3), ("size", "4K")):
            body = payload(); body["input"][field] = value; cases.append(body)
        for field, value in (("idea", "雨城的侦探与古老神话"), ("characters", "x" * 12001), ("prompt", PRIVATE)):
            body = payload(); body["input"]["source"][field] = value; cases.append(body)
        for field in ("execution_fingerprint", "base_url"):
            body = payload(); body["input"]["text_connection"][field] = "forged"; cases.append(body)
        body = payload(); body["request_fingerprint"] = "forged"; cases.append(body)
        body = payload(); body["credentials"]["other"] = IMAGE_KEY; cases.append(body)
        body = payload(); body["input"]["text_connection"] = connection(); cases.append(body)
        body = payload(); body["input"]["text_connection"] = text_connection(model="unknown-text"); cases.append(body)
        with patch.object(covers.model_client, "request_text") as text, patch.object(covers, "request_image") as image:
            for body in cases:
                response = await self.post(body)
                self.assertEqual(response.status_code, 400, response.text)
                self.assertNotIn(PRIVATE, response.text); self.assertNotIn(IMAGE_KEY, response.text)
            for operation in ("generate", "edit"):
                self.assertEqual((await self.client.post("/api/compute/images/" + operation, json=legacy_payload())).status_code, 400)
        text.assert_not_called(); image.assert_not_called(); self.assert_free()

    async def test_busy_uses_the_existing_shared_slot_and_never_calls_text(self):
        self.assertTrue(self.slots.acquire(False))
        try:
            with patch.object(covers.model_client, "request_text") as text:
                response = await self.post(payload(4))
            self.assertEqual(response.status_code, 429); text.assert_not_called()
        finally:
            self.slots.release()

    async def test_returned_image_metadata_is_removed_even_if_an_adapter_returns_it(self):
        result = {**RESULT, "image": {"mime_type": "image/png", "data_base64": base64.b64encode(metadata_png()).decode()}}
        with patch.object(covers.model_client, "request_text", AsyncMock(return_value=json.dumps(plan(1)))), patch.object(covers, "request_image", AsyncMock(return_value=result)):
            events = self.events(await self.post(payload()))
        final = base64.b64decode(events[-2]["result"]["image"]["data_base64"])
        self.assertNotIn(SECRET, final); self.assertEqual(events[-1]["type"], "done")

    async def test_failed_oversized_event_does_not_consume_a_stream_sequence_number(self):
        variant = {**RESULT, "image": {**RESULT["image"], "data_base64": "A" * 6000}}
        with patch.object(route, "MAX_COVER_LINE_BYTES", 2000), patch.object(covers, "public_result", return_value={"image": variant["image"], "model": "image"}), \
             patch.object(covers.model_client, "request_text", AsyncMock(return_value=json.dumps(plan(1)))), patch.object(covers, "request_image", AsyncMock(return_value=RESULT)):
            events = self.events(await self.post(payload()))
        self.assertEqual(events[-1]["type"], "error"); self.assertEqual(events[-1]["completed"], 0)
        self.assertEqual([event["seq"] for event in events], list(range(1, len(events) + 1)))

    async def test_each_image_has_its_own_stage_deadline_and_partial_results_are_preserved(self):
        calls = 0; closed = asyncio.Event()
        async def image(*args):
            nonlocal calls
            calls += 1
            if calls < 3:
                await asyncio.sleep(.035)
                return RESULT
            try:
                await asyncio.Event().wait()
            finally:
                closed.set()
        with patch.object(covers, "MAX_STAGE_SECONDS", .06), patch.object(covers.model_client, "request_text", AsyncMock(return_value=json.dumps(plan(4)))), patch.object(covers, "request_image", side_effect=image):
            events = self.events(await self.post(payload(4)))
        self.assertEqual(events[-1]["code"], "compute_timeout"); self.assertEqual(events[-1]["completed"], 2)
        self.assertEqual(calls, 3); self.assertTrue(closed.is_set()); self.assert_free()

    async def test_fingerprint_binds_source_style_count_text_execution_edit_and_image(self):
        body = payload(4)
        for field, value in (("count", 2), ("style_id", "ink"), ("source", {"idea": "new", "characters": "adult"}), ("text_connection", text_connection(model="deepseek-reasoner"))):
            data = {**body["input"], field: value}
            self.assertNotEqual(request_fingerprint(body["connection"], "cover_generate", data), body["request_fingerprint"])
        body = payload(operation="edit")
        for field, value in (("edit_kind", "lighting"), ("image", {"mime_type": "image/png", "data_base64": base64.b64encode(metadata_png()).decode()})):
            self.assertNotEqual(request_fingerprint(body["connection"], "cover_edit", {**body["input"], field: value}), body["request_fingerprint"])

    async def test_template_one_fingerprint_is_rejected_before_either_model_call(self):
        original_digest = provider_catalog.digest
        def old_template(value):
            if value.startswith("{") and '"cover_protocol"' in value:
                envelope = json.loads(value)
                envelope.update(cover_protocol=1, template_version=1)
                value = json.dumps(envelope, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            return original_digest(value)
        body = payload()
        with patch.object(provider_catalog, "digest", side_effect=old_template):
            body["request_fingerprint"] = request_fingerprint(body["connection"], "cover_generate", body["input"])
        with patch.object(covers.model_client, "request_text") as text, patch.object(covers, "request_image") as image:
            response = await self.post(body)
        self.assertEqual(response.status_code, 400, response.text)
        text.assert_not_called(); image.assert_not_called(); self.assert_free()

    async def test_capabilities_expose_only_style_directory_and_budgets(self):
        result = (await self.client.get("/api/capabilities")).json()["cover_generation"]
        self.assertEqual(result["counts"], [1, 2, 4]); self.assertEqual(covers.budget_seconds(4), 630)
        self.assertEqual({style["id"] for style in result["styles"]}, set(covers.STYLES))
        self.assertTrue(all(set(style) == {"id", "label"} for style in result["styles"]))
        self.assertNotIn(covers.SYSTEM, json.dumps(result))
        self.assertEqual(result["template_version"], 2)


class CoverHarness:
    def __init__(self, app, hook, version="2.4"):
        self.app, self.hook, self.version = app, hook, version
        self.raw = json.dumps(payload()).encode(); self.read = False
        self.disconnect = asyncio.Event(); self.messages = []

    async def receive(self):
        if not self.read:
            self.read = True
            return {"type": "http.request", "body": self.raw, "more_body": False}
        await self.disconnect.wait()
        return {"type": "http.disconnect"}

    async def send(self, message):
        await self.hook(message)
        self.messages.append(message)

    async def run(self):
        path = "/api/compute/images/cover/generate"
        scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": self.version}, "http_version": "1.1", "method": "POST", "scheme": "http", "path": path,
                 "raw_path": path.encode(), "query_string": b"", "root_path": "", "server": ("test", 80), "client": ("test", 123),
                 "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(self.raw)).encode()), (b"origin", b"https://braipen.world")]}
        await self.app(scope, self.receive, self.send)


class CoverLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.slots = BoundedSemaphore(1)
        self.admission = patch.object(compute, "_CALLS", self.slots)
        self.admission.start(); self.addCleanup(self.admission.stop)
        self.router_app = FastAPI(); self.router_app.include_router(route.router)
        self.tasks = []

    async def asyncTearDown(self):
        for task in self.tasks:
            if not task.done(): task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)

    def assert_free(self):
        self.assertTrue(self.slots.acquire(False)); self.assertFalse(self.slots.acquire(False)); self.slots.release()

    async def test_slow_real_header_or_image_send_has_one_deadline_and_keeps_slot_until_cleanup(self):
        for app in (self.router_app, main.app):
            for version in ("2.3", "2.4"):
                for phase in ("http.response.start", "image"):
                    blocked, cleanup_began, cleanup_allow, cleaned = (asyncio.Event() for _ in range(4))
                    async def send(message):
                        image = message["type"] == "http.response.body" and message["body"] and json.loads(message["body"])["type"] == "image"
                        if message["type"] == phase or (phase == "image" and image):
                            blocked.set()
                            try:
                                await asyncio.Event().wait()
                            finally:
                                cleanup_began.set(); await cleanup_allow.wait(); cleaned.set()
                    harness = CoverHarness(app, send, version)
                    with patch.object(main, "PUBLIC_MODE", True), patch.object(covers, "budget_seconds", return_value=.05), \
                         patch.object(covers.model_client, "request_text", AsyncMock(return_value=json.dumps(plan(1)))), patch.object(covers, "request_image", AsyncMock(return_value=RESULT)), \
                         patch.object(self.slots, "release", wraps=self.slots.release) as released:
                        task = asyncio.create_task(harness.run()); self.tasks.append(task)
                        try:
                            await asyncio.wait_for(blocked.wait(), 2); self.assertFalse(self.slots.acquire(False))
                            await asyncio.wait_for(cleanup_began.wait(), 2)
                            task.cancel(); task.cancel(); await asyncio.sleep(0)
                            self.assertFalse(task.done()); released.assert_not_called(); self.assertFalse(cleaned.is_set())
                        finally:
                            cleanup_allow.set()
                        await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 2)
                        self.assertTrue(cleaned.is_set()); released.assert_called_once_with()
                    self.assert_free()

    async def test_disconnect_during_text_or_image_wait_cancels_provider_before_releasing_slot(self):
        for stage in ("text", "image"):
            for version in ("2.3", "2.4"):
                started, closing, allow_close, closed = (asyncio.Event() for _ in range(4))
                async def wait(*args, **kwargs):
                    started.set()
                    try:
                        await asyncio.Event().wait()
                    finally:
                        closing.set(); await allow_close.wait(); closed.set()
                async def send(message):
                    self.assertFalse(self.slots.acquire(False))
                harness = CoverHarness(main.app, send, version)
                text = AsyncMock(side_effect=wait) if stage == "text" else AsyncMock(return_value=json.dumps(plan(1)))
                image = AsyncMock(side_effect=wait)
                with patch.object(main, "PUBLIC_MODE", True), patch.object(covers.model_client, "request_text", text), patch.object(covers, "request_image", image), \
                     patch.object(self.slots, "release", wraps=self.slots.release) as released:
                    task = asyncio.create_task(harness.run()); self.tasks.append(task)
                    try:
                        await asyncio.wait_for(started.wait(), 2); harness.disconnect.set()
                        await asyncio.wait_for(closing.wait(), 2)
                        task.cancel(); task.cancel(); await asyncio.sleep(0)
                        released.assert_not_called(); self.assertFalse(task.done()); self.assertFalse(closed.is_set())
                    finally:
                        allow_close.set()
                    await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 2)
                    self.assertTrue(closed.is_set()); released.assert_called_once_with()
                self.assert_free()

    async def test_successful_real_public_stream_keeps_cors_and_releases_exactly_once(self):
        async def send(message): self.assertFalse(self.slots.acquire(False))
        harness = CoverHarness(main.app, send)
        with patch.object(main, "PUBLIC_MODE", True), patch.object(covers.model_client, "request_text", AsyncMock(return_value=json.dumps(plan(1)))), patch.object(covers, "request_image", AsyncMock(return_value=RESULT)), patch.object(self.slots, "release", wraps=self.slots.release) as released:
            await harness.run(); released.assert_called_once_with()
        self.assertIn((b"access-control-allow-origin", b"https://braipen.world"), harness.messages[0]["headers"])
        self.assertEqual(json.loads(harness.messages[-2]["body"])["type"], "done"); self.assert_free()


class PublicDefaultTests(unittest.TestCase):
    def test_missing_mistyped_and_explicit_zero_public_configuration(self):
        for value, expected in ((None, True), ("typo", True), ("0", False)):
            env = dict(os.environ)
            if value is None: env.pop("BRAIPEN_PUBLIC_MODE", None)
            else: env["BRAIPEN_PUBLIC_MODE"] = value
            result = subprocess.run([os.sys.executable, "-c", "from api.main import PUBLIC_MODE; print(PUBLIC_MODE)"], cwd=Path(__file__).resolve().parents[1], env=env, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr); self.assertEqual(result.stdout.strip(), str(expected))


if __name__ == "__main__":
    unittest.main()
