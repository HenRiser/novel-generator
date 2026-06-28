from __future__ import annotations

import json
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


CHINESE_REAL_FAILURE_TEXT = (
    "归档2005年的考勤记录。在二楼档案室。\n"
    "三箱财务凭证的照片存在硬盘里。编号。日期。封条状态。\n"
    "2005年1月。考勤统计表。抬头印着“时空管理局第七观察处”。\n"
    "明天我要告诉你一件事。\n"
    "关于两个父亲为什么会同时出现在同一个档案里。"
)

CHINESE_FAILURE_CATEGORIES = {
    "archive_or_records",
    "number_or_code_analysis",
    "photo_or_material_evidence",
    "organization_reveal",
    "new_hook",
}


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

    def test_chinese_real_failure_regression_scores_five(self):
        review = evaluate_no_reveal_text(CHINESE_REAL_FAILURE_TEXT, approved_task())

        self.assertEqual(review["verdict"], "fail")
        self.assertEqual(review["score"], 5)
        self.assertTrue(CHINESE_FAILURE_CATEGORIES.issubset(set(review["categories"])))
        self.assertTrue(review["violations"])
        evidences = [str(item.get("evidence", "")) for item in review["violations"]]
        self.assertTrue(any("考勤记录" in evidence or "档案室" in evidence for evidence in evidences))
        self.assertTrue(any("时空管理局" in evidence or "第七观察处" in evidence for evidence in evidences))
        self.assertTrue(any("明天我要告诉你" in evidence for evidence in evidences))

    def test_chinese_archive_record_positive_matches_category(self):
        review = evaluate_no_reveal_text("打开档案读取考勤记录。", approved_task())

        self.assertEqual(review["verdict"], "fail")
        self.assertIn("archive_or_records", review["categories"])

    def test_chinese_number_code_positive_matches_category(self):
        review = evaluate_no_reveal_text("解析编号。", approved_task())

        self.assertEqual(review["verdict"], "fail")
        self.assertIn("number_or_code_analysis", review["categories"])

    def test_chinese_photo_note_evidence_positive_matches_category(self):
        review = evaluate_no_reveal_text("发现照片纸条和新证据。", approved_task())

        self.assertEqual(review["verdict"], "fail")
        self.assertIn("photo_or_material_evidence", review["categories"])

    def test_chinese_organization_positive_matches_category(self):
        review = evaluate_no_reveal_text("抬头印着时空管理局第七观察处。", approved_task())

        self.assertEqual(review["verdict"], "fail")
        self.assertIn("organization_reveal", review["categories"])

    def test_chinese_new_hook_positive_matches_category(self):
        review = evaluate_no_reveal_text("明天我要告诉你一件事，关于真相。", approved_task())

        self.assertEqual(review["verdict"], "fail")
        self.assertIn("new_hook", review["categories"])

    def test_chinese_negated_material_actions_do_not_fail(self):
        review = evaluate_no_reveal_text(
            "他没有打开档案。\n她不再看纸条。\n他们决定不解析编号。\n今晚暂不处理材料。",
            approved_task(),
        )

        self.assertNotEqual(review["verdict"], "fail")

    def test_chinese_real_failure_create_review_persists_fail(self):
        result = create_no_reveal_compliance_review(
            self.project_ref,
            1,
            CHINESE_REAL_FAILURE_TEXT,
            "chapters/chapter_001.md",
            chapter_task=approved_task(id="task_chapter_001_gate_smoke"),
            books_root=self.books_root,
        )

        self.assertTrue(result.ok, result.message)
        self.assertEqual(result.review["verdict"], "fail")
        self.assertEqual(result.review["score"], 5)
        self.assertTrue(CHINESE_FAILURE_CATEGORIES.issubset(set(result.review["categories"])))

        review_dir = self.book.project_dir / "logs" / "chapter_function_reviews"
        files = list(review_dir.glob("*.json"))
        self.assertEqual(len(files), 1)
        stored = json.loads(files[0].read_text(encoding="utf-8"))
        self.assertEqual(stored["verdict"], "fail")
        self.assertEqual(stored["score"], 5)
        self.assertTrue(CHINESE_FAILURE_CATEGORIES.issubset(set(stored["categories"])))

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
