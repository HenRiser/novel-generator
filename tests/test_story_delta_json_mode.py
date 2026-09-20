from __future__ import annotations

import copy
import json
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from project_context import create_workspace_book
from services import story_delta_service as delta
from services.prompt_profile_service import get_prompt_profile


def valid_payload():
    return {
        "story_delta": copy.deepcopy(delta.DEFAULT_STORY_DELTA),
        "next_chapter_proposal": {
            **copy.deepcopy(delta.DEFAULT_NEXT_CHAPTER_PROPOSAL),
            "target_chapter_number": 2,
            "suggested_goal": "Keep True, False and None as words, not JSON literals.",
        },
        "candidate_changes": [{
            "id": "change_1", "operation": "create_node", "target": "narrative_graph",
            "source": "story_delta", "requires_review": True, "confidence": 0.5,
            "evidence": "The door closed.",
            "payload": {
                "type": "event", "label": "Closed door", "summary": "The door closed.",
                "status": "confirmed", "importance": 4, "layer": "detail",
            },
        }],
        "warnings": [],
    }


class StoryDeltaJsonValidationTests(unittest.TestCase):
    def test_valid_json_and_fenced_json_are_not_rewritten(self):
        payload = valid_payload()
        payload["warnings"] = ['True, False, None and a comma before a brace: ,} stay literal.']
        text = json.dumps(payload)
        for raw in (text, f"```json\n{text}\n```", f"Result:\n{text}"):
            with self.subTest(raw=raw[:12]):
                result = delta._parse_story_delta_json(raw, validate_structure=True)
                self.assertEqual(result.data, payload)
                self.assertEqual(result.error, "")

    def test_wrong_field_types_are_rejected_instead_of_defaulted(self):
        cases = [
            (("story_delta",), "not an object"),
            (("story_delta", "new_events"), {}),
            (("story_delta", "new_events"), ["not an object"]),
            (("story_delta", "new_events"), [{"summary": {"not": "text"}}]),
            (("story_delta", "relationship_updates"), [{"characters": [123]}]),
            (("next_chapter_proposal",), []),
            (("next_chapter_proposal", "suggested_goal"), {"not": "text"}),
            (("next_chapter_proposal", "target_chapter_number"), True),
            (("next_chapter_proposal", "target_chapter_number"), 0),
            (("next_chapter_proposal", "suggested_new_nodes"), [None]),
            (("next_chapter_proposal", "suggested_scenes"), ["not an object"]),
            (("next_chapter_proposal", "risks"), [{}]),
            (("candidate_changes",), {}),
            (("candidate_changes",), [None]),
            (("candidate_changes", 0, "payload"), []),
            (("candidate_changes", 0, "payload", "label"), []),
            (("candidate_changes", 0, "payload", "importance"), True),
            (("candidate_changes", 0, "confidence"), "high"),
            (("candidate_changes", 0, "requires_review"), "true"),
            (("warnings",), "not an array"),
            (("warnings",), [None]),
        ]
        for path, wrong in cases:
            with self.subTest(path=path, wrong=wrong):
                payload = valid_payload()
                target = payload
                for key in path[:-1]:
                    target = target[key]
                target[path[-1]] = wrong
                result = delta._parse_story_delta_json(json.dumps(payload), validate_structure=True)
                self.assertIsNone(result.data)
                self.assertIn("structure invalid", result.error)
                self.assertIn(str(path[0]), result.error)

    def test_missing_fields_and_wrong_top_level_are_not_successful_empty_results(self):
        for value in ({}, [], 1, None, {"story_delta": {}}):
            with self.subTest(value=value):
                result = delta._parse_story_delta_json(json.dumps(value), validate_structure=True)
                self.assertIsNone(result.data)
                self.assertTrue(result.error)

    def test_legacy_parse_and_normalization_remain_permissive(self):
        parsed, error = delta.parse_story_delta_response('{"story_delta": {}}')
        self.assertEqual(error, "")
        normalized, _, changes, warnings = delta.normalize_story_delta(parsed, 1, True)
        self.assertEqual(normalized, delta.DEFAULT_STORY_DELTA)
        self.assertEqual((changes, warnings), ([], []))


