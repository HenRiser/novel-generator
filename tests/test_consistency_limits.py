from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from api.main import app
from services import consistency_check_service as checks
from services.work_limits import WorkloadLimitError


def context(items):
    return checks.HARD_SECTION_TITLE + "\n" + "\n".join("- " + item for item in items)


class ConsistencyLimitTests(unittest.TestCase):
    def test_constraint_count_is_bounded_before_scanning_the_chapter(self):
        self.assertEqual(checks.check_generated_chapter_consistency("正文", context(["约束"] * 128)), [])
        with patch.object(checks, "_check_constraint", side_effect=AssertionError("scanned before rejection")):
            with self.assertRaises(WorkloadLimitError):
                checks.check_generated_chapter_consistency("正文", context(["约束"] * 129))

    def test_character_work_budget_accepts_boundary_and_rejects_next_unit(self):
        rules = context(["约束"] * 100)
        self.assertEqual(checks.check_generated_chapter_consistency("a" * 40000, rules), [])
        with patch.object(checks, "_check_constraint", side_effect=AssertionError("scanned before rejection")):
            with self.assertRaises(WorkloadLimitError):
                checks.check_generated_chapter_consistency("a" * 40001, rules)

    def test_chapter_dates_are_parsed_once_and_conflicts_still_reported(self):
        chapter = "张三于2002年出生。李四于2004年出生。"
        rules = context(["张三于2001年出生。", "李四于2003年出生。"])
        with patch.object(checks, "_date_mentions_with_context", wraps=checks._date_mentions_with_context) as parse:
            warnings = checks.check_generated_chapter_consistency(chapter, rules)
        self.assertEqual(sum(call.args[0] == chapter for call in parse.call_args_list), 1)
        self.assertEqual({warning["code"] for warning in warnings}, {"possible_date_conflict"})
        self.assertEqual(len(warnings), 2)

    def test_single_constraint_has_a_chapter_length_limit(self):
        rules = context(["约束"])
        self.assertEqual(checks.check_generated_chapter_consistency("a" * 100000, rules), [])
        with self.assertRaises(WorkloadLimitError):
            checks.check_generated_chapter_consistency("a" * 100001, rules)

    def test_dense_matching_dates_have_a_pair_budget(self):
        # Identical dates never generate warnings, so MAX_WARNINGS cannot bound this work.
        rule = "2001年出生 " * 10
        self.assertEqual(checks.check_generated_chapter_consistency("2001年出生 " * 1000, context([rule] * 10)), [])
        with self.assertRaises(WorkloadLimitError):
            checks.check_generated_chapter_consistency("2001年出生 " * 1001, context([rule] * 10))

    def test_public_summary_rejects_original_attack_before_model_call(self):
        payload = {
            "run_id": "limit", "step_id": "limit", "attempt_id": "limit", "input_revision": 0,
            "credentials": {"api_key": "sk-" + "a" * 32},
            "input": {"chapter_number": 1, "chapter": {"content": "a" * 400000},
                      "frozen_context": {"narrative_context_text": context(["张三于2001年出生"] * 1000)},
                      "review_scope": "rules_only"},
        }
        with TestClient(app) as client, patch("services.compute_service.request_text", new_callable=AsyncMock) as model:
            response = client.post("/api/compute/summarize_chapter", json=payload)
        self.assertEqual(response.status_code, 413, response.text)
        self.assertEqual(response.json()["error"]["code"], "workload_too_large")
        model.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
