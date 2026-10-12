from __future__ import annotations

import asyncio
import threading
import unittest
from unittest.mock import patch

from api import main
from api.routers import compute as route
from services import compute_service as service
from tests.test_chapter_planning_stream import StreamHarness
from tests.test_compute_reliability import body_input, payload


class TextStreamHarness(StreamHarness):
    def __init__(self, operation, send_hook=None, spec_version='2.3'):
        data = body_input() if operation == 'generate_chapter' else {
            'request': {'context_text': '门外传来脚步声。', 'instruction': '继续这个场景。'}}
        super().__init__(payload(data), send_hook, spec_version)
        self.path = '/api/compute/' + operation + '/stream'

    async def run(self):
        scope = {'type': 'http', 'asgi': {'version': '3.0', 'spec_version': self.spec_version},
                 'http_version': '1.1', 'method': 'POST', 'scheme': 'http',
                 'path': self.path, 'raw_path': self.path.encode(), 'query_string': b'',
                 'root_path': '', 'server': ('test', 80), 'client': ('test', 123),
                 'headers': [(b'content-type', b'application/json'),
                             (b'content-length', str(len(self.raw)).encode())]}
        await main.app(scope, self.receive, self.send)


class TextStreamLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.slots = threading.BoundedSemaphore(2)
        self.admission = patch.object(route, '_CALLS', self.slots)
        self.admission.start(); self.addCleanup(self.admission.stop)
        self.tasks = []

    async def asyncTearDown(self):
        for task in self.tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)

    def assert_free(self):
        self.assertTrue(self.slots.acquire(False)); self.assertTrue(self.slots.acquire(False))
        self.assertFalse(self.slots.acquire(False))
        self.slots.release(); self.slots.release()

    async def test_prose_response_headers_obey_deadline_before_model_call(self):
        for operation in ('generate_chapter', 'continue_chapter'):
            for spec in ('2.3', '2.4'):
                for public in (False, True):
                    with self.subTest(operation=operation, spec=spec, public=public):
                        reached = asyncio.Event()
                        async def send(message):
                            if message['type'] == 'http.response.start':
                                reached.set()
                                await asyncio.Event().wait()
                        harness = TextStreamHarness(operation, send, spec)
                        with patch.object(main, 'PUBLIC_MODE', public), patch.object(route, 'MAX_COMPUTE_SECONDS', .15), \
                                patch.object(service, 'request_text_stream') as model:
                            task = asyncio.create_task(harness.run()); self.tasks.append(task)
                            await asyncio.wait_for(reached.wait(), 1)
                            await asyncio.wait_for(task, 1)
                            model.assert_not_called()
                        self.assertEqual(harness.messages, [])
                        self.assert_free()

    async def test_blocked_body_deadline_waits_for_real_provider_cleanup(self):
        for operation in ('generate_chapter', 'continue_chapter'):
            for spec in ('2.3', '2.4'):
                with self.subTest(operation=operation, spec=spec):
                    reached, closing, allow_close, closed = (asyncio.Event() for _ in range(4))
                    calls = []
                    async def model(*args, **kwargs):
                        calls.append(1)
                        try:
                            yield {'kind': 'content', 'text': '他转身看向门口。'}
                            await asyncio.Event().wait()
                        finally:
                            closing.set()
                            await allow_close.wait()
                            closed.set()
                    async def send(message):
                        if message['type'] == 'http.response.body' and b'"delta"' in message.get('body', b''):
                            reached.set()
                            await asyncio.Event().wait()
                    harness = TextStreamHarness(operation, send, spec)
                    with patch.object(main, 'PUBLIC_MODE', True), patch.object(route, 'MAX_COMPUTE_SECONDS', .15), \
                            patch.object(service, 'request_text_stream', model):
                        task = asyncio.create_task(harness.run()); self.tasks.append(task)
                        try:
                            await asyncio.wait_for(reached.wait(), 1)
                            await asyncio.wait_for(closing.wait(), 1)
                            self.assertFalse(task.done()); self.assertFalse(closed.is_set())
                            self.assertTrue(self.slots.acquire(False)); self.assertFalse(self.slots.acquire(False))
                            self.slots.release()
                        finally:
                            allow_close.set()
                        await asyncio.wait_for(task, 1)
                    self.assertEqual(calls, [1]); self.assertTrue(closed.is_set())
                    self.assertFalse(any(event['type'] == 'done' for event in harness.events))
                    self.assert_free()

    async def test_idle_disconnect_and_repeated_cancellation_keep_slot_until_cleanup(self):
        for operation in ('generate_chapter', 'continue_chapter'):
            for spec in ('2.3', '2.4'):
                with self.subTest(operation=operation, spec=spec):
                    entered, closing, allow_close, closed = (asyncio.Event() for _ in range(4))
                    calls = []
                    async def model(*args, **kwargs):
                        calls.append(1); entered.set()
                        try:
                            await asyncio.Event().wait()
                            yield {'kind': 'content', 'text': 'unreachable'}
                        finally:
                            closing.set()
                            await allow_close.wait()
                            closed.set()
                    harness = TextStreamHarness(operation, spec_version=spec)
                    with patch.object(main, 'PUBLIC_MODE', True), patch.object(service, 'request_text_stream', model):
                        task = asyncio.create_task(harness.run()); self.tasks.append(task)
                        try:
                            await asyncio.wait_for(entered.wait(), 1)
                            harness.disconnected.set()
                            await asyncio.wait_for(closing.wait(), 1)
                            task.cancel(); await asyncio.sleep(0)
                            task.cancel(); await asyncio.sleep(0)
                            self.assertFalse(closed.is_set()); self.assertFalse(task.done())
                            self.assertTrue(self.slots.acquire(False)); self.assertFalse(self.slots.acquire(False))
                            self.slots.release()
                        finally:
                            allow_close.set()
                        await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 1)
                    self.assertEqual(calls, [1]); self.assertTrue(closed.is_set())
                    self.assertFalse(any(event['type'] == 'done' for event in harness.events))
                    self.assert_free()

    async def test_success_wire_events_and_identity_are_unchanged(self):
        for operation in ('generate_chapter', 'continue_chapter'):
            async def model(*args, **kwargs):
                yield {'kind': 'content', 'text': '他转身看向门口。'}
            harness = TextStreamHarness(operation)
            with patch.object(main, 'PUBLIC_MODE', True), patch.object(service, 'request_text_stream', model):
                await asyncio.wait_for(harness.run(), 1)
            self.assertEqual([event['type'] for event in harness.events], ['started', 'delta', 'done'])
            self.assertTrue(all(event['attempt_id'] == harness.body['attempt_id'] for event in harness.events))
            self.assert_free()


if __name__ == '__main__':
    unittest.main()
