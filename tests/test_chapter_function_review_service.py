from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path

from project_context import create_workspace_book
from services.chapter_function_review_service import (
    create_no_reveal_compliance_review,
    evaluate_no_reveal_text,
    list_chapter_function_reviews,
)


def approved_task(**overrides):
    task = {
        "id": "task_chapter_001_aaaaaaaa",
        "chapter_number": 1,
        "revision": 1,
        "status": "approved",
        "canon_budget": "none",
    }
    task.update(overrides)
    return task


def approved_scene_plan(**overrides):
    plan = {
        "id": "scene_plan_chapter_001_bbbbbbbb",
        "project_id": "book_test",
        "chapter_number": 1,
        "revision": 1,
        "status": "approved",
        "scenes": [
            {
                "scene_no": 1,
                "forbidden_information": ["no archive", "no new canon"],
            }
        ],
    }
    plan.update(overrides)
    return plan


class ChapterFunctionReviewServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.books_root = Path(self.temp_dir.name) / "books"
        self.book = create_workspace_book("No Reveal Review Test", books_root=self.books_root)
        self.project_ref = f"book:{self.book.book_id}"

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_canon_budget_none_triggers_review_and_writes_json(self):
        result = create_no_reveal_compliance_review(
            self.project_ref,
            1,
            "They talk quietly and decide to rest.",
            "chapters/chapter_001.md",
            chapter_task=approved_task(),
            books_root=self.books_root,
        )

        self.assertTrue(result.ok, result.message)
        self.assertEqual(result.review["verdict"], "pass")
        review_dir = self.book.project_dir / "logs" / "chapter_function_reviews"
        self.assertEqual(len(list(review_dir.glob("*.json"))), 1)

    def test_no_trigger_does_not_write_review(self):
        result = create_no_reveal_compliance_review(
            self.project_ref,
            1,
            "They talk quietly.",
            "chapters/chapter_001.md",
            chapter_task=approved_task(canon_budget="normal"),
            books_root=self.books_root,
        )

        self.assertTrue(result.ok, result.message)
        self.assertEqual(result.review["verdict"], "not_applicable")
        review_dir = self.book.project_dir / "logs" / "chapter_function_reviews"
        self.assertFalse(review_dir.exists())

    def test_archive_reading_fails(self):
        review = evaluate_no_reveal_text("He opened the archive and read the attendance record.", approved_task())

        self.assertEqual(review["verdict"], "fail")
        self.assertIn("archive_or_records", review["categories"])

    def test_number_code_analysis_fails(self):
        review = evaluate_no_reveal_text("She decoded GA-197 and matched the serial code.", approved_task())

        self.assertEqual(review["verdict"], "fail")
        self.assertIn("number_or_code_analysis", review["categories"])

    def test_photo_note_evidence_fails(self):
        review = evaluate_no_reveal_text("He found a photo, a note, and new evidence in the drawer.", approved_task())

        self.assertEqual(review["verdict"], "fail")
        self.assertIn("photo_or_material_evidence", review["categories"])

    def test_organization_reveal_fails(self):
        review = evaluate_no_reveal_text("The letterhead revealed the Bureau name.", approved_task())

        self.assertEqual(review["verdict"], "fail")
        self.assertIn("organization_reveal", review["categories"])

    def test_new_hook_ending_fails(self):
        review = evaluate_no_reveal_text("They stopped at the door. Tomorrow I will tell you the truth.", approved_task())

        self.assertEqual(review["verdict"], "fail")
        self.assertIn("new_hook", review["categories"])

    def test_negated_material_actions_do_not_fail(self):
        review = evaluate_no_reveal_text("他没有打开档案。她不再看纸条。他们决定不解析编号。", approved_task())

        self.assertNotEqual(review["verdict"], "fail")

    def test_scene_plan_forbidden_information_records_source_rule(self):
        review = evaluate_no_reveal_text(
            "He opened the archive.",
            approved_task(canon_budget="normal"),
            scene_plan=approved_scene_plan(),
        )

        self.assertEqual(review["verdict"], "fail")
        self.assertTrue(
            any("Scene Plan forbidden_information" in item["source_rule"] for item in review["violations"])
        )

    def test_multiple_categories_score_five(self):
        review = evaluate_no_reveal_text(
            "He opened the archive, decoded GA-197, found a photo, and revealed the Bureau name.",
            approved_task(),
        )

        self.assertEqual(review["verdict"], "fail")
        self.assertEqual(review["score"], 5)

    def test_list_reviews_returns_latest_history(self):
        first = create_no_reveal_compliance_review(
            self.project_ref,
            1,
            "They talk quietly.",
            "chapters/chapter_001.md",
            chapter_task=approved_task(),
            books_root=self.books_root,
        )
        time.sleep(0.01)
        second = create_no_reveal_compliance_review(
            self.project_ref,
            1,
            "He opened the archive.",
            "chapters/chapter_001.md",
            chapter_task=approved_task(),
            books_root=self.books_root,
        )

        self.assertTrue(first.ok)
        self.assertTrue(second.ok)
        loaded = list_chapter_function_reviews(self.project_ref, 1, books_root=self.books_root)
        self.assertTrue(loaded.ok)
        self.assertEqual(len(loaded.history), 2)
        self.assertEqual(loaded.latest["id"], second.review["id"])


if __name__ == "__main__":
    unittest.main()
