from __future__ import annotations

import json
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import deepseek_client as client
from services import generation_service as generation
from services.schemas import ChapterGenerationResult


MESSAGES = [{"role": "user", "content": "This private prompt must not enter metrics."}]
BODY = "# 第 2 章：夜色\n\n正文只保存故事。"
MODELS = {"chapter": "mock-model", "summary": "mock-model"}


def response(usage=None, finish_reason="stop"):
    return SimpleNamespace(choices=[SimpleNamespace(
        message=SimpleNamespace(content=BODY, reasoning_content="private reasoning"),
        finish_reason=finish_reason,
    )], usage=usage)


def chunk(content=None, reasoning=None, finish_reason=None, usage=None):
    return {"choices": [{"delta": {"content": content, "reasoning_content": reasoning},
                         "finish_reason": finish_reason}], "usage": usage}


class GenerationMetricsTests(unittest.TestCase):
    def setUp(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(client, "_get_api_key", return_value="mock-secret-never-log"))
        stack.enter_context(patch.object(client, "_get_base_url", return_value="https://example.invalid"))
        self.sdk = MagicMock()
        stack.enter_context(patch.object(client, "OpenAI", return_value=self.sdk))
        stack.enter_context(patch.object(generation, "build_generation_messages", return_value=(MESSAGES, [])))
        stack.enter_context(patch.object(generation, "_chapter_ai_run_metadata", return_value={}))
        self.now = 10.0
        stack.enter_context(patch.object(generation, "perf_counter", side_effect=lambda: self.now))
        self.log = stack.enter_context(patch.object(generation._metrics_logger, "info"))
        self.persist = stack.enter_context(patch.object(generation, "_finalize_generated_chapter", side_effect=self.save))

    def save(self, project_ref, number, content, *_args):
        self.now += 2.0  # Measurable local persistence time, with no filesystem writes.
        return ChapterGenerationResult(True, chapter_number=number, content=content,
                                       chapter_path="chapter_002.md", index_path="index.json")

    def generate(self, streaming=False):
        method = generation.stream_generate_single_chapter if streaming else generation.generate_single_chapter
        return method("book:metrics-test", 2, {}, MODELS, 0.7, 16384, True)

    def record(self):
        self.log.assert_called_once()
        text = self.log.call_args.args[0]
        self.assertEqual(len(text.splitlines()), 1)
        for private in (MESSAGES[0]["content"], BODY, "private reasoning", "mock-secret-never-log"):
            self.assertNotIn(private, text)
        return json.loads(text)

    def test_sync_deepseek_usage_preserves_zero_and_ignores_private_payload(self):
        self.sdk.chat.completions.create.return_value = response(SimpleNamespace(
            prompt_tokens=100, completion_tokens=20, prompt_cache_hit_tokens=0,
            prompt_cache_miss_tokens=100,
            prompt_tokens_details=SimpleNamespace(cached_tokens=90),
            completion_tokens_details=SimpleNamespace(reasoning_tokens=7),
            private_provider_payload="must not be copied",
        ))
        metrics = {}
        self.assertEqual(client.generate_text(MESSAGES, usage_metrics=metrics), BODY)
        self.assertEqual(metrics, {
            "prompt_tokens": 100, "completion_tokens": 20, "prompt_cache_hit_tokens": 0,
            "prompt_cache_miss_tokens": 100, "reasoning_tokens": 7,
        })

    def test_compatible_cached_tokens_fallback_derives_misses(self):
        self.sdk.chat.completions.create.return_value = response({
            "prompt_tokens": 100, "completion_tokens": 20,
            "prompt_tokens_details": {"cached_tokens": 40},
            "completion_tokens_details": {"reasoning_tokens": 0},
        })
        metrics = {}
        client.generate_text(MESSAGES, usage_metrics=metrics)
        self.assertEqual(metrics["prompt_cache_hit_tokens"], 40)
        self.assertEqual(metrics["prompt_cache_miss_tokens"], 60)
        self.assertEqual(metrics["reasoning_tokens"], 0)

    def test_absent_and_invalid_usage_remains_unknown_instead_of_zero(self):
        for usage in (None, {}, {"prompt_tokens": True, "completion_tokens": "20", "prompt_cache_hit_tokens": -1}):
            with self.subTest(usage=usage):
                self.sdk.chat.completions.create.return_value = response(usage)
                metrics = {}
                client.generate_text(MESSAGES, usage_metrics=metrics)
                self.assertEqual(metrics, {})
        self.sdk.chat.completions.create.return_value = response({
            "prompt_tokens": 0, "completion_tokens": 0, "prompt_tokens_details": {"cached_tokens": 0},
        })
        metrics = {}
        client.generate_text(MESSAGES, usage_metrics=metrics)
        self.assertEqual(metrics, {"prompt_tokens": 0, "completion_tokens": 0, "prompt_cache_hit_tokens": 0, "prompt_cache_miss_tokens": 0})

    def test_stream_collects_final_usage_with_or_without_choices(self):
        usage = {"prompt_tokens": 80, "completion_tokens": 12, "prompt_cache_hit_tokens": 30, "prompt_cache_miss_tokens": 50}
        trailers = [
            {"choices": [], "usage": usage},
            chunk(finish_reason="stop", usage=usage),
            SimpleNamespace(choices=[], usage=SimpleNamespace(**usage)),
        ]
        for trailer in trailers:
            with self.subTest(trailer=trailer):
                self.sdk.chat.completions.create.return_value = iter([chunk(content=BODY), trailer])
                metrics = {}
                events = list(client.stream_generate_text_events(MESSAGES, usage_metrics=metrics))
                self.assertEqual(events, [{"kind": "content", "text": BODY}])
                self.assertEqual(metrics, usage)

    def test_sync_latency_includes_persistence_without_inventing_first_content_time(self):
        def request(**_kwargs):
            self.now = 13.0
            return response({"prompt_tokens": 40, "completion_tokens": 10})
        self.sdk.chat.completions.create.side_effect = request
        result = self.generate()
        self.assertTrue(result.ok)
        self.assertEqual(result.content, BODY)
        self.persist.assert_called_once()
        record = self.record()
        self.assertEqual((record["status"], record["streaming"]), ("success", False))
        self.assertEqual((record["first_content_ms"], record["body_complete_ms"], record["total_ms"]), (None, 3000.0, 5000.0))
        self.assertIsNone(record["prompt_cache_hit_tokens"])
        self.assertIsNone(record["prompt_cache_miss_tokens"])
        self.assertEqual(record["prompt_tokens"], 40)
        self.assertTrue(record["template_version"])

    def test_final_compatible_usage_updates_early_zero_snapshot(self):
        self.sdk.chat.completions.create.return_value = iter([
            chunk(content=BODY, usage={
                "prompt_tokens": 100, "completion_tokens": 0,
                "prompt_tokens_details": {"cached_tokens": 0},
                "completion_tokens_details": {"reasoning_tokens": 0},
            }),
            {"choices": [], "usage": {
                "prompt_tokens": 100, "completion_tokens": 24,
                "prompt_tokens_details": {"cached_tokens": 64},
                "completion_tokens_details": {"reasoning_tokens": 8},
            }},
        ])
        metrics = {}
        self.assertEqual(list(client.stream_generate_text_events(MESSAGES, usage_metrics=metrics)), [{"kind": "content", "text": BODY}])
        self.assertEqual(metrics, {"prompt_tokens": 100, "completion_tokens": 24,
                                   "prompt_cache_hit_tokens": 64, "prompt_cache_miss_tokens": 36, "reasoning_tokens": 8})

    def test_stream_first_content_ignores_reasoning_and_whitespace_and_prose_stays_clean(self):
        def provider():
            self.now = 11.0
            yield chunk(reasoning="private reasoning")
            self.now = 12.0
            yield chunk(content=" \n")
            self.now = 13.0
            yield chunk(content=BODY)
            self.now = 16.0
            yield {"choices": [], "usage": {"prompt_tokens": 100, "completion_tokens": 20}}
        self.sdk.chat.completions.create.return_value = provider()
        events = list(self.generate(streaming=True))
        self.assertEqual([event["type"] for event in events], ["reasoning", "delta", "delta", "done"])
        self.assertEqual(self.persist.call_args.args[2], BODY)
        self.assertEqual(set(events[-1]), {"type", "ok", "chapter_number", "title", "chapter_file", "summary_file", "index_file", "message"})
        record = self.record()
        self.assertEqual((record["first_content_ms"], record["body_complete_ms"], record["total_ms"]), (3000.0, 6000.0, 8000.0))
        self.assertEqual((record["status"], record["streaming"]), ("success", True))
        self.assertEqual(record["completion_tokens"], 20)

    def test_sync_truncation_keeps_usage_but_never_saves_body(self):
        self.sdk.chat.completions.create.return_value = response({"completion_tokens": 100}, finish_reason="length")
        result = self.generate()
        self.assertFalse(result.ok)
        self.persist.assert_not_called()
        record = self.record()
        self.assertEqual(record["status"], "error")
        self.assertEqual(record["completion_tokens"], 100)
        self.assertIsNone(record["body_complete_ms"])

    def test_stream_truncation_keeps_trailing_usage_but_never_saves_partial_body(self):
        self.sdk.chat.completions.create.return_value = iter([
            chunk(content="半句话"), chunk(finish_reason="length"),
            {"choices": [], "usage": {"completion_tokens": 100}},
        ])
        events = list(self.generate(streaming=True))
        self.assertEqual([event["type"] for event in events], ["delta", "error"])
        self.persist.assert_not_called()
        record = self.record()
        self.assertEqual(record["status"], "error")
        self.assertEqual(record["completion_tokens"], 100)
        self.assertIsNone(record["body_complete_ms"])

    def test_cancelled_stream_closes_upstream_and_logs_once_as_interrupted(self):
        provider_closed = []
        def provider():
            try:
                self.now = 12.0
                yield chunk(content="部分正文")
                yield chunk(content="尚未接收")
            finally:
                provider_closed.append(True)
        self.sdk.chat.completions.create.return_value = provider()
        events = self.generate(streaming=True)
        self.assertEqual(next(events), {"type": "delta", "text": "部分正文"})
        self.now = 13.0
        events.close()
        self.assertEqual(provider_closed, [True])
        self.persist.assert_not_called()
        record = self.record()
        self.assertEqual(record["status"], "interrupted")
        self.assertEqual((record["first_content_ms"], record["total_ms"]), (2000.0, 3000.0))
        self.assertIsNone(record["body_complete_ms"])
        self.assertIsNone(record["completion_tokens"])

    def test_closing_after_done_preserves_success_and_excludes_consumer_delay(self):
        self.sdk.chat.completions.create.return_value = iter([chunk(content=BODY), chunk(finish_reason="stop")])
        events = self.generate(streaming=True)
        self.assertEqual(next(events)["type"], "delta")
        self.now = 14.0
        self.assertEqual(next(events)["type"], "done")
        self.now = 100.0
        events.close()
        record = self.record()
        self.assertEqual(record["status"], "success")
        self.assertEqual(record["total_ms"], 6000.0)
        self.persist.assert_called_once()

    def test_closing_after_terminal_error_preserves_failure_classification(self):
        self.sdk.chat.completions.create.return_value = iter([
            chunk(content="被截断的正文"), chunk(finish_reason="length", usage={"completion_tokens": 100}),
        ])
        events = self.generate(streaming=True)
        self.assertEqual(next(events)["type"], "delta")
        self.assertEqual(next(events)["type"], "error")
        events.close()
        record = self.record()
        self.assertEqual(record["status"], "error")
        self.assertEqual(record["completion_tokens"], 100)
        self.persist.assert_not_called()

    def test_provider_error_and_persistence_error_still_emit_failure_metrics(self):
        self.sdk.chat.completions.create.side_effect = RuntimeError("provider failed")
        result = self.generate()
        self.assertFalse(result.ok)
        self.persist.assert_not_called()
        self.assertEqual(self.record()["status"], "error")
        self.log.reset_mock()
        self.sdk.chat.completions.create.side_effect = None
        self.sdk.chat.completions.create.return_value = response()
        self.persist.side_effect = OSError("mock disk failure")
        with self.assertRaisesRegex(OSError, "mock disk failure"):
            self.generate()
        self.assertEqual(self.record()["status"], "error")

    def test_logging_failure_cannot_turn_saved_chapter_into_generation_failure(self):
        self.log.side_effect = OSError("stderr unavailable")
        for streaming in (False, True):
            with self.subTest(streaming=streaming):
                self.sdk.chat.completions.create.return_value = iter([chunk(content=BODY)]) if streaming else response()
                result = list(self.generate(streaming=True))[-1] if streaming else self.generate()
                self.assertTrue(result["ok"] if streaming else result.ok)
        self.assertEqual(self.persist.call_count, 2)
        self.assertEqual(self.log.call_count, 2)


if __name__ == "__main__":
    unittest.main()
