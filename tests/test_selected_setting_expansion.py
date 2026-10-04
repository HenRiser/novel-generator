from __future__ import annotations

import copy
import json
import unittest
from unittest.mock import AsyncMock, patch

import model_client
from provider_catalog import default_policy, normalize_connection
from services import compute_service
from structured_schemas import SCHEMAS


class SelectedSettingExpansionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.data = {
            "config": {
                "raw_story_idea": "原始故事设想",
                "protagonist": "已保存主角",
                "supporting_characters": "已保存配角",
                "worldview": "已保存世界观",
                "core_conflict": "已保存冲突",
                "genre": "科幻",
                "style": "简洁",
                "word_count_range": "3000-5000 字",
            },
            "request": {
                "raw_story_idea": "修钟青年收到未来来信。",
                "selected_fields": ["worldview"],
                "draft": {"protagonist": "未保存主角", "genre": "悬疑"},
            },
        }
        self.credentials = self.connection_credentials("chat_completions")

    @staticmethod
    def connection_credentials(protocol):
        connection = normalize_connection({
            "profile_id": "synthetic-test",
            "revision": 1,
            "preset": "custom",
            "protocol": protocol,
            "base_url": "https://provider.example/v1",
            "model": "synthetic-model",
            "auth_mode": "none",
            "policy": {**default_policy("custom"), "structured": "json_schema"},
        })
        return {"_connection": connection, "api_key": ""}

    async def test_worldview_only_uses_unsaved_draft_as_context_without_mutating_input(self):
        before = copy.deepcopy(self.data)
        with patch.object(compute_service, "request_text", AsyncMock(return_value='{"world_setting":"  新世界规则  "}')) as model:
            result = await compute_service.compute("expand_setting", self.data, self.credentials, {})
        self.assertEqual(result, {"expanded_data": {"world_setting": "新世界规则"}})
        model.assert_awaited_once()
        messages = model.await_args.args[1]
        prompt = json.loads(messages[1]["content"])
        self.assertEqual(prompt["白话故事设想"], "修钟青年收到未来来信。")
        self.assertEqual(prompt["输出字段"], ["world_setting"])
        self.assertEqual(prompt["选择生成"], ["世界观"])
        self.assertEqual(prompt["已有设定参考"]["主角"], "未保存主角")
        self.assertEqual(prompt["已有设定参考"]["配角"], "已保存配角")
        self.assertEqual(prompt["已有设定参考"]["genre"], "悬疑")
        self.assertTrue(model.await_args.kwargs["json_mode"])
        self.assertEqual(self.data, before)

    async def test_multiple_selected_fields_return_only_selected_results(self):
        self.data["request"]["selected_fields"] = ["supporting_characters", "protagonist", "core_conflict"]
        output = {
            "supporting_characters_setting": "新配角",
            "protagonist_setting": "新主角",
            "core_conflict": "新冲突",
        }
        with patch.object(compute_service, "request_text", AsyncMock(return_value=json.dumps(output))) as model:
            result = await compute_service.compute("expand_setting", self.data, self.credentials, {})
        self.assertEqual(result["expanded_data"], output)
        prompt = json.loads(model.await_args.args[1][1]["content"])
        self.assertEqual(prompt["输出字段"], list(output))

    async def test_empty_unknown_duplicate_or_wrong_type_selection_never_calls_model(self):
        invalid = [[], ["title"], ["worldview", "unknown"], ["worldview", "worldview"], [None], [1], "worldview", {}, None]
        for selected in invalid:
            with self.subTest(selected=selected):
                self.data["request"]["selected_fields"] = selected
                with patch.object(compute_service, "request_text", AsyncMock()) as model:
                    with self.assertRaises(compute_service.ComputeError):
                        await compute_service.compute("expand_setting", self.data, self.credentials, {})
                    model.assert_not_awaited()

    async def test_missing_blank_or_wrong_type_story_idea_never_calls_model(self):
        cases = [{"raw_story_idea": ""}, {"raw_story_idea": "   "}, {"raw_story_idea": None}, {"raw_story_idea": 42}, {"raw_story_idea": []}, {}]
        for request in cases:
            with self.subTest(request=request):
                data = copy.deepcopy(self.data)
                data["config"] = {}
                data["request"] = {"selected_fields": ["worldview"], **request}
                with patch.object(compute_service, "request_text", AsyncMock()) as model:
                    with self.assertRaises(compute_service.ComputeError):
                        await compute_service.compute("expand_setting", data, self.credentials, {})
                    model.assert_not_awaited()

    async def test_explicit_blank_story_idea_does_not_fall_back_to_saved_story(self):
        self.data["request"]["raw_story_idea"] = "  "
        with patch.object(compute_service, "request_text", AsyncMock()) as model:
            with self.assertRaisesRegex(compute_service.ComputeError, "白话故事设想"):
                await compute_service.compute("expand_setting", self.data, self.credentials, {})
            model.assert_not_awaited()

    async def test_omitted_story_idea_uses_saved_raw_idea_or_seed(self):
        for config in [{"raw_story_idea": "已保存白话"}, {"seed_prompt": "初始故事起点"}]:
            with self.subTest(config=config):
                data = {"config": config, "request": {"selected_fields": ["worldview"]}}
                with patch.object(compute_service, "request_text", AsyncMock(return_value='{"world_setting":"世界规则"}')) as model:
                    await compute_service.compute("expand_setting", data, self.credentials, {})
                prompt = json.loads(model.await_args.args[1][1]["content"])
                self.assertEqual(prompt["白话故事设想"], next(iter(config.values())))

    async def test_invalid_draft_never_calls_model(self):
        invalid = [None, [], "draft", 1, {"title": "不能写入的字段"}, {"model": "不能写入模型"}, {"protagonist": None}, {"worldview": 1}, {"genre": ["科幻"]}]
        for draft in invalid:
            with self.subTest(draft=draft):
                self.data["request"]["draft"] = draft
                before = copy.deepcopy(self.data)
                with patch.object(compute_service, "request_text", AsyncMock()) as model:
                    with self.assertRaises(compute_service.ComputeError):
                        await compute_service.compute("expand_setting", self.data, self.credentials, {})
                    model.assert_not_awaited()
                self.assertEqual(self.data, before)

    async def test_missing_empty_or_wrong_type_selected_results_are_rejected(self):
        self.data["request"]["selected_fields"] = ["protagonist", "worldview"]
        invalid = [
            {"protagonist_setting": "仅有主角"},
            {"protagonist_setting": "主角", "world_setting": ""},
            {"protagonist_setting": "主角", "world_setting": " \n "},
            {"protagonist_setting": "主角", "world_setting": None},
            {"protagonist_setting": "主角", "world_setting": 42},
            {"protagonist_setting": "主角", "world_setting": ["世界"]},
            {"protagonist_setting": {}, "world_setting": "世界"},
        ]
        for output in invalid:
            with self.subTest(output=output):
                before = copy.deepcopy(self.data)
                with patch.object(compute_service, "request_text", AsyncMock(return_value=json.dumps(output))) as model:
                    with self.assertRaisesRegex(compute_service.ComputeError, "字段不完整"):
                        await compute_service.compute("expand_setting", self.data, self.credentials, {})
                    model.assert_awaited_once()
                self.assertEqual(self.data, before)

    async def test_unselected_extra_model_fields_are_ignored(self):
        output = {
            "world_setting": "新世界观",
            "protagonist_setting": "不能覆盖主角",
            "supporting_characters_setting": "不能覆盖配角",
            "core_conflict": "不能覆盖冲突",
            "recommended_title": "不能修改标题",
            "unexpected": {"ignored": True},
        }
        with patch.object(compute_service, "request_text", AsyncMock(return_value=json.dumps(output))):
            result = await compute_service.compute("expand_setting", self.data, self.credentials, {})
        self.assertEqual(result, {"expanded_data": {"world_setting": "新世界观"}})

    async def test_malformed_model_json_does_not_succeed(self):
        for raw in ["", "not JSON", "{", "{\"world_setting\":}"]:
            with self.subTest(raw=raw):
                with patch.object(compute_service, "request_text", AsyncMock(return_value=raw)):
                    with self.assertRaises(ValueError):
                        await compute_service.compute("expand_setting", self.data, self.credentials, {})

    async def test_native_schema_contains_only_selected_keys_for_both_protocols(self):
        static_schema = copy.deepcopy(SCHEMAS["expand_setting"])
        for protocol in ("chat_completions", "messages"):
            for selected, output in [(["worldview"], {"world_setting": "世界"}), (["protagonist", "core_conflict"], {"protagonist_setting": "主角", "core_conflict": "冲突"})]:
                with self.subTest(protocol=protocol, selected=selected):
                    credentials = self.connection_credentials(protocol)
                    provider = compute_service.provider_config(credentials, "expand_setting")
                    before = copy.deepcopy(provider.connection)
                    self.data["request"]["selected_fields"] = selected
                    with patch.object(compute_service, "provider_config", return_value=provider), patch.object(compute_service, "request_text", AsyncMock(return_value=json.dumps(output))) as model:
                        await compute_service.compute("expand_setting", self.data, credentials, {})
                    effective, messages = model.await_args.args
                    body = model_client._body(effective, messages, 0.7, 4000, True, False)
                    schema = body["output_config"]["format"]["schema"] if protocol == "messages" else body["response_format"]["json_schema"]["schema"]
                    self.assertEqual(set(schema["properties"]), set(output))
                    self.assertEqual(schema["required"], list(output))
                    self.assertFalse(schema["additionalProperties"])
                    self.assertTrue(all(value == {"type": "string"} for value in schema["properties"].values()))
                    self.assertIsNot(effective, provider)
                    self.assertIsNone(provider.response_schema)
                    self.assertEqual(provider.connection, before)
                    self.assertEqual(SCHEMAS["expand_setting"], static_schema)

    async def test_legacy_request_without_selection_keeps_full_response_contract(self):
        output = {
            "title_candidates": ["未来来信"],
            "recommended_title": "未来来信",
            "protagonist_setting": "主角",
            "supporting_characters_setting": "配角",
            "world_setting": "世界观",
            "core_conflict": "冲突",
        }
        del self.data["request"]["selected_fields"]
        with patch.object(compute_service, "request_text", AsyncMock(return_value=json.dumps(output))) as model:
            result = await compute_service.compute("expand_setting", self.data, self.credentials, {})
        self.assertEqual(result, {"expanded_data": output})
        self.assertIsNone(model.await_args.args[0].response_schema)
        for field in output:
            incomplete = {key: value for key, value in output.items() if key != field}
            with self.subTest(missing=field), patch.object(compute_service, "request_text", AsyncMock(return_value=json.dumps(incomplete))):
                with self.assertRaises(ValueError):
                    await compute_service.compute("expand_setting", self.data, self.credentials, {})


if __name__ == "__main__":
    unittest.main()
