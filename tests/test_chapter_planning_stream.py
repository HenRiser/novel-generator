from __future__ import annotations

import asyncio
import copy
import json
import threading
import unittest
from time import monotonic
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

import model_client as models
from api.routers import compute as route
from deepseek_client import DeepSeekClientError
from services import chapter_planning_service as planning, compute_service as service
from services.chapter_planning_events import IDENTITY_FIELDS, PlanningEventContract
from tests.test_chapter_planning_api import KEY, app, payload, wire_text
from tests.test_chapter_planning_contract import candidate, planning_input
from tests.test_chapter_planning_events import base_events
from tests.test_provider_connections import client_factory


def identity(body):
    return {**{key: body[key] for key in IDENTITY_FIELDS if key in body},
            **{key: body['connection'][key] for key in ('destination_fingerprint', 'execution_fingerprint')}}


def frames(raw):
    return [json.loads(line) for line in raw.splitlines() if line.strip()]


def checked(body, events, complete=True):
    contract = PlanningEventContract(identity(body), body['input']['chapter_number'])
    for event in events:
        contract.accept(event)
    return contract.finish() if complete else contract


class StreamHarness:
    """Real ASGI send/receive boundaries, without HTTPX's response buffering."""

    def __init__(self, body, send_hook=None, spec_version='2.3'):
        self.body = body
        self.raw = json.dumps(body).encode()
        self.messages = []
        self.changed = asyncio.Event()
        self.disconnected = asyncio.Event()
        self.send_hook = send_hook
        self.spec_version = spec_version
        self.received = False

    @property
    def events(self):
        raw = b''.join(message.get('body', b'') for message in self.messages)
        return frames(raw)

    async def receive(self):
        if not self.received:
            self.received = True
            return {'type': 'http.request', 'body': self.raw, 'more_body': False}
        await self.disconnected.wait()
        return {'type': 'http.disconnect'}

    async def send(self, message):
        if self.send_hook:
            await self.send_hook(message)
        self.messages.append(copy.deepcopy(message))
        self.changed.set()

    async def run(self):
        scope = {'type': 'http', 'asgi': {'version': '3.0', 'spec_version': self.spec_version},
                 'http_version': '1.1', 'method': 'POST', 'scheme': 'http',
                 'path': '/api/compute/plan_chapter/stream',
                 'raw_path': b'/api/compute/plan_chapter/stream', 'query_string': b'',
                 'root_path': '', 'server': ('test', 80), 'client': ('test', 123),
                 'headers': [(b'content-type', b'application/json'),
                             (b'content-length', str(len(self.raw)).encode())]}
        await app()(scope, self.receive, self.send)

    async def wait_for(self, predicate):
        async def watch():
            while True:
                self.changed.clear()
                if predicate(self.events):
                    return
                await self.changed.wait()
        await asyncio.wait_for(watch(), 2)


