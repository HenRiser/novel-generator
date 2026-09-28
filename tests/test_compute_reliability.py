from __future__ import annotations

import asyncio
import io
import json
import logging
import threading
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from api.routers import compute as route
from services import compute_service as service
import deepseek_client as provider
from tests.test_chapter_task_api import task_payload
from tests.test_scene_plan_api import scene_payload

KEY = "sk-" + "a" * 32
CONFIG = {key: "已设定" for key in ("title", "protagonist", "supporting_characters", "worldview", "core_conflict", "genre", "style", "word_count_range")}


def payload(data=None, key=KEY, **identity):
    return {"run_id": "run", "step_id": "step", "attempt_id": "attempt", "input_revision": 1,
            "credentials": {"api_key": key, "model": "test-model"}, "input": data or {}, **identity}


def body_input():
    return {"project_ref": "book:bk_test", "chapter_number": 1, "config": CONFIG.copy(),
            "assets": {"outline": "故事大纲", "characters": "人物资料"}, "request": {}, "summaries": [],
            "graph": {"version": 1, "tag_registry": {}, "graph": {"nodes": [], "edges": []}}}


def app():
    value = FastAPI()
    value.include_router(route.router)
    return value


class ComputeBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.calls = threading.BoundedSemaphore(2)
        self.patch = patch.object(route, "_CALLS", self.calls)
        self.patch.start(); self.addCleanup(self.patch.stop)
        self.client = TestClient(app(), raise_server_exceptions=False)
        self.addCleanup(self.client.close)

    def assert_slots_free(self):
        self.assertTrue(self.calls.acquire(False)); self.assertTrue(self.calls.acquire(False))
        self.assertFalse(self.calls.acquire(False)); self.calls.release(); self.calls.release()

    def test_json_and_stream_admission_fail_before_response_headers(self):
        self.calls.acquire(); self.calls.acquire()
        try:
            for suffix in ("", "/stream"):
                r = self.client.post("/api/compute/generate_chapter" + suffix, json=payload(body_input()))
                self.assertEqual(r.status_code, 429)
                self.assertEqual(r.json()["error"]["code"], "compute_busy")
        finally:
            self.calls.release(); self.calls.release()

    def test_stream_close_failure_still_releases_slot(self):
        class Broken:
            async def __anext__(self):
                raise RuntimeError("private provider error")
            async def aclose(self):
                raise RuntimeError("close failed")
        with patch.object(route, "stream_compute", return_value=Broken()):
            self.client.post("/api/compute/generate_chapter/stream", json=payload(body_input()))
        self.assert_slots_free()

    def test_stream_validates_then_starts_then_returns_same_identity(self):
        async def output(*args, **kwargs):
            yield {"kind": "content", "text": "第一章\n正文内容"}
        with patch.object(service, "request_text_stream", side_effect=output):
            r = self.client.post("/api/compute/generate_chapter/stream", json=payload(body_input()))
        events = [json.loads(line) for line in r.text.splitlines()]
        self.assertEqual([e["type"] for e in events], ["started", "delta", "done"])
        self.assertIn("frozen_context", events[0]); self.assertEqual(events[0]["frozen_context"], events[-1]["result"]["frozen_context"])
        self.assertTrue(all(e["attempt_id"] == "attempt" for e in events))
        self.assert_slots_free()

    def test_invalid_input_never_emits_started_or_calls_provider(self):
        with patch.object(service, "request_text_stream") as mocked:
            r = self.client.post("/api/compute/generate_chapter/stream", json=payload({"chapter_number": 1}))
        self.assertEqual(json.loads(r.text)["type"], "error"); mocked.assert_not_called(); self.assert_slots_free()

    def test_no_arbitrary_url_nested_credentials_or_unknown_operation(self):
        for data in ({"base_url": "http://private.invalid"}, {"config": {"api_key": KEY}}, {"constructor": {}}):
            self.assertEqual(self.client.post("/api/compute/validate_project", json=payload(data)).status_code, 400)
        bad = payload(); bad["credentials"]["base_url"] = "http://private.invalid"
        self.assertEqual(self.client.post("/api/compute/connection_test", json=bad).status_code, 400)
        self.assertEqual(self.client.post("/api/compute/read_file", json=payload()).status_code, 404)

    def test_task_scene_graph_and_review_use_in_memory_documents(self):
        def post(op, data):
            r = self.client.post('/api/compute/' + op, json=payload(data))
            self.assertEqual(r.status_code, 200, r.text)
            return r.json()['result']
        base = body_input()
        task = post('chapter_task', {**base, 'request': task_payload()})
        task = post('chapter_task', {**base, 'document': task, 'action': 'approve', 'request': {'task_id': task['task']['id'], 'revision': task['task']['revision']}})
        scene = post('scene_plan', {**base, 'chapter_task': task['approved'], 'request': scene_payload(source_chapter_task_id=task['approved']['id'], source_chapter_task_revision=task['approved']['revision'])})
        self.assertEqual(scene['plan']['status'], 'draft')
        graph = post('graph_change', {**base, 'action': 'create_node', 'request': {'type': 'character', 'label': '甲', 'summary': '演员', 'importance': 5, 'layer': 'detail'}})
        node = graph['node']['id']
        updated = post('graph_change', {**base, 'graph': graph['graph'], 'action': 'update_node', 'node_id': node, 'request': {'summary': '修改后的演员'}})
        self.assertEqual(updated['node']['summary'], '修改后的演员')


