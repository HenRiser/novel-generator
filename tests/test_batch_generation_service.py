from __future__ import annotations

import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from api.generation_state import complete_generation_task, get_generation_status, start_generation_task
from file_manager import read_chapter, save_chapter
from project_context import create_workspace_book
from services import batch_generation_service as batch
from services.chapter_workflow_service import (
    WorkflowError, get_chapter_workflow, register_generated_chapter,
)


class BatchGenerationServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.book = create_workspace_book("Batch Test", books_root=Path(self.temp_dir.name) / "books")
        self.project_ref = f"book:{self.book.book_id}"
        self.patches = ExitStack()
        self.addCleanup(self.patches.close)
        for target in (
            "file_manager.resolve_project_context",
            "services.chapter_workflow_service.resolve_project_context",
            "services.batch_generation_service.resolve_project_context",
        ):
            self.patches.enter_context(patch(target, side_effect=self._resolve))
        self.patches.enter_context(patch("services.batch_generation_service.load_project_detail", return_value=SimpleNamespace(ok=True, config={"title": "Test"})))
        self.patches.enter_context(patch("services.batch_generation_service._chapter_inputs", return_value={}))
        self.generate = self.patches.enter_context(patch("services.batch_generation_service.generate_single_chapter", side_effect=self._generate))
        self.summary = self.patches.enter_context(patch("services.chapter_workflow_service.generate_text", side_effect=self._summary))
        self.trace = []
        self.current_chapter = 0
        complete_generation_task()
        self.addCleanup(complete_generation_task)
        self.addCleanup(self._clear_jobs)

    def _clear_jobs(self):
        batch._active_jobs.difference_update(key for key in list(batch._active_jobs) if key[0] == self.project_ref)
        batch._executing_jobs.difference_update(key for key in list(batch._executing_jobs) if key[0] == self.project_ref)

    def _resolve(self, project_ref, **_kwargs):
        if project_ref == self.project_ref:
            return self.book
        raise FileNotFoundError("Project not found")

    def _generate(self, **kwargs):
        number = kwargs["chapter_number"]
        self.current_chapter = number
        self.trace.append(f"generate:{number}")
        self.assertTrue(kwargs["defer_summary"])
        self.assertTrue(get_generation_status()["running"])
        if number > 1:
            previous = get_chapter_workflow(self.project_ref, number - 1)
            self.assertEqual(previous["summary_status"], "ready")
            self.assertFalse(previous["editable"])
        content = f"# 第 {number} 章：场景\n\n正文 {number}。"
        path = save_chapter(self.project_ref, number, content)
        workflow = register_generated_chapter(self.project_ref, number, path, content, "test-model")
        return SimpleNamespace(ok=True, content=content, chapter_path=str(path), workflow=workflow)

    def _summary(self, **_kwargs):
        self.trace.append(f"summary:{self.current_chapter}")
        return f"第 {self.current_chapter} 章摘要。"

    def _start(self, count=3):
        return batch.start_batch_generation(self.project_ref, 1, count, "test-model")

    def test_batch_waits_for_each_summary_and_locks_only_preceding_chapters(self):
        state = self._start()
        batch.run_batch_generation(self.project_ref, state["id"])
        result = batch.get_batch_generation_status(self.project_ref)
        self.assertEqual(result["status"], "completed", result)
        self.assertEqual(result["completed_chapters"], [1, 2, 3])
        self.assertEqual(self.trace, ["generate:1", "summary:1", "generate:2", "summary:2", "generate:3", "summary:3"])
        self.assertFalse(get_chapter_workflow(self.project_ref, 1)["editable"])
        self.assertFalse(get_chapter_workflow(self.project_ref, 2)["editable"])
        self.assertTrue(get_chapter_workflow(self.project_ref, 3)["editable"])
        self.assertFalse(get_generation_status()["running"])

    def test_stop_during_summary_finishes_current_chapter_without_starting_next(self):
        def stopping_summary(**kwargs):
            result = self._summary(**kwargs)
            self.assertEqual(batch.request_batch_stop(self.project_ref)["status"], "stopping")
            return result
        self.summary.side_effect = stopping_summary
        state = self._start()
        batch.run_batch_generation(self.project_ref, state["id"])
        result = batch.get_batch_generation_status(self.project_ref)
        self.assertEqual(result["status"], "stopped", result)
        self.assertEqual(result["completed_chapters"], [1])
        self.assertEqual(self.trace, ["generate:1", "summary:1"])
        self.assertIsNone(read_chapter(self.project_ref, 2)[1])
        self.assertTrue(get_chapter_workflow(self.project_ref, 1)["editable"])
        self.assertFalse(get_generation_status()["running"])

    def test_stop_before_worker_starts_makes_no_model_calls(self):
        state = self._start()
        batch.request_batch_stop(self.project_ref)
        batch.run_batch_generation(self.project_ref, state["id"])
        self.assertEqual(batch.get_batch_generation_status(self.project_ref)["status"], "stopped")
        self.generate.assert_not_called()
        self.summary.assert_not_called()

    def test_summary_failure_stops_batch_preserves_draft_and_previous_lock(self):
        def failing_summary(**kwargs):
            if self.current_chapter == 2:
                raise RuntimeError("mock provider failure")
            return self._summary(**kwargs)
        self.summary.side_effect = failing_summary
        state = self._start()
        batch.run_batch_generation(self.project_ref, state["id"])
        result = batch.get_batch_generation_status(self.project_ref)
        self.assertEqual(result["status"], "failed", result)
        self.assertEqual(result["completed_chapters"], [1])
        self.assertEqual(self.generate.call_count, 2)
        self.assertIsNotNone(read_chapter(self.project_ref, 2)[1])
        self.assertIsNone(read_chapter(self.project_ref, 3)[1])
        self.assertFalse(get_chapter_workflow(self.project_ref, 1)["editable"])
        self.assertEqual(get_chapter_workflow(self.project_ref, 2)["summary_status"], "failed")
        self.assertFalse(get_generation_status()["running"])

    def test_failed_body_keeps_preceding_chapter_locked(self):
        def fail_second(**kwargs):
            if kwargs["chapter_number"] == 2:
                return SimpleNamespace(ok=False, message="mock failure")
            return self._generate(**kwargs)
        self.generate.side_effect = fail_second
        state = self._start()
        batch.run_batch_generation(self.project_ref, state["id"])
        self.assertEqual(batch.get_batch_generation_status(self.project_ref)["status"], "failed")
        self.assertFalse(get_chapter_workflow(self.project_ref, 1)["editable"])
        self.assertIsNone(read_chapter(self.project_ref, 2)[1])
        self.assertFalse(get_generation_status()["running"])

    def test_duplicate_start_and_worker_do_not_generate_twice(self):
        state = self._start(1)
        with self.assertRaises(WorkflowError) as caught:
            self._start(1)
        self.assertEqual(caught.exception.status_code, 409)
        batch.run_batch_generation(self.project_ref, state["id"])
        batch.run_batch_generation(self.project_ref, state["id"])
        self.assertEqual(self.generate.call_count, 1)
        self.assertEqual(self.summary.call_count, 1)

    def test_invalid_range_and_unconfirmed_previous_chapter_are_rejected(self):
        for start, end in ((2, 3), (1, 11), (2, 1)):
            with self.subTest(start=start, end=end), self.assertRaises(WorkflowError) as caught:
                batch.start_batch_generation(self.project_ref, start, end, "test-model")
            self.assertEqual(caught.exception.status_code, 400)
        path = save_chapter(self.project_ref, 1, "draft")
        register_generated_chapter(self.project_ref, 1, path, "draft", "test-model")
        with self.assertRaises(WorkflowError) as caught:
            batch.start_batch_generation(self.project_ref, 2, 3, "test-model")
        self.assertEqual(caught.exception.code, "previous_chapter_not_ready")
        self.assertFalse(get_generation_status()["running"])

    def test_restart_exposes_interrupted_batch_as_retryable_failure(self):
        self._start()
        self._clear_jobs()
        complete_generation_task()
        result = batch.get_batch_generation_status(self.project_ref)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["stage"], "interrupted")
        self.generate.assert_not_called()

    def test_unwritable_batch_metadata_still_releases_generation_reservation(self):
        state = self._start()
        with patch.object(batch, "_write", side_effect=OSError("mock disk failure")):
            batch.run_batch_generation(self.project_ref, state["id"])
        self.assertFalse(get_generation_status()["running"])
        self.assertNotIn((self.project_ref, state["id"]), batch._active_jobs)
        self.assertNotIn((self.project_ref, state["id"]), batch._executing_jobs)
        self.generate.assert_not_called()

    def test_project_missing_before_worker_claim_still_releases_reservation(self):
        state = self._start()
        with patch("services.chapter_workflow_service.resolve_project_context", side_effect=FileNotFoundError("removed")):
            batch.run_batch_generation(self.project_ref, state["id"])
        self.assertFalse(get_generation_status()["running"])
        self.assertNotIn((self.project_ref, state["id"]), batch._active_jobs)
        self.assertNotIn((self.project_ref, state["id"]), batch._executing_jobs)
        self.generate.assert_not_called()

    def test_completed_worker_retry_does_not_release_another_generation_task(self):
        state = self._start(1)
        batch.run_batch_generation(self.project_ref, state["id"])
        self.assertTrue(start_generation_task("chapter", "book:other", "chapter_1"))
        batch.run_batch_generation(self.project_ref, state["id"])
        active = get_generation_status()
        self.assertTrue(active["running"])
        self.assertEqual(active["project_ref"], "book:other")
        self.assertEqual(self.generate.call_count, 1)


if __name__ == "__main__":
    unittest.main()
