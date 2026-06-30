from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from project_context import LEGACY_STORAGE_KIND, create_workspace_book
from services.chapter_status_service import get_chapter_status, list_chapter_statuses


class ChapterStatusFunctionReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.books_root = Path(self.temp_dir.name) / "books"
        self.book = create_workspace_book("Chapter Status Function Review Test", books_root=self.books_root)
        self.project_ref = f"book:{self.book.book_id}"
        self.patchers = [
            patch("services.chapter_status_service.resolve_project_context", side_effect=self._resolve_project_context),
            patch("services.chapter_status_service.list_events", return_value=SimpleNamespace(ok=True, events=[])),
            patch("services.chapter_status_service.list_ai_runs", return_value=SimpleNamespace(ok=True, runs=[])),
        ]
        for patcher in self.patchers:
            patcher.start()

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temp_dir.cleanup()

    def _resolve_project_context(self, project_ref: str, **_kwargs):
        if project_ref == self.project_ref:
            return self.book
        if project_ref == "legacy-project":
            return SimpleNamespace(storage_kind=LEGACY_STORAGE_KIND)
        raise FileNotFoundError("Project not found.")

    def _write_review(
        self,
        *,
        review_id: str,
        chapter_number: int = 1,
        verdict: str,
        score: int,
        created_at: str,
        categories: list[str] | None = None,
        ai_run_id: str = "run_status_test",
    ) -> None:
        root = self.book.logs_dir / "chapter_function_reviews"
        root.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "id": review_id,
            "type": "no_reveal_compliance",
            "project_id": self.book.book_id,
            "chapter_number": chapter_number,
            "ai_run_id": ai_run_id,
            "verdict": verdict,
            "score": score,
            "categories": categories or [],
            "violations": [],
            "summary": f"{verdict} summary",
            "created_at": created_at,
        }
        (root / f"{review_id}.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def test_no_review_returns_null_latest_function_review(self):
        result = get_chapter_status(self.project_ref, 1)

        self.assertTrue(result.ok, result.message)
        self.assertIsNone(result.chapter_status["latest_function_review"])

    def test_pass_review_returns_summary(self):
        self._write_review(
            review_id="review_pass",
            verdict="pass",
            score=0,
            categories=[],
            created_at="2026-06-28T10:00:00+08:00",
            ai_run_id="run_pass",
        )

        result = get_chapter_status(self.project_ref, 1)

        self.assertTrue(result.ok, result.message)
        latest = result.chapter_status["latest_function_review"]
        self.assertEqual(latest["id"], "review_pass")
        self.assertEqual(latest["verdict"], "pass")
        self.assertEqual(latest["score"], 0)
        self.assertEqual(latest["ai_run_id"], "run_pass")

    def test_warn_review_adds_review_next_action(self):
        self._write_review(
            review_id="review_warn",
            verdict="warn",
            score=2,
            categories=["archive_or_records"],
            created_at="2026-06-28T10:00:00+08:00",
        )

        result = get_chapter_status(self.project_ref, 1)

        self.assertTrue(result.ok, result.message)
        self.assertEqual(result.chapter_status["latest_function_review"]["verdict"], "warn")
        self.assertTrue(
            any("No-Reveal 风险" in action and "复核" in action for action in result.chapter_status["next_actions"])
        )

    def test_fail_review_prioritizes_manual_review_next_actions(self):
        self._write_review(
            review_id="review_fail",
            verdict="fail",
            score=5,
            categories=["archive_or_records", "new_hook"],
            created_at="2026-06-28T10:00:00+08:00",
        )

        result = get_chapter_status(self.project_ref, 1)

        self.assertTrue(result.ok, result.message)
        actions = result.chapter_status["next_actions"]
        self.assertIn("No-Reveal 审核失败", actions[0])
        self.assertIn("不建议直接进入下一章", actions[1])
        self.assertIn("不建议将本章作为可信上下文继续推进", actions[2])

    def test_multiple_reviews_use_latest_created_at(self):
        self._write_review(
            review_id="review_old_fail",
            verdict="fail",
            score=5,
            categories=["archive_or_records"],
            created_at="2026-06-28T10:00:00+08:00",
        )
        self._write_review(
            review_id="review_new_pass",
            verdict="pass",
            score=0,
            categories=[],
            created_at="2026-06-28T11:00:00+08:00",
        )

        result = get_chapter_status(self.project_ref, 1)

        self.assertTrue(result.ok, result.message)
        latest = result.chapter_status["latest_function_review"]
        self.assertEqual(latest["id"], "review_new_pass")
        self.assertEqual(latest["verdict"], "pass")

    def test_status_overview_includes_review_only_chapter_and_failed_count(self):
        self._write_review(
            review_id="review_chapter_two_fail",
            chapter_number=2,
            verdict="fail",
            score=5,
            categories=["new_hook"],
            created_at="2026-06-28T10:00:00+08:00",
        )

        result = list_chapter_statuses(self.project_ref)

        self.assertTrue(result.ok, result.message)
        self.assertIn(2, {chapter["chapter_number"] for chapter in result.chapters})
        self.assertEqual(result.summary["chapters_with_failed_function_review"], 1)

    def test_legacy_project_behavior_remains_unsupported(self):
        result = get_chapter_status("legacy-project", 1)

        self.assertFalse(result.ok)
        self.assertEqual(result.error_code, "chapter_status_unsupported_project")


if __name__ == "__main__":
    unittest.main()