class PlanningStreamHttpTests(unittest.TestCase):
    def setUp(self):
        self.slots = threading.BoundedSemaphore(2)
        admission = patch.object(route, '_CALLS', self.slots)
        admission.start()
        self.addCleanup(admission.stop)
        self.client = TestClient(app(), raise_server_exceptions=False)
        self.addCleanup(self.client.close)

    def assert_free(self):
        self.assertTrue(self.slots.acquire(False))
        self.assertTrue(self.slots.acquire(False))
        self.assertFalse(self.slots.acquire(False))
        self.slots.release()
        self.slots.release()

    def test_capabilities_and_json_results_remain_compatible(self):
        advertised = self.client.get('/api/capabilities').json()
        self.assertIn('plan_chapter', advertised['stream_operations'])
        self.assertEqual(advertised['planning_stream_version'], 1)
        body = payload()
        with patch.object(service, 'request_text', AsyncMock(return_value=json.dumps(candidate()))):
            ordinary = self.client.post('/api/compute/plan_chapter', json=body)
            streamed = self.client.post('/api/compute/plan_chapter/stream', json=body)
        self.assertEqual(ordinary.status_code, 200, ordinary.text)
        self.assertEqual(streamed.status_code, 200, streamed.text)
        self.assertIn('application/x-ndjson', streamed.headers['content-type'])
        self.assertEqual(streamed.headers['cache-control'], 'no-store, no-transform')
        self.assertEqual(streamed.headers['x-accel-buffering'], 'no')
        self.assertEqual(checked(body, frames(streamed.content)), ordinary.json()['result'])
        legacy = {key: value for key, value in body.items()
                  if key not in {'protocol_version', 'connection', 'request_fingerprint'}}
        with patch.object(service, 'legacy_request_text', AsyncMock(return_value=json.dumps(candidate()))) as model:
            response = self.client.post('/api/compute/plan_chapter', json=legacy)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['result'], ordinary.json()['result'])
        model.assert_awaited_once()
        self.assert_free()

    def test_upstream_json_protocol_and_usage_are_preserved(self):
        for repaired in (False, True):
            with self.subTest(repaired=repaired):
                bad = candidate()
                bad['task_payload']['canon_budget'] = 'normal'
                outputs = iter([bad, candidate()] if repaired else [candidate()])
                requests = []

                def upstream(request):
                    requests.append(json.loads(request.content))
                    return wire_text(json.dumps(next(outputs)), 'chat_completions')

                body = payload()
                with patch.object(models, '_client', client_factory(upstream)), \
                        patch.object(service, 'request_text_stream', new_callable=AsyncMock) as token_stream:
                    response = self.client.post('/api/compute/plan_chapter/stream', json=body)
                self.assertEqual(response.status_code, 200, response.text)
                events = frames(response.content)
                result = checked(body, events)
                self.assertEqual(result['repair_count'], int(repaired))
                self.assertEqual(sum(event['type'] == 'progress' for event in events), 10 if repaired else 6)
                self.assertEqual(len(requests), 2 if repaired else 1)
                self.assertTrue(all(not request['stream'] and request['max_tokens'] == 4000 for request in requests))
                self.assertEqual(events[-1]['metrics']['call_count'], len(requests))
                self.assertEqual(events[-1]['metrics']['prompt_tokens'], 11 * len(requests))
                self.assertEqual(events[-1]['metrics']['completion_tokens'], 7 * len(requests))
                self.assertNotIn(KEY, response.text)
                token_stream.assert_not_called()
                self.assert_free()

    def test_invalid_input_v1_and_busy_are_rejected_before_model_call(self):
        wrong = payload()
        wrong['request_fingerprint'] = 'forged'
        data = planning_input()
        data['prefix'][0]['status'] = 'awaiting_confirmation'
        legacy = {'run_id': 'legacy', 'step_id': 'plan', 'attempt_id': 'once', 'input_revision': 0,
                  'credentials': {'api_key': KEY}, 'input': planning_input()}
        with patch.object(service, 'request_text', new_callable=AsyncMock) as model:
            for body in (wrong, payload(data), payload(key=''), legacy):
                with self.subTest(body=body['run_id'], v2='connection' in body):
                    response = self.client.post('/api/compute/plan_chapter/stream', json=body)
                    self.assertEqual(response.status_code, 400, response.text)
                    self.assert_free()
            self.slots.acquire()
            self.slots.acquire()
            try:
                response = self.client.post('/api/compute/plan_chapter/stream', json=payload())
                self.assertEqual(response.status_code, 429, response.text)
            finally:
                self.slots.release()
                self.slots.release()
            model.assert_not_awaited()
        self.assert_free()

    def test_upstream_failure_has_safe_terminal_error_and_no_retry(self):
        marker = 'RAW_PROVIDER_SECRET_SENTINEL'
        body = payload()
        for failure, code in ((DeepSeekClientError(marker + KEY), 'provider_error'),
                              (RuntimeError(marker + KEY), 'internal_error')):
            with self.subTest(code=code), patch.object(service, 'request_text', AsyncMock(side_effect=failure)) as model:
                response = self.client.post('/api/compute/plan_chapter/stream', json=body)
                self.assertEqual(response.status_code, 200, response.text)
                events = frames(response.content)
                contract = checked(body, events, complete=False)
                self.assertEqual(contract.terminal, 'error')
                self.assertEqual(events[-1]['code'], code)
                self.assertNotIn(marker, response.text)
                self.assertNotIn(KEY, response.text)
                self.assertFalse(any(event['type'] == 'done' for event in events))
                with self.assertRaises(ValueError):
                    contract.finish()
                model.assert_awaited_once()
        self.assert_free()

    def test_second_invalid_candidate_finishes_for_author_decision(self):
        bad = candidate()
        bad['task_payload']['canon_budget'] = 'normal'
        body = payload()
        with patch.object(service, 'request_text', AsyncMock(return_value=json.dumps(bad))) as model:
            response = self.client.post('/api/compute/plan_chapter/stream', json=body)
        self.assertEqual(response.status_code, 200, response.text)
        events = frames(response.content)
        result = checked(body, events)
        self.assertEqual(result['status'], 'needs_user_decision')
        self.assertEqual(result['repair_count'], 1)
        self.assertIn('canon_budget_changed', [issue['code'] for issue in result['issues']])
        self.assertEqual(sum(event['type'] == 'progress' for event in events), 10)
        self.assertEqual(model.await_count, 2)
        self.assert_free()

    def test_inner_stream_must_close_normally_before_done_is_published(self):
        body = payload()
        for failure in ('late_error', 'extra_event', 'missing_done', 'unsafe_progress'):
            with self.subTest(failure=failure):
                async def inner(*args, **kwargs):
                    if failure == 'unsafe_progress':
                        yield {'type': 'progress', 'node': 'context_pack', 'visit': 1,
                               'status': 'started', 'elapsed_ms': 0,
                               'state': {'secret': 'RAW_STATE_SENTINEL'}}
                        return
                    rows = base_events('normal', identity=identity(body))
                    for row in rows[1:]:
                        if row['type'] == 'done' and failure == 'missing_done':
                            break
                        projected = {key: value for key, value in row.items()
                                     if key not in IDENTITY_FIELDS | {'event_version', 'seq', 'chapter_number', 'metrics'}}
                        if projected['type'] == 'progress':
                            projected['elapsed_ms'] = 0
                        yield projected
                    if failure == 'late_error':
                        raise RuntimeError('RAW_STREAM_TAIL_SENTINEL')
                    if failure == 'extra_event':
                        yield {'type': 'progress', 'node': 'validate', 'visit': 2,
                               'status': 'started', 'elapsed_ms': 0}

                with patch.object(route, 'stream_compute', side_effect=inner), \
                        patch.object(service, 'request_text', new_callable=AsyncMock) as model:
                    response = self.client.post('/api/compute/plan_chapter/stream', json=body)
                self.assertEqual(response.status_code, 200, response.text)
                events = frames(response.content)
                contract = checked(body, events, complete=False)
                self.assertEqual(contract.terminal, 'error')
                self.assertFalse(any(event['type'] == 'done' for event in events))
                self.assertNotIn('RAW_STATE_SENTINEL', response.text)
                self.assertNotIn('RAW_STREAM_TAIL_SENTINEL', response.text)
                model.assert_not_awaited()
                self.assert_free()


class PlanningStreamAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.slots = threading.BoundedSemaphore(2)
        admission = patch.object(route, '_CALLS', self.slots)
        admission.start()
        self.addCleanup(admission.stop)
        self.tasks = []

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
        self.assertTrue(self.slots.acquire(False))
        self.assertTrue(self.slots.acquire(False))
        self.assertFalse(self.slots.acquire(False))
        self.slots.release()
        self.slots.release()

    async def test_progress_is_sent_while_initial_model_is_still_waiting(self):
        entered, release = asyncio.Event(), asyncio.Event()

        async def model(*args, **kwargs):
            entered.set()
            await release.wait()
            return json.dumps(candidate())

        body = payload()
        harness = StreamHarness(body)
        with patch.object(service, 'request_text', side_effect=model):
            task = self.start(harness)
            await asyncio.wait_for(entered.wait(), 2)
            await harness.wait_for(lambda events: any(event.get('node') == 'initial_proposal' and
                                    event.get('status') == 'started' for event in events))
            self.assertFalse(task.done())
            self.assertEqual([event['node'] for event in harness.events if event['type'] == 'progress'],
                             ['context_pack', 'context_pack', 'initial_proposal'])
            self.assertFalse(any(event['type'] == 'done' for event in harness.events))
            release.set()
            await asyncio.wait_for(task, 2)
        self.assertEqual(checked(body, harness.events)['status'], 'draft_ready')
        self.assert_free()

    async def test_disconnect_before_started_has_no_model_call_and_frees_admission(self):
        async def send(message):
            if message['type'] == 'http.response.start':
                await asyncio.Event().wait()

        harness = StreamHarness(payload(), send)
        harness.disconnected.set()
        with patch.object(service, 'request_text', new_callable=AsyncMock) as model:
            await asyncio.wait_for(self.start(harness), 2)
            model.assert_not_awaited()
        self.assertEqual(harness.messages, [])
        self.assert_free()

    async def test_disconnect_in_initial_or_repair_waits_for_upstream_cleanup(self):
        for spec_version, repair in (('2.3', False), ('2.3', True), ('2.4', False), ('2.4', True)):
            with self.subTest(spec_version=spec_version, repair=repair):
                entered, cleaned = asyncio.Event(), asyncio.Event()
                calls = 0
                bad = candidate()
                bad['task_payload']['canon_budget'] = 'normal'

                async def model(*args, **kwargs):
                    nonlocal calls
                    calls += 1
                    if repair and calls == 1:
                        return json.dumps(bad)
                    entered.set()
                    try:
                        await asyncio.Event().wait()
                    finally:
                        await asyncio.sleep(.01)
                        cleaned.set()

                harness = StreamHarness(payload(), spec_version=spec_version)
                with patch.object(service, 'request_text', side_effect=model):
                    task = self.start(harness)
                    await asyncio.wait_for(entered.wait(), 2)
                    harness.disconnected.set()
                    await asyncio.wait_for(task, 2)
                self.assertTrue(cleaned.is_set())
                self.assertEqual(calls, 2 if repair else 1)
                self.assertFalse(any(event['type'] == 'done' for event in harness.events))
                checked(harness.body, harness.events, complete=False)
                self.assert_free()

    async def test_absolute_deadline_cancels_initial_model_and_releases_admission(self):
        entered, cleaned = asyncio.Event(), asyncio.Event()

        async def model(*args, **kwargs):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(.01)
                cleaned.set()

        harness = StreamHarness(payload())
        began = monotonic()
        with patch.object(route, 'MAX_COMPUTE_SECONDS', .12), patch.object(service, 'request_text', side_effect=model):
            await asyncio.wait_for(self.start(harness), 2)
        self.assertTrue(entered.is_set())
        self.assertTrue(cleaned.is_set())
        self.assertLess(monotonic() - began, 1)
        self.assertFalse(any(event['type'] == 'done' for event in harness.events))
        checked(harness.body, harness.events, complete=False)
        self.assert_free()

    async def test_absolute_deadline_covers_blocked_asgi_send(self):
        entered, cleaned, blocked = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def model(*args, **kwargs):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                await asyncio.sleep(.01)
                cleaned.set()

        async def send(message):
            if message['type'] == 'http.response.body' and (blocked.is_set() or
                    b'initial_proposal' in message.get('body', b'')):
                await entered.wait()
                blocked.set()
                await asyncio.Event().wait()

        harness = StreamHarness(payload(), send)
        began = monotonic()
        with patch.object(route, 'MAX_COMPUTE_SECONDS', .15), patch.object(service, 'request_text', side_effect=model):
            await asyncio.wait_for(self.start(harness), 2)
        self.assertTrue(blocked.is_set())
        self.assertTrue(cleaned.is_set())
        self.assertLess(monotonic() - began, 1)
        self.assertFalse(any(event['type'] == 'done' for event in harness.events))
        self.assert_free()

    async def test_repeated_cancel_with_full_queue_waits_for_model_cleanup_before_release(self):
        entered, blocked = asyncio.Event(), asyncio.Event()
        cleanup_began, cleanup_allow, cleaned = asyncio.Event(), asyncio.Event(), asyncio.Event()
        queues = []
        queue_class = asyncio.Queue

        def queue_factory(*args, **kwargs):
            queue = queue_class(*args, **kwargs)
            if queue.maxsize == 34:
                queues.append(queue)
            return queue

        async def model(*args, **kwargs):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleanup_began.set()
                await cleanup_allow.wait()
                cleaned.set()

        async def send(message):
            if message['type'] == 'http.response.body' and b'initial_proposal' in message.get('body', b''):
                await entered.wait()
                blocked.set()
                await asyncio.Event().wait()

        harness = StreamHarness(payload(), send, spec_version='2.4')
        with patch.object(planning.asyncio, 'Queue', side_effect=queue_factory), \
                patch.object(service, 'request_text', side_effect=model), \
                patch.object(self.slots, 'release', wraps=self.slots.release) as released:
            task = self.start(harness)
            try:
                await asyncio.wait_for(blocked.wait(), 2)
                self.assertEqual(len(queues), 1)
                queue = queues[0]
                while not queue.full():
                    queue.put_nowait(object())
                self.assertEqual(queue.qsize(), 34)
                task.cancel()
                await asyncio.wait_for(cleanup_began.wait(), 2)
                task.cancel()
                await asyncio.sleep(0)
                self.assertFalse(cleaned.is_set())
                self.assertFalse(task.done())
                released.assert_not_called()
            finally:
                cleanup_allow.set()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, 2)
            self.assertTrue(cleaned.is_set())
            released.assert_called_once_with()
        self.assertFalse(any(event['type'] == 'done' for event in harness.events))
        self.assert_free()

    async def test_concurrent_streams_do_not_share_identity_or_candidate(self):
        entered, release = asyncio.Event(), asyncio.Event()
        calls = 0

        async def model(provider, messages, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                entered.set()
            await release.wait()
            result = candidate()
            result['task_payload']['notes'] = json.loads(messages[1]['content'])['author_intent']
            return json.dumps(result)

        harnesses = []
        for marker in ('REQUEST_A_SENTINEL', 'REQUEST_B_SENTINEL'):
            data = planning_input()
            data['author_intent'] = marker
            body = payload(data)
            body.update(run_id=marker, step_id=marker + '-step', attempt_id=marker + '-attempt')
            harnesses.append(StreamHarness(body))
        with patch.object(service, 'request_text', side_effect=model):
            tasks = [self.start(harness) for harness in harnesses]
            await asyncio.wait_for(entered.wait(), 2)
            self.assertFalse(self.slots.acquire(False))
            release.set()
            await asyncio.wait_for(asyncio.gather(*tasks), 2)
        for harness in harnesses:
            result = checked(harness.body, harness.events)
            self.assertEqual(result['task_payload']['notes'], harness.body['input']['author_intent'])
        self.assertEqual(calls, 2)
        self.assert_free()


if __name__ == '__main__':
    unittest.main()
