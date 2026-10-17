from __future__ import annotations
import json
import unittest
from unittest.mock import AsyncMock, patch
from services.compute_service import compute, ComputeError
from services.writing_style_service import distillation_messages
from provider_catalog import normalize_connection, request_fingerprint
from structured_schemas import SCHEMAS

SOURCE = {'kind': 'import', 'label': '合成单章'}
PREVIOUS = {'name': '克制', 'rules': '以动作表达情绪。', 'examples': []}
CREDENTIALS = {'api_key': 'sk-' + 't' * 32, 'model': 'deepseek-v4-flash'}

class StyleDistillationTests(unittest.IsolatedAsyncioTestCase):
    async def test_each_round_uses_one_call_with_full_output_budget(self):
        previous = None
        for number in range(1, 6):
            request = {'source_text': '雨停了。他没有松手。', 'source': SOURCE, 'round_number': number, 'previous_draft': previous}
            with patch('services.compute_service.request_text', AsyncMock(return_value=json.dumps(PREVIOUS, ensure_ascii=False))) as model:
                result = await compute('distill_style_step', request, CREDENTIALS, {})
                self.assertEqual(model.await_count, 1)
                self.assertEqual(model.call_args.kwargs['max_tokens'], 20000)
                self.assertTrue(model.call_args.kwargs['json_mode'])
                payload = json.loads(model.call_args.args[1][1]['content'])
                self.assertEqual(payload['previous_draft'], previous)
                self.assertEqual(payload['selected_prose'], request['source_text'])
                self.assertEqual(result['rules'], PREVIOUS['rules'])
            previous = PREVIOUS

    async def test_over_limit_and_bad_round_fail_before_any_call(self):
        for update in [{'source_text': '𠮷' * 20001}, {'round_number': 0}, {'round_number': 6},
                       {'round_number': True}, {'round_number': 2}, {'previous_draft': PREVIOUS},
                       {'source': {'kind': 'project', 'label': '多章', 'chapter_numbers': [1,2]}}]:
            data = {'source_text': '原文。', 'source': SOURCE, 'round_number': 1, 'previous_draft': None, **update}
            with patch('services.compute_service.request_text', AsyncMock()) as model:
                with self.assertRaises(ComputeError):
                    await compute('distill_style_step', data, CREDENTIALS, {})
                model.assert_not_awaited()
        distillation_messages('𠮷' * 20000, 1, None)

    async def test_fabricated_examples_removed_and_no_score_fields(self):
        output = {**PREVIOUS, 'examples': [{'text': '没有出现的句子。', 'scene_tags': [], 'pov': '', 'pace': ''}]}
        with patch('services.compute_service.request_text', AsyncMock(return_value=json.dumps(output, ensure_ascii=False))):
            result = await compute('distill_style_step', {'source_text': '真实原文。', 'source': SOURCE, 'round_number': 1, 'previous_draft': None}, CREDENTIALS, {})
        self.assertEqual(result['candidate_examples'], [])
        self.assertEqual(len(result['warnings']), 1)
        self.assertEqual(set(result), {'name', 'rules', 'candidate_examples', 'warnings'})

    async def test_invalid_json_is_not_retried(self):
        with patch('services.compute_service.request_text', AsyncMock(return_value='unparseable')) as model:
            with self.assertRaises(ComputeError):
                await compute('distill_style_step', {'source_text': '原文。', 'source': SOURCE, 'round_number': 1}, CREDENTIALS, {})
            self.assertEqual(model.await_count, 1)

    def test_schema_and_fingerprint_use_distillation_budget(self):
        self.assertIn('distill_style_step', SCHEMAS)
        with patch('provider_catalog.digest', side_effect=lambda text: text):
            value = request_fingerprint({'execution_fingerprint': 'sample', 'policy': {'temperature': 'omit'}}, 'distill_style_step', {})
        self.assertEqual(json.loads(value)['parameters'][0]['tokens'], 20000)
