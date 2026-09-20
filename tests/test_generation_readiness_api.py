from __future__ import annotations

import json
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from api.generation_state import complete_generation_task, get_generation_status, start_generation_task
from api.main import app
from file_manager import save_chapter
from project_context import create_workspace_book
from services.chapter_workflow_service import (
    confirm_chapter, get_chapter_workflow, register_generated_chapter, run_confirmed_chapter_tasks,
)


class GenerationReadinessApiTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.book = create_workspace_book("Readiness", books_root=Path(temporary.name) / "books")
        self.project_ref = f"book:{self.book.book_id}"
        patches = ExitStack()
        self.addCleanup(patches.close)
        for module in ("file_manager", "services.chapter_workflow_service"):
            patches.enter_context(patch(f"{module}.resolve_project_context", return_value=self.book))
        patches.enter_context(patch("api.routers.chapter_workflow._load_project_config_or_error", return_value={"title": "Readiness"}))
        for name in ("_ensure_outline_character_ready", "_ensure_chapter_assets_ready", "_ensure_model_configured"):
            patches.enter_context(patch(f"api.routers.chapter_workflow.{name}"))
        patches.enter_context(patch("services.chapter_workflow_service.generate_text", side_effect=AssertionError("Unexpected model call")))
        complete_generation_task()
        self.addCleanup(complete_generation_task)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def readiness(self, number):
        return self.client.get(f"/api/projects/{self.project_ref}/chapters/{number}/generation-readiness")

    def seed(self, number=1, ready=False):
        text = f"# 第 {number} 章\n\n正文。"
        path = save_chapter(self.project_ref, number, text)
        return register_generated_chapter(self.project_ref, number, path, text, "test", confirmed=ready, summary="摘要。" if ready else "")

    def metadata(self):
        return {str(path.relative_to(self.book.project_dir)): path.read_bytes() for path in self.book.logs_dir.rglob("*.json")}

    def test_empty_and_legacy_chapters_are_ready_without_creating_metadata(self):
        self.assertTrue(self.readiness(1).json()["ready"])
        save_chapter(self.project_ref, 1, "# 历史正文\n正文。")
        before = self.metadata()
        result = self.readiness(2).json()
        self.assertTrue(result["ready"])
        self.assertEqual(result["blockers"], [])
        self.assertEqual(before, self.metadata())
        self.assertFalse(get_generation_status()["running"])

    def test_checks_all_prior_chapters_including_gaps_without_locking(self):
        self.seed(1, ready=True)
        self.seed(3)
        before = self.metadata()
        result = self.readiness(5).json()
        self.assertFalse(result["ready"])
        self.assertEqual(result["blockers"], [{"code": "previous_chapter_unconfirmed", "message": "第 3 章正文待确认，确认后才能继续生成。", "action": "confirm_chapter", "chapter_number": 3}])
        self.assertEqual(before, self.metadata())
        self.assertTrue(result["can_generate_assets"])

    def test_pending_summary_becomes_ready_after_background_completion(self):
        original = self.seed()
        confirmed = confirm_chapter(self.project_ref, 1, original["content"], original["revision"])
        before = self.metadata()
        result = self.readiness(2).json()
        self.assertEqual(result["blockers"][0]["action"], "wait")
        self.assertEqual(before, self.metadata())
        with patch("services.chapter_workflow_service.generate_text", return_value="后台摘要。"):
            run_confirmed_chapter_tasks(self.project_ref, 1, confirmed["revision"])
        self.assertTrue(self.readiness(2).json()["ready"])
        self.assertIsNone(get_chapter_workflow(self.project_ref, 1)["locked_by_chapter"])

    def test_failed_summary_offers_retry_on_existing_chapter(self):
        original = self.seed()
        confirmed = confirm_chapter(self.project_ref, 1, original["content"], original["revision"])
        with patch("services.chapter_workflow_service.generate_text", side_effect=RuntimeError("Mock failure")):
            run_confirmed_chapter_tasks(self.project_ref, 1, confirmed["revision"])
        blocker = self.readiness(2).json()["blockers"][0]
        self.assertEqual((blocker["code"], blocker["action"], blocker["chapter_number"]), ("previous_summary_failed", "retry_summary", 1))

    def test_interrupted_summary_is_retryable_without_mutating_record(self):
        self.seed(ready=True)
        path = self.book.logs_dir / "chapter_workflow" / "chapter_001.json"
        state = json.loads(path.read_text(encoding="utf-8"))
        state.update(summary_status="running", job_id="no-worker-holds-this-reservation")
        path.write_text(json.dumps(state), encoding="utf-8")
        before = self.metadata()
        result = self.readiness(2).json()
        self.assertEqual(result["blockers"][0]["action"], "retry_summary")
        self.assertEqual(before, self.metadata())

    def test_target_with_later_chapter_is_locked_without_persisting_lock(self):
        save_chapter(self.project_ref, 3, "# 第三章\n正文。")
        before = self.metadata()
        result = self.readiness(2).json()
        self.assertEqual(result["blockers"][0]["code"], "chapter_locked")
        self.assertEqual(before, self.metadata())

    def test_other_project_generation_is_reported_globally(self):
        self.assertTrue(start_generation_task("chapter", "book:other-project", "1"))
        result = self.readiness(1).json()
        self.assertFalse(result["ready"])
        self.assertFalse(result["can_generate_assets"])
        self.assertIn("其他项目", result["blockers"][0]["message"])
        self.assertTrue(get_generation_status()["running"])

    def test_missing_assets_still_allows_the_resolving_asset_generation(self):
        with patch("api.routers.chapter_workflow._ensure_chapter_assets_ready", side_effect=HTTPException(400, {"error": {"code": "setting_assets_missing"}})):
            result = self.readiness(1).json()
        self.assertFalse(result["ready"])
        self.assertTrue(result["can_generate_assets"])
        self.assertEqual(result["blockers"][0]["action"], "generate_assets")

    def test_missing_config_or_model_disables_assets_and_provides_action(self):
        for method, code, action in (("_ensure_outline_character_ready", "project_config_incomplete", "project_settings"), ("_ensure_model_configured", "model_config_missing", "model_settings")):
            with self.subTest(code=code), patch(f"api.routers.chapter_workflow.{method}", side_effect=HTTPException(400, {"error": {"code": code}})):
                result = self.readiness(1).json()
                self.assertFalse(result["ready"])
                self.assertFalse(result["can_generate_assets"])
                self.assertEqual(result["blockers"][0]["action"], action)

    def test_unreadable_record_errors_instead_of_allowing_generation(self):
        self.seed()
        path = self.book.logs_dir / "chapter_workflow" / "chapter_001.json"
        path.write_text("not JSON", encoding="utf-8")
        response = self.readiness(2)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "workflow_record_invalid")

    def test_external_edit_requires_confirmation_without_rewriting_metadata(self):
        self.seed(ready=True)
        save_chapter(self.project_ref, 1, "# 修改正文\n新内容。")
        before = self.metadata()
        result = self.readiness(2).json()
        self.assertEqual(result["blockers"][0]["action"], "confirm_chapter")
        self.assertEqual(before, self.metadata())
