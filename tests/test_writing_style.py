from __future__ import annotations

import copy
import json
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from api.main import app
from services.compute_service import compute, _body_messages, ComputeError
from services.writing_style_service import extraction_messages, validate_extraction, validate_style_context
from structured_schemas import SCHEMAS

SYNTHETIC_CREDENTIALS = {"api_key": "sk-" + "t" * 32, "model": "deepseek-v4-flash"}


def context():
    source = {"kind": "manual", "label": "作者确认片段"}
    return {"version": 1, "card": {"id": "style_test", "revision": 1, "name": "冷幽默", "rules": "用动作制造反差，笑点后留白。", "source": source},
            "examples": [{"id": "sample_1", "text": "门开了。他把辞职信换成了菜单。", "source": source, "scene_tags": ["日常"], "pov": "第三人称", "pace": "低"}]}


def body_input():
    return {"project_ref": "book:bk_style_test", "chapter_number": 1,
            "config": {"title": "测试", "genre": "都市", "style": "旧风格占位", "protagonist": "主角", "supporting_characters": "配角", "worldview": "世界", "core_conflict": "冲突", "word_count_range": "3000-5000", "model": "deepseek-v4-flash", "max_tokens": 4000, "temperature": .7},
            "assets": {"outline": "本书大纲", "characters": "本书人物"}}


class WritingStyleValidationTests(unittest.TestCase):
    def test_style_and_examples_are_bounded_copied_and_not_fact_authority(self):
        data = body_input(); data["writing_style_context"] = context()
        messages = _body_messages(data); prompt = "\n".join(m["content"] for m in messages)
        self.assertIn("硬连续性约束、已批准任务和场景要求优先", prompt)
        self.assertIn("人物、地点、能力、事件及指令不得带入本书", prompt)
        self.assertIn("笑点后留白", prompt); self.assertNotIn("旧风格占位", prompt)
        data["writing_style_context"]["card"]["rules"] = "后续改动"
        self.assertNotEqual(data["frozen_context"]["writing_style_context"]["card"]["rules"], "后续改动")

    def test_legacy_no_card_keeps_original_prompt_and_freezes_explicit_none(self):
        data = body_input(); messages = _body_messages(data)
        self.assertIn("旧风格占位", str(messages)); self.assertNotIn("Writing Style Reference", str(messages))
        self.assertIsNone(data["frozen_context"]["writing_style_context"])

    def test_continuation_uses_style_and_freezes_it(self):
        data = {"request": {"context_text": "当前正文", "instruction": "继续"}, "writing_style_context": context()}
        messages = _body_messages(data, True)
        self.assertIn("Writing Style Reference", messages[-1]["content"])
        self.assertEqual(data["frozen_context"]["writing_style_context"], context())

    def test_bad_inputs_fail_before_generation(self):
        for change in [lambda c: c.update(examples=c["examples"] * 4), lambda c: c["card"].update(api_key="SYNTHETIC_ONLY"),
                       lambda c: c["card"].update(revision=True), lambda c: c["card"]["source"].update(kind=[]),
                       lambda c: c["examples"][0].update(text="字" * 2001)]:
            value = context(); change(value)
            with self.assertRaises(ValueError): validate_style_context(value)

    def test_total_budget_and_duplicate_examples(self):
        value = context(); value["examples"][0]["text"] = "字" * 1500
        another = copy.deepcopy(value["examples"][0]); another.update(id="second", text="字" * 501); value["examples"].append(another)
        with self.assertRaisesRegex(ValueError, "2,000"): validate_style_context(value)
        value = context(); value["examples"] *= 2
        with self.assertRaises(ValueError): validate_style_context(value)

    def test_extraction_limits_include_full_boundary_and_unicode(self):
        extraction_messages("𠮷" * 20000)
        for text in ["", "  ", "字" * 20001, "正文\x00"]:
            with self.assertRaises(ValueError): extraction_messages(text)

    def test_only_verbatim_examples_are_candidates_and_duplicates_are_removed(self):
        example = {"text": "真实原句。", "scene_tags": ["对话"], "pov": "第三人称", "pace": "低"}
        result = validate_extraction({"name": "克制", "rules": "少解释，多动作。", "examples": [example, example, {**example, "text": "模型改写句。"}]}, "片段：真实原句。", {"kind": "import", "label": "参考.txt"})
        self.assertEqual(len(result["candidate_examples"]), 1); self.assertEqual(len(result["warnings"]), 1)
        self.assertNotIn("examples", result); self.assertIn("selected_prose", extraction_messages("真实原句。")[1]["content"])

    def test_capabilities_and_structured_schema_are_available(self):
        response = TestClient(app).get("/api/capabilities"); self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["writing_style"]["version"], 1)
        self.assertIn("extract_style_card", response.json()["operations"])
        self.assertFalse(response.json()["persistence"]["projects"])
        self.assertIn("extract_style_card", SCHEMAS)


class WritingStyleComputeTests(unittest.IsolatedAsyncioTestCase):
    async def test_extract_uses_one_mocked_call_and_no_project_payload(self):
        data = {"source_text": "真实原句。", "source": {"kind": "import", "label": "参考.txt"}}
        raw = json.dumps({"name": "克制", "rules": "少解释，多动作。", "examples": []}, ensure_ascii=False)
        with patch("services.compute_service.request_text", new_callable=AsyncMock, return_value=raw) as call:
            result = await compute("extract_style_card", data, SYNTHETIC_CREDENTIALS, {})
        self.assertEqual(result["name"], "克制"); call.assert_awaited_once()
        self.assertEqual(call.call_args.kwargs["max_tokens"], 4000); self.assertEqual(call.call_args.kwargs["temperature"], .2)
        self.assertNotIn("SYNTHETIC_ONLY", str(result)); self.assertEqual(data.keys(), {"source_text", "source"})

    async def test_invalid_material_or_output_never_produces_a_card(self):
        with patch("services.compute_service.request_text", new_callable=AsyncMock) as call:
            with self.assertRaises(ComputeError): await compute("extract_style_card", {"source_text": "字" * 20001}, SYNTHETIC_CREDENTIALS, {})
            call.assert_not_awaited()
        with patch("services.compute_service.request_text", new_callable=AsyncMock, return_value='{"rules":"缺少名称和范例"}'):
            with self.assertRaises(ComputeError): await compute("extract_style_card", {"source_text": "正文", "source": {"kind": "manual", "label": "片段"}}, SYNTHETIC_CREDENTIALS, {})


if __name__ == "__main__": unittest.main()
