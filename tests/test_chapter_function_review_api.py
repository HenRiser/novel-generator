from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

from api.main import app
from deepseek_client import DeepSeekClientError
from project_context import LEGACY_STORAGE_KIND, create_workspace_book


def task_payload(**overrides):
    payload = {
        "primary_function": "emotional_aftermath",
        "secondary_functions": ["relationship_progress"],
        "intensity": "low",
        "canon_budget": "none",
        "must_carry": ["carry known pressure"],
        "allowed_advances": ["trust adjustment"],
        "forbidden_advances": ["new reveal"],
        "required_characters": ["A", "B"],
        "relationship_goal": "limited trust",
        "decision_goal": "pause investigation",
        "allowed_scene_types": ["low intensity dialogue"],
        "forbidden_scene_drivers": ["archive decoding"],
        "ending_state": "small agreement",
        "notes": "no reveal",
    }
    payload.update(overrides)
    return payload


class ChapterFunctionReviewApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.books_root = Path(self.temp_dir.name) / "books"
        self.book = create_workspace_book("No Reveal API Test", books_root=self.books_root)
        self.project_ref = f"book:{self.book.book_id}"
        self.book.project_dir.joinpath("outline.md").write_text("# Outline\nKnown pressure only.", encoding="utf-8")
        self.book.project_dir.joinpath("characters.md").write_text("# Characters\nA and B.", encoding="utf-8")
        self.client = TestClient(app)
        self.context_patchers = [
            patch("services.chapter_task_service.resolve_project_context", side_effect=self._resolve_project_context),
            patch("services.chapter_function_review_service.resolve_project_context", side_effect=self._resolve_project_context),
            patch("file_manager.resolve_project_context", side_effect=self._resolve_project_context),
            patch("services.ai_run_service.resolve_project_context", side_effect=self._resolve_project_context),
            patch("services.event_log_service.resolve_project_context", side_effect=self._resolve_project_context),
        ]
        for patcher in self.context_patchers:
            patcher.start()

    def tearDown(self):
        for patcher in reversed(self.context_patchers):
            patcher.stop()
        self.client.close()
        self.temp_dir.cleanup()

    def _resolve_project_context(self, project_ref: str, **_kwargs):
        if project_ref == self.project_ref:
            return self.book
        raise FileNotFoundError("Project not found.")

    def _task_url(self, chapter_number: int = 1) -> str:
        return f"/api/projects/{self.project_ref}/chapter-tasks/{chapter_number}"

    def _review_url(self, chapter_number: int = 1) -> str:
        return f"/api/projects/{self.project_ref}/chapters/{chapter_number}/function-review"

    def _generate_url(self, chapter_number: int = 1, stream: bool = False) -> str:
        suffix = "/stream" if stream else ""
        return f"/api/projects/{self.project_ref}/chapters/{chapter_number}/generate{suffix}"

    def _approve_task(self, chapter_number: int = 1, **overrides) -> dict:
        response = self.client.post(self._task_url(chapter_number), json=task_payload(**overrides))
        self.assertEqual(response.status_code, 200, response.text)
        draft = response.json()["latest_draft"]
        response = self.client.post(
            f"{self._task_url(chapter_number)}/approve",
            json={"task_id": draft["id"], "revision": draft["revision"]},
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["approved"]

    def _generation_common_patches(self):
        return (
            patch("api.routers.generation._load_project_config_or_error", return_value={"title": "No Reveal API Test"}),
            patch("api.routers.generation._ensure_outline_character_ready"),
            patch("api.routers.generation._ensure_chapter_assets_ready"),
            patch("api.routers.generation._ensure_model_configured"),
            patch("api.routers.generation.start_generation_task", return_value=True),
            patch("api.routers.generation.complete_generation_task"),
            patch("api.routers.generation.fail_generation_task"),
        )

    def test_get_function_review_returns_empty_state(self):
        response = self.client.get(self._review_url())

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertIsNone(payload["latest"])
        self.assertEqual(payload["history"], [])

    def test_get_function_review_rejects_legacy_project(self):
        with patch(
            "services.chapter_function_review_service.resolve_project_context",
            return_value=SimpleNamespace(storage_kind=LEGACY_STORAGE_KIND),
        ):
            response = self.client.get("/api/projects/legacy:old/chapters/1/function-review")

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "chapter_function_review_unsupported_project")

    def test_sync_generation_creates_no_reveal_review(self):
        self._approve_task()
        common = self._generation_common_patches()
        with (
            common[0],
            common[1],
            common[2],
            common[3],
            common[4],
            common[5],
            common[6],
            patch(
                "services.generation_service.generate_text",
                side_effect=["# Chapter\nHe opened the archive and read the attendance record.", "summary"],
            ),
        ):
            response = self.client.post(
                self._generate_url(),
                json={"model": "test-model", "max_tokens": 1000, "temperature": 0.2},
            )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["function_review"]["verdict"], "fail")
        self.assertTrue(payload["function_review"]["ai_run_id"])
        loaded = self.client.get(self._review_url()).json()
        self.assertEqual(loaded["latest"]["id"], payload["function_review"]["id"])

    def test_stream_generation_creates_no_reveal_review(self):
        self._approve_task()
        common = self._generation_common_patches()
        with (
            common[0],
            common[1],
            common[2],
            common[3],
            common[4],
            common[5],
            common[6],
            patch("services.generation_service.stream_generate_text", return_value=iter(["# Chapter\n", "He decoded GA-197."])),
            patch("services.generation_service.generate_text", return_value="summary"),
        ):
            response = self.client.post(
                self._generate_url(stream=True),
                json={"model": "test-model", "max_tokens": 1000, "temperature": 0.2},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn('"function_review"', response.text)
        self.assertIn('"verdict":"fail"', response.text)
        loaded = self.client.get(self._review_url()).json()
        self.assertEqual(loaded["latest"]["verdict"], "fail")

    def test_generation_failure_does_not_create_review(self):
        self._approve_task()
        common = self._generation_common_patches()
        with (
            common[0],
            common[1],
            common[2],
            common[3],
            common[4],
            common[5],
            common[6],
            patch("services.generation_service.generate_text", side_effect=DeepSeekClientError("mock failure")),
        ):
            response = self.client.post(
                self._generate_url(),
                json={"model": "test-model", "max_tokens": 1000, "temperature": 0.2},
            )

        self.assertEqual(response.status_code, 500)
        loaded = self.client.get(self._review_url()).json()
        self.assertIsNone(loaded["latest"])
        self.assertEqual(loaded["history"], [])


if __name__ == "__main__":
    unittest.main()