class StoryDeltaJsonModeTests(unittest.TestCase):
    def setUp(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        directory = stack.enter_context(tempfile.TemporaryDirectory())
        self.book = create_workspace_book("JSON Test", books_root=Path(directory) / "books")
        self.ref = f"book:{self.book.book_id}"
        stack.enter_context(patch("deepseek_client.OpenAI", side_effect=AssertionError("Real API forbidden")))
        fixtures = {
            "_workspace_context": (self.book, ""),
            "load_project_detail": SimpleNamespace(ok=True, config={"title": "JSON Test", "model": "mock-model"}),
            "read_chapter_for_display": SimpleNamespace(ok=True, content="# Chapter 1\nThe door closed.", filename="chapter_001.md"),
            "read_latest_outline": (None, None),
            "read_latest_characters": (None, None),
            "_graph_summary": "No existing graph.",
            "create_ai_run_record_best_effort": SimpleNamespace(ok=False),
            "append_event_best_effort": None,
        }
        self.mocks = {name: stack.enter_context(patch.object(delta, name, return_value=value)) for name, value in fixtures.items()}
        self.generate = stack.enter_context(patch.object(delta, "generate_text", return_value=json.dumps(valid_payload())))

    def analyze(self, **request):
        return delta.analyze_chapter_delta(self.ref, 1, request)

    def assert_no_success_files(self):
        self.assertFalse(delta._story_deltas_path(self.book).exists())
        self.assertFalse(delta._knowledge_drafts_path(self.book).exists())
        self.mocks["create_ai_run_record_best_effort"].assert_not_called()
        self.mocks["append_event_best_effort"].assert_not_called()

    def test_analysis_requests_json_mode_and_saves_reviewable_result(self):
        result = self.analyze()
        self.assertTrue(result.ok, result.message)
        self.generate.assert_called_once()
        self.assertIs(self.generate.call_args.kwargs["json_mode"], True)
        self.assertIn("JSON", self.generate.call_args.kwargs["messages"][0]["content"])
        self.assertEqual(result.next_chapter_proposal["suggested_goal"], valid_payload()["next_chapter_proposal"]["suggested_goal"])
        self.assertEqual(result.knowledge_draft["status"], "pending_review")
        self.assertTrue(delta._story_deltas_path(self.book).is_file())
        self.assertTrue(delta._knowledge_drafts_path(self.book).is_file())
        self.assertEqual(get_prompt_profile("story_delta_analysis")["template_version"], "v2")

    def test_syntax_repair_uses_json_mode_once_and_can_succeed(self):
        self.generate.side_effect = ['{"story_delta":', json.dumps(valid_payload())]
        result = self.analyze()
        self.assertTrue(result.ok, result.message)
        self.assertTrue(result.metadata["repair_used"])
        self.assertEqual(self.generate.call_count, 2)
        self.assertTrue(all(call.kwargs["json_mode"] for call in self.generate.call_args_list))

    def test_structural_error_can_be_repaired_but_never_normalized_silently(self):
        invalid = valid_payload()
        invalid["next_chapter_proposal"]["suggested_goal"] = {}
        self.generate.side_effect = [json.dumps(invalid), json.dumps(valid_payload())]
        result = self.analyze()
        self.assertTrue(result.ok, result.message)
        self.assertEqual(self.generate.call_count, 2)
        self.assertTrue(result.metadata["repair_used"])
        repair_prompt = self.generate.call_args_list[1].kwargs["messages"][1]["content"]
        self.assertIn("next_chapter_proposal.suggested_goal must be str", repair_prompt)
        self.assertIn('"target_chapter_number": 2', repair_prompt)
        self.assertIn('"relationship_updates": []', repair_prompt)
        self.assertIn("arrays contain objects", repair_prompt)

    def test_invalid_repair_structure_is_rejected_without_success_files(self):
        invalid = valid_payload()
        invalid["candidate_changes"][0]["payload"] = []
        self.generate.side_effect = ['{"story_delta":', json.dumps(invalid)]
        result = self.analyze()
        self.assertFalse(result.ok)
        self.assertEqual(self.generate.call_count, 2)
        self.assertIn("candidate_changes[0].payload must be dict", result.message)
        self.assertEqual(result.metadata["parse_status"], "failed")
        self.assert_no_success_files()

    def test_repeated_invalid_shape_stops_after_one_repair(self):
        invalid = valid_payload()
        invalid["story_delta"] = "wrong type"
        self.generate.return_value = json.dumps(invalid)
        result = self.analyze()
        self.assertFalse(result.ok)
        self.assertEqual(self.generate.call_count, 2)
        self.assertIn("story_delta must be dict", result.message)
        self.assert_no_success_files()

    def test_repeated_invalid_syntax_stops_after_one_repair(self):
        self.generate.return_value = '{"story_delta":'
        result = self.analyze()
        self.assertFalse(result.ok)
        self.assertEqual(self.generate.call_count, 2)
        self.assert_no_success_files()

    def test_repair_request_failure_does_not_save_default_results(self):
        self.generate.side_effect = ['{"story_delta":', delta.DeepSeekClientError("mock repair unavailable")]
        result = self.analyze()
        self.assertFalse(result.ok)
        self.assertEqual(self.generate.call_count, 2)
        self.assertIn("repair request failed", result.message)
        self.assert_no_success_files()

    def test_dry_run_never_calls_model_or_requires_model_schema(self):
        result = self.analyze(dry_run=True)
        self.assertTrue(result.ok, result.message)
        self.generate.assert_not_called()
        self.assertIn("Dry-run mode used. No DeepSeek call was made.", result.warnings)

    def test_local_mock_and_history_paths_remain_compatible(self):
        result = self.analyze(mock_response={"story_delta": {}}, include_knowledge_draft=False)
        self.assertTrue(result.ok, result.message)
        self.generate.assert_not_called()
        listed = delta.list_story_deltas(self.ref)
        self.assertTrue(listed.ok, listed.message)
        self.assertEqual(len(listed.items), 1)


if __name__ == "__main__":
    unittest.main()
