from __future__ import annotations

import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import deepseek_client as client
from services.generation_service import generate_single_chapter, stream_generate_single_chapter


MESSAGES = [{"role": "user", "content": "生成正文"}]


def response(content=None, reasoning=None, finish_reason="stop"):
    return SimpleNamespace(choices=[SimpleNamespace(
        message=SimpleNamespace(content=content, reasoning_content=reasoning),
        finish_reason=finish_reason,
    )])


def chunk(content=None, reasoning=None, finish_reason=None):
    return {"choices": [{"delta": {"content": content, "reasoning_content": reasoning},
                         "finish_reason": finish_reason}]}


class DeepSeekContentTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(client, "_get_api_key", return_value="mock-test-key"))
        self.stack.enter_context(patch.object(client, "_get_base_url", return_value="https://example.invalid"))
        self.sdk = MagicMock()
        self.stack.enter_context(patch.object(client, "OpenAI", return_value=self.sdk))

    def test_sync_reasoning_only_is_rejected(self):
        self.sdk.chat.completions.create.return_value = response(reasoning="这是思考，不是正文。")
        with self.assertRaisesRegex(client.DeepSeekClientError, "内容为空"):
            client.generate_text(MESSAGES)

    def test_sync_final_content_wins_and_reasoning_never_leaks(self):
        self.sdk.chat.completions.create.return_value = response(content=" 正文。 ", reasoning="思考。")
        self.assertEqual(client.generate_text(MESSAGES), "正文。")

    def test_sync_length_is_rejected_even_with_nonempty_content(self):
        self.sdk.chat.completions.create.return_value = response(content="这是被截断的半句", finish_reason="length")
        with self.assertRaisesRegex(client.DeepSeekClientError, "截断"):
            client.generate_text(MESSAGES)

    def test_connectivity_check_can_accept_reasoning_only(self):
        self.sdk.chat.completions.create.return_value = response(reasoning="OK", finish_reason="length")
        ok, _ = client.test_deepseek_connection("mock-key", "mock-model")
        self.assertTrue(ok)

    def test_dictionary_extraction_is_strict_unless_explicitly_opted_in(self):
        message = {"content": "", "reasoning_content": "思考"}
        self.assertEqual(client._extract_message_text(message), "")
        self.assertEqual(client._extract_message_text(message, allow_reasoning=True), "思考")

    def test_stream_length_exposes_partial_text_but_ends_in_error(self):
        self.sdk.chat.completions.create.return_value = iter([
            chunk(reasoning="思考"), chunk(content="部分正文"), chunk(finish_reason="length"),
            {"choices": [], "usage": {"completion_tokens": 10}},
        ])
        events = client.stream_generate_text_events(MESSAGES)
        self.assertEqual(next(events), {"kind": "reasoning", "text": "思考"})
        self.assertEqual(next(events), {"kind": "content", "text": "部分正文"})
        with self.assertRaisesRegex(client.DeepSeekClientError, "截断"):
            list(events)

    def test_json_mode_is_explicit_and_preserves_string_result(self):
        messages = [{"role": "system", "content": '输出 JSON 对象，例如 {"summary":"摘要"}。'}]
        body = '{"summary":"原样返回"}'
        self.sdk.chat.completions.create.return_value = response(content=body)
        for enabled in (False, True):
            with self.subTest(enabled=enabled):
                self.assertEqual(client.generate_text(messages, json_mode=enabled), body)
                sent = self.sdk.chat.completions.create.call_args.kwargs
                if enabled:
                    self.assertEqual(sent["response_format"], {"type": "json_object"})
                else:
                    self.assertNotIn("response_format", sent)

    def test_json_mode_requires_instruction_before_request(self):
        for messages in (MESSAGES, [{"role": "assistant", "content": "JSON"}]):
            with self.subTest(messages=messages):
                with self.assertRaisesRegex(client.DeepSeekClientError, "JSON 模式需要"):
                    client.generate_text(messages, json_mode=True)
        self.sdk.chat.completions.create.assert_not_called()

    def test_json_mode_still_rejects_empty_or_truncated_output(self):
        messages = [{"role": "user", "content": '返回 json，例如 {"summary":"摘要"}。'}]
        for result in (response(reasoning="思考"), response(content='{"summary":"半句', finish_reason="length")):
            with self.subTest(result=result):
                self.sdk.chat.completions.create.reset_mock()
                self.sdk.chat.completions.create.return_value = result
                with self.assertRaises(client.DeepSeekClientError):
                    client.generate_text(messages, json_mode=True)
                self.sdk.chat.completions.create.assert_called_once()

    def test_json_mode_provider_failure_does_not_silently_retry_as_text(self):
        self.sdk.chat.completions.create.side_effect = RuntimeError("unsupported response_format")
        with self.assertRaisesRegex(client.DeepSeekClientError, "unsupported response_format"):
            client.generate_text([{"role": "user", "content": "Return JSON: {}"}], json_mode=True)
        self.sdk.chat.completions.create.assert_called_once()

    def test_stream_normal_stop_and_usage_trailer_are_supported(self):
        self.sdk.chat.completions.create.return_value = iter([
            chunk(reasoning="思考"), chunk(content="完整正文"), chunk(finish_reason="stop"),
            {"choices": [], "usage": {}},
        ])
        self.assertEqual(list(client.stream_generate_text(MESSAGES)), ["完整正文"])

    def test_stream_object_choice_also_checks_finish_reason(self):
        self.sdk.chat.completions.create.return_value = iter([SimpleNamespace(choices=[SimpleNamespace(
            delta=SimpleNamespace(content="部分正文", reasoning_content=None), finish_reason="length",
        )])])
        with self.assertRaisesRegex(client.DeepSeekClientError, "截断"):
            list(client.stream_generate_text_events(MESSAGES))

    def test_stream_empty_reasoning_only_and_whitespace_are_rejected(self):
        for chunks in ([], [chunk(reasoning="思考")], [chunk(content=" \n "), chunk(finish_reason="stop")]):
            with self.subTest(chunks=chunks):
                self.sdk.chat.completions.create.return_value = iter(chunks)
                with self.assertRaisesRegex(client.DeepSeekClientError, "without final content"):
                    list(client.stream_generate_text_events(MESSAGES))

    def test_sync_truncation_cannot_reach_chapter_persistence(self):
        self.sdk.chat.completions.create.return_value = response(content="部分正文", finish_reason="length")
        with patch("services.generation_service.build_generation_messages", return_value=(MESSAGES, [])), \
             patch("services.generation_service._finalize_generated_chapter") as persist:
            result = generate_single_chapter(
                "book:mock", 1, {}, {"chapter": "mock", "summary": "mock"}, 0.7, 100, True,
            )
        self.assertFalse(result.ok)
        persist.assert_not_called()

    def test_stream_truncation_cannot_reach_chapter_persistence(self):
        self.sdk.chat.completions.create.return_value = iter([
            chunk(content="部分正文"), chunk(finish_reason="length"),
        ])
        with patch("services.generation_service.build_generation_messages", return_value=(MESSAGES, [])), \
             patch("services.generation_service._finalize_generated_chapter") as persist:
            events = list(stream_generate_single_chapter(
                "book:mock", 1, {}, {"chapter": "mock", "summary": "mock"}, 0.7, 100, True,
            ))
        self.assertEqual([event["type"] for event in events], ["delta", "error"])
        self.assertEqual(events[-1]["partial_length"], len("部分正文"))
        persist.assert_not_called()


if __name__ == "__main__":
    unittest.main()