class AsyncComputeTests(unittest.IsolatedAsyncioTestCase):
    async def test_chunked_body_is_stopped_at_limit(self):
        chunks = [b'x' * 70, b'x' * 70, b'x' * 70]
        count = 0
        async def receive():
            nonlocal count
            count += 1
            return {'type': 'http.request', 'body': chunks[count - 1], 'more_body': count < 3}
        request = Request({'type': 'http', 'headers': [(b'content-type', b'application/json')]}, receive)
        with patch.object(route, 'MAX_REQUEST_BYTES', 100):
            with self.assertRaises(service.ComputeError) as caught:
                await route._parse(request, 'validate_project')
        self.assertEqual(caught.exception.status, 413); self.assertEqual(count, 2)

    async def test_json_disconnect_cancels_upstream_and_frees_capacity(self):
        began, finished = asyncio.Event(), asyncio.Event()
        async def fake(*args):
            began.set()
            try: await asyncio.Event().wait()
            finally: finished.set()
        raw = json.dumps(payload()).encode(); reads = 0
        async def receive():
            nonlocal reads
            reads += 1
            if reads == 1: return {'type': 'http.request', 'body': raw, 'more_body': False}
            await began.wait(); return {'type': 'http.disconnect'}
        request = Request({'type': 'http', 'headers': [(b'content-type', b'application/json')]}, receive)
        calls = threading.BoundedSemaphore(2)
        with patch.object(route, '_CALLS', calls), patch.object(route, 'run_compute', side_effect=fake):
            with self.assertRaises(asyncio.CancelledError):
                await route.compute_endpoint('connection_test', request)
        self.assertTrue(finished.is_set()); self.assertTrue(calls.acquire(False)); self.assertTrue(calls.acquire(False))

    async def test_concurrent_credentials_and_inputs_are_request_local(self):
        entered = 0; ready = asyncio.Event(); received = []
        async def fake(config, messages, **kwargs):
            nonlocal entered
            received.append((config.api_key, messages[-1]['content'])); entered += 1
            if entered == 2: ready.set()
            await ready.wait(); return config.api_key[-1] + '摘要'
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app()), base_url='http://test') as client:
            with patch.object(service, 'request_text', side_effect=fake):
                responses = await asyncio.gather(*[client.post('/api/compute/summarize_chapter', json=payload({'chapter_number': 1, 'chapter': {'content': marker}, 'review_scope': 'rules_only'}, key='sk-' + letter * 32)) for letter, marker in [('a', '文本甲'), ('b', '文本乙')]])
        self.assertTrue(all(r.status_code == 200 for r in responses)); self.assertEqual({r[0][-1] for r in received}, {'a', 'b'})
        self.assertIn('文本甲', received[0][1]); self.assertNotIn('文本乙', received[0][1])

    async def test_modified_chapter_uses_json_review_and_frozen_generation_constraints(self):
        data = {'chapter_number': 1, 'chapter': {'content': '他已经死去。他走进房间。'}, 'review_scope': 'semantic_and_rules',
                'frozen_context': {'narrative_context_text': '甲在此前已死', 'chapter_task': {'ending_state': '不能复活'}}}
        mocked = AsyncMock(return_value=json.dumps({'summary': '疑似冲突', 'warnings': [{'code': 'conflict', 'message': '疑似矛盾', 'evidence': '他走进房间。', 'constraint': '甲在此前已死', 'suggestion': '核对身份'}]}))
        with patch.object(service, 'request_text', mocked):
            result = await service.compute('summarize_chapter', data, {'api_key': KEY}, {})
        self.assertTrue(mocked.call_args.kwargs['json_mode'])
        prompt = json.loads(mocked.call_args.args[1][-1]['content'])
        self.assertEqual(prompt['frozen_constraints'], data['frozen_context']); self.assertTrue(result['warnings'])

    async def test_setting_assets_and_story_delta_use_existing_domain_rules_without_files(self):
        from tests.test_story_delta_json_mode import valid_payload
        expansion = {"recommended_title": "建议标题", "title_candidates": ["建议标题"], "protagonist_setting": "扩写主角", "supporting_characters_setting": "扩写配角", "world_setting": "扩写世界", "core_conflict": "扩写冲突"}
        mocks = AsyncMock(side_effect=[json.dumps(expansion), "新大纲", "新人物卡", json.dumps(valid_payload())])
        data = {**body_input(), "chapter": {"content": "The door closed.", "revision": "revision1"}, "request": {"raw_story_idea": "一个少年在雨城寻人"}}
        with patch.object(service, 'request_text', mocks), patch('services.story_delta_service.read_latest_outline', side_effect=AssertionError('filesystem read')), patch('services.story_delta_service.read_latest_characters', side_effect=AssertionError('filesystem read')):
            result = await service.compute('expand_setting', data, {'api_key': KEY}, {})
            self.assertEqual(result['expanded_data']['protagonist_setting'], '扩写主角')
            self.assertEqual((await service.compute('generate_outline', data, {'api_key': KEY}, {}))['content'], '新大纲')
            self.assertEqual((await service.compute('generate_characters', data, {'api_key': KEY}, {}))['content'], '新人物卡')
            result = await service.compute('story_delta', data, {'api_key': KEY}, {})
        self.assertTrue(result['knowledge_draft']['candidate_changes'])
        self.assertIn('next_chapter_proposal', result)
        self.assertTrue(mocks.call_args_list[0].kwargs['json_mode'])
        self.assertTrue(mocks.call_args_list[-1].kwargs['json_mode'])
        draft = result['knowledge_draft']
        reviewed = await service.compute('review_change', {**body_input(), 'draft': draft, 'change_id': draft['candidate_changes'][0]['id'], 'action': 'accept'}, {}, {})
        self.assertEqual(reviewed['change']['status'], 'accepted')
        self.assertTrue(reviewed['graph']['graph']['nodes'])
        with self.assertRaises(service.ComputeError):
            await service.compute('review_change', {**body_input(), 'draft': reviewed['draft'], 'change_id': draft['candidate_changes'][0]['id'], 'action': 'accept'}, {}, {})

    async def test_story_delta_repair_once_and_repeat_analysis_has_distinct_review_ids(self):
        from tests.test_story_delta_json_mode import valid_payload
        data = {**body_input(), 'chapter': {'content': 'The door closed.'}}
        valid = json.dumps(valid_payload())
        with patch.object(service, 'request_text', AsyncMock(side_effect=['invalid JSON', valid, valid])) as model:
            metrics = {}
            first = await service.compute('story_delta', data, {'api_key': KEY}, metrics)
            second = await service.compute('story_delta', data, {'api_key': KEY}, {})
        self.assertTrue(metrics['repair_used']); self.assertEqual(model.await_count, 3)
        self.assertNotEqual(first['knowledge_draft']['id'], second['knowledge_draft']['id'])

    async def test_total_timeout_and_stream_timeout_cleanup(self):
        closed = asyncio.Event()
        async def fake(*args):
            try: await asyncio.Event().wait()
            finally: closed.set()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app()), base_url='http://test') as client:
            with patch.object(route, 'run_compute', side_effect=fake), patch.object(route, 'MAX_COMPUTE_SECONDS', .02):
                r = await client.post('/api/compute/connection_test', json=payload())
        self.assertEqual(r.status_code, 504); self.assertTrue(closed.is_set())

    async def test_sdk_fixed_endpoint_json_usage_and_no_debug_prompt(self):
        logger = logging.getLogger('openai._base_client'); sink = io.StringIO(); handler = logging.StreamHandler(sink)
        logger.disabled = False; logger.setLevel(logging.DEBUG); logger.addHandler(handler)
        seen = []
        async def transport(request):
            seen.append(request)
            return httpx.Response(200, json={'id': 'mock', 'object': 'chat.completion', 'created': 1, 'model': 'test-model',
                'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': '{"ok":true}'}, 'finish_reason': 'stop'}],
                'usage': {'prompt_tokens': 10, 'completion_tokens': 5}})
        constructor = provider.AsyncOpenAI
        def client(**kwargs):
            return constructor(**kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(transport)))
        metrics = {}
        try:
            with patch.object(provider, 'AsyncOpenAI', side_effect=client), patch.object(provider, '_get_api_key', side_effect=AssertionError('environment read')):
                for _ in range(2):
                    await provider.request_text(provider.ProviderConfig(KEY, 'test-model'), [{'role': 'user', 'content': 'JSON PRIVATE_PROMPT_MARKER'}], json_mode=True, usage_metrics=metrics)
            self.assertEqual(metrics['call_count'], 2); self.assertEqual(metrics['prompt_tokens'], 20)
            self.assertTrue(all(r.url.host == 'api.deepseek.com' for r in seen))
            self.assertEqual(json.loads(seen[0].content)['response_format'], {'type': 'json_object'})
            self.assertNotIn('PRIVATE_PROMPT_MARKER', sink.getvalue()); self.assertNotIn(KEY, sink.getvalue())
        finally: logger.removeHandler(handler)

    async def test_sdk_total_call_timeout_cancels_transport(self):
        closed = asyncio.Event()
        async def transport(request):
            try: await asyncio.Event().wait()
            finally: closed.set()
        constructor = provider.AsyncOpenAI
        def client(**kwargs): return constructor(**kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(transport)))
        with patch.object(provider, 'AsyncOpenAI', side_effect=client), patch.object(provider, 'MODEL_TIMEOUT_SECONDS', .5):
            with self.assertRaises(asyncio.TimeoutError):
                await provider.request_text(provider.ProviderConfig(KEY), [{'role': 'user', 'content': 'fake'}])
        self.assertTrue(closed.is_set())


if __name__ == '__main__': unittest.main()
