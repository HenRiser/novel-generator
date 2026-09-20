from __future__ import annotations

import json
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

from api.generation_state import complete_generation_task, start_generation_task
from api.main import app
from deepseek_client import DeepSeekClientError
from file_manager import read_chapter, read_history_summaries, save_chapter, save_summary
from project_context import create_workspace_book
from services.chapter_workflow_service import (
    get_chapter_workflow,
    prepare_next_chapter,
    register_generated_chapter,
)


class ChapterWorkflowApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.book = create_workspace_book("Confirmation API", books_root=Path(self.temp_dir.name) / "books")
        self.project_ref = f"book:{self.book.book_id}"
        self.book.outline_path.write_text("# Outline\nA quiet investigation.", encoding="utf-8")
        self.book.characters_path.write_text("# Characters\nA and B.", encoding="utf-8")
        self.patches = ExitStack()
        self.addCleanup(self.patches.close)
        for target in (
            "file_manager.resolve_project_context",
            "services.chapter_workflow_service.resolve_project_context",
            "services.batch_generation_service.resolve_project_context",
        ):
            self.patches.enter_context(patch(target, side_effect=self._resolve))
        for module in ("generation", "chapter_workflow"):
            self.patches.enter_context(patch(f"api.routers.{module}._load_project_config_or_error", return_value={"title": "Test"}))
            self.patches.enter_context(patch(f"api.routers.{module}._ensure_outline_character_ready"))
            self.patches.enter_context(patch(f"api.routers.{module}._ensure_chapter_assets_ready"))
            self.patches.enter_context(patch(f"api.routers.{module}._ensure_model_configured"))
        self.patches.enter_context(patch("api.routers.generation._resolve_chapter_task_or_error", return_value=None))
        self.patches.enter_context(patch("api.routers.generation._resolve_scene_plan_or_error", return_value=None))
        self.patches.enter_context(patch("services.generation_service.create_ai_run_record_best_effort", return_value=SimpleNamespace(ok=False)))
        self.patches.enter_context(patch("services.generation_service.create_no_reveal_compliance_review", return_value=SimpleNamespace(ok=False)))
        self.patches.enter_context(patch("services.generation_service.append_event_best_effort"))
        self.patches.enter_context(patch("api.routers.continue_writing.has_api_key", return_value=True))
        self.patches.enter_context(patch("api.routers.continue_writing.load_project_detail", return_value=SimpleNamespace(ok=True, config={})))
        # A missing model mock must fail locally, never reach a real provider.
        for target in (
            "services.generation_service.generate_text",
            "services.generation_service.stream_generate_text_events",
            "services.chapter_workflow_service.generate_text",
            "api.routers.continue_writing.stream_generate_text_events",
        ):
            self.patches.enter_context(patch(target, side_effect=AssertionError("Unexpected model call")))
        complete_generation_task()
        self.addCleanup(complete_generation_task)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def _resolve(self, project_ref, **_kwargs):
        if project_ref == self.project_ref:
            return self.book
        raise FileNotFoundError("Project not found")

    def _url(self, number=1, action="workflow"):
        return f"/api/projects/{self.project_ref}/chapters/{number}/{action}"

    def _seed(self, number=1, *, ready=False):
        content = f"# 第 {number} 章：夜色\n\n林雾走进房间。"
        path = save_chapter(self.project_ref, number, content)
        summary_path = save_summary(self.project_ref, number, "林雾走进房间。") if ready else ""
        return register_generated_chapter(
            self.project_ref, number, path, content, "test-model",
            confirmed=ready, summary="林雾走进房间。" if ready else "", summary_path=summary_path,
        )

    def test_single_generation_saves_draft_without_summary_call(self):
        with patch("services.generation_service.generate_text", return_value="# 第 1 章：夜色\n\n正文。") as model:
            response = self.client.post(self._url(action="generate"), json={"model": "test-model"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(model.call_count, 1)
        self.assertEqual(response.json()["workflow"]["status"], "awaiting_confirmation")
        self.assertEqual(response.json()["summary_file"], "")
        self.assertEqual(list(self.book.summaries_dir.iterdir()), [])

    def test_stream_finishes_with_confirmation_state_without_summary(self):
        chunks = [{"kind": "reasoning", "text": "plan"}, {"kind": "content", "text": "# 第 1 章：夜色\n\n正文。"}]
        with patch("services.generation_service.stream_generate_text_events", return_value=iter(chunks)):
            response = self.client.post(self._url(action="generate/stream"), json={"model": "test-model"})
        self.assertEqual(response.status_code, 200, response.text)
        events = [json.loads(line) for line in response.text.splitlines()]
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(events[-1]["workflow"]["summary_status"], "not_requested")
        self.assertEqual(list(self.book.summaries_dir.iterdir()), [])

    def test_confirm_edited_text_runs_background_summary_on_new_revision(self):
        original = self._seed()
        edited = "# 第 1 章：夜色\n\n林雾还活着。她打开房门。"
        warning = {"message": "可能存在时间矛盾", "constraint": "人物状态", "evidence": "林雾还活着。", "suggestion": "核对前文"}
        output = json.dumps({"summary": "林雾打开房门。", "warnings": [warning]}, ensure_ascii=False)
        with patch("services.chapter_workflow_service.generate_text", return_value=output) as model:
            response = self.client.post(self._url(action="confirm"), json={"content": edited, "expected_revision": original["revision"]})
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.json()["summary_status"], "pending")
        self.assertNotEqual(response.json()["revision"], original["revision"])
        self.assertEqual(read_chapter(self.project_ref, 1)[0], edited)
        submitted = json.loads(model.call_args.kwargs["messages"][-1]["content"])
        self.assertEqual(submitted["confirmed_chapter_text"], edited)
        state = self.client.get(self._url()).json()
        self.assertEqual(state["summary_status"], "ready")
        self.assertEqual(state["summary"], "林雾打开房门。")
        self.assertEqual(state["warnings"][0]["evidence"], "林雾还活着。")

    def test_stale_revision_rejects_edit_without_scheduling(self):
        original = self._seed()
        with patch("api.routers.chapter_workflow.run_confirmed_chapter_tasks") as background:
            response = self.client.post(self._url(action="confirm"), json={"content": "different", "expected_revision": "stale"})
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["error"]["code"], "revision_conflict")
        background.assert_not_called()
        self.assertEqual(get_chapter_workflow(self.project_ref, 1)["revision"], original["revision"])

    def test_missing_and_empty_chapters_are_rejected(self):
        self.assertEqual(self.client.get(self._url()).status_code, 404)
        missing = self.client.post(self._url(action="confirm"), json={"content": "text", "expected_revision": "missing"})
        self.assertEqual(missing.status_code, 404, missing.text)
        state = self._seed()
        empty = self.client.post(self._url(action="confirm"), json={"content": "", "expected_revision": state["revision"]})
        self.assertEqual(empty.status_code, 400, empty.text)

    def test_next_chapter_requires_confirmation_and_ready_summary(self):
        self._seed()
        with patch("services.generation_service.generate_text") as model:
            response = self.client.post(self._url(2, "generate"), json={"model": "test-model"})
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["error"]["code"], "previous_chapter_not_ready")
        model.assert_not_called()

    def test_lock_survives_next_chapter_generation_failure(self):
        self._seed(ready=True)
        with patch("services.generation_service.generate_text", side_effect=DeepSeekClientError("mock failure")):
            response = self.client.post(self._url(2, "generate"), json={"model": "test-model"})
        self.assertEqual(response.status_code, 500, response.text)
        state = get_chapter_workflow(self.project_ref, 1)
        self.assertFalse(state["editable"])
        self.assertEqual(state["locked_by_chapter"], 2)

    def test_all_write_and_regeneration_routes_reject_locked_chapter(self):
        state = self._seed(ready=True)
        prepare_next_chapter(self.project_ref, 2)
        requests = [
            ("confirm", {"content": "changed", "expected_revision": state["revision"]}),
            ("continue/save", {"content": "changed", "mode": "replace"}),
            ("continue/save", {"content": "added", "mode": "append"}),
            ("continue", {"context_text": state["content"], "instruction": "continue"}),
            ("generate", {"model": "test-model"}),
            ("generate/stream", {"model": "test-model"}),
        ]
        for action, payload in requests:
            with self.subTest(action=action, payload=payload):
                response = self.client.post(self._url(action=action), json=payload)
                self.assertEqual(response.status_code, 409, response.text)
                self.assertEqual(response.json()["error"]["code"], "chapter_locked")
        self.assertEqual(read_chapter(self.project_ref, 1)[0], state["content"])

    def test_active_generation_prevents_confirmation(self):
        state = self._seed()
        self.assertTrue(start_generation_task("batch", self.project_ref, "chapters_2_3"))
        response = self.client.post(self._url(action="confirm"), json={"content": "changed", "expected_revision": state["revision"]})
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["error"]["code"], "generation_running")
        self.assertFalse(self.client.get(self._url()).json()["editable"])

    def test_continuation_cannot_create_next_chapter_before_previous_is_ready(self):
        state = self._seed()
        response = self.client.post(self._url(2, "continue/save"), json={"content": "# 第 2 章\n后文", "mode": "replace"})
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["error"]["code"], "previous_chapter_not_ready")
        self.assertIsNone(read_chapter(self.project_ref, 2)[1])
        previous = get_chapter_workflow(self.project_ref, 1)
        self.assertTrue(previous["editable"])
        self.assertEqual(previous["revision"], state["revision"])

    def test_history_uses_confirmed_revision_and_discards_summary_after_continuation(self):
        original = self._seed(ready=True)
        output = json.dumps({"summary": "用户改稿对应的新摘要。", "warnings": []}, ensure_ascii=False)
        with patch("services.chapter_workflow_service.generate_text", return_value=output):
            response = self.client.post(self._url(action="confirm"), json={
                "content": original["content"] + "\n她决定离开。", "expected_revision": original["revision"],
            })
        self.assertEqual(response.status_code, 202, response.text)
        save_summary(self.project_ref, 1, "不属于当前确认版本的游离摘要。")
        history = read_history_summaries(self.project_ref, before_chapter=2)
        self.assertIn("用户改稿对应的新摘要。", history)
        self.assertNotIn("林雾走进房间。", history)
        self.assertNotIn("游离摘要", history)
        saved = self.client.post(self._url(action="continue/save"), json={"content": "她折返回来。", "mode": "append"})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(read_history_summaries(self.project_ref, before_chapter=2), "")
        self.assertEqual(get_chapter_workflow(self.project_ref, 1)["status"], "awaiting_confirmation")

    def test_batch_route_validates_limit_and_exposes_stop(self):
        url = f"/api/projects/{self.project_ref}/generation/batch"
        invalid = self.client.post(url, json={"start_chapter": 1, "end_chapter": 11, "model": "test-model"})
        self.assertEqual(invalid.status_code, 400, invalid.text)
        with patch("api.routers.chapter_workflow.run_batch_generation") as worker:
            accepted = self.client.post(url, json={"start_chapter": 1, "end_chapter": 2, "model": "test-model"})
        self.assertEqual(accepted.status_code, 202, accepted.text)
        worker.assert_called_once_with(self.project_ref, accepted.json()["id"])
        duplicate = self.client.post(url, json={"start_chapter": 1, "end_chapter": 2, "model": "test-model"})
        self.assertEqual(duplicate.status_code, 409, duplicate.text)
        self.assertEqual(self.client.post(url + "/stop").json()["status"], "stopping")
        self.assertEqual(self.client.get(url).json()["status"], "stopping")


if __name__ == "__main__":
    unittest.main()
