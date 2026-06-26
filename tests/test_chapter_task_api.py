from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from api.main import app
from project_context import create_workspace_book
from services.schemas import ChapterGenerationResult


def task_payload(**overrides):
    payload = {
        "primary_function": "emotional_aftermath",
        "secondary_functions": ["relationship_progress"],
        "intensity": "low",
        "canon_budget": "none",
        "must_carry": ["承接上一章争执"],
        "allowed_advances": ["恢复有限信任"],
        "forbidden_advances": ["揭示组织终局秘密"],
        "required_characters": ["林默", "周岚"],
        "relationship_goal": "让两人愿意继续合作",
        "decision_goal": "决定先回住处休整",
        "allowed_scene_types": ["厨房对话"],
        "forbidden_scene_drivers": ["查阅旧案卷"],
        "ending_state": "两人形成脆弱共识",
        "notes": "保持低强度",
    }
    payload.update(overrides)
    return payload


def generation_result(chapter_number: int = 1) -> ChapterGenerationResult:
    return ChapterGenerationResult(
        True,
        chapter_number=chapter_number,
        title="测试章节",
        chapter_path=f"chapter_{chapter_number:03d}.md",
        summary_path=f"chapter_{chapter_number:03d}_summary.md",
        index_path="chapter_index.md",
    )


class ChapterTaskApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.books_root = Path(self.temp_dir.name) / "books"
        self.book = create_workspace_book("API Test", books_root=self.books_root)
        self.project_ref = f"book:{self.book.book_id}"
        self.client = TestClient(app)
        self.context_patcher = patch(
            "services.chapter_task_service.resolve_project_context",
            side_effect=self._resolve_project_context,
        )
        self.context_patcher.start()

    def tearDown(self):
        self.context_patcher.stop()
        self.client.close()
        self.temp_dir.cleanup()

    def _resolve_project_context(self, project_ref: str, **_kwargs):
        if project_ref == self.project_ref:
            return self.book
        raise FileNotFoundError("Project not found.")

    def _task_url(self, chapter_number: int = 1) -> str:
        return f"/api/projects/{self.project_ref}/chapter-tasks/{chapter_number}"

    def _generate_url(self, chapter_number: int = 1, stream: bool = False) -> str:
        suffix = "/stream" if stream else ""
        return f"/api/projects/{self.project_ref}/chapters/{chapter_number}/generate{suffix}"

    def _create_draft(self, chapter_number: int = 1, **overrides) -> dict:
        response = self.client.post(self._task_url(chapter_number), json=task_payload(**overrides))
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["latest_draft"]

    def _approve(self, draft: dict, chapter_number: int = 1) -> dict:
        response = self.client.post(
            f"{self._task_url(chapter_number)}/approve",
            json={"task_id": draft["id"], "revision": draft["revision"]},
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["approved"]

    def _generation_patches(self, generate_mock: Mock):
        return (
            patch("api.routers.generation._load_project_config_or_error", return_value={"title": "API Test"}),
            patch("api.routers.generation._ensure_outline_character_ready"),
            patch("api.routers.generation._ensure_chapter_assets_ready"),
            patch("api.routers.generation._ensure_model_configured"),
            patch("api.routers.generation.start_generation_task", return_value=True),
            patch("api.routers.generation.complete_generation_task"),
            patch("api.routers.generation.fail_generation_task"),
            patch("api.routers.generation.generate_single_chapter", generate_mock),
        )

    def test_get_api_returns_approved_latest_draft_and_history(self):
        approved = self._approve(self._create_draft())
        draft = self._create_draft(notes="revision two")

        response = self.client.get(self._task_url())

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["approved"]["revision"], approved["revision"])
        self.assertEqual(payload["latest_draft"]["revision"], draft["revision"])
        self.assertEqual(len(payload["history"]), 2)

    def test_post_draft_api_rejects_incompatible_combination(self):
        response = self.client.post(
            self._task_url(),
            json=task_payload(primary_function="information_reveal"),
        )

        self.assertEqual(response.status_code, 400)
        error = response.json()["error"]
        self.assertEqual(error["code"], "chapter_task_invalid")
        self.assertIn("primary_function 'information_reveal'", error["message"])
        self.assertIn("canon_budget 'none'", error["message"])

    def test_approve_api_uses_requested_task_id_and_revision(self):
        draft = self._create_draft()

        response = self.client.post(
            f"{self._task_url()}/approve",
            json={"task_id": draft["id"], "revision": draft["revision"]},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["approved"]["id"], draft["id"])
        self.assertEqual(payload["approved"]["revision"], draft["revision"])
        self.assertEqual(payload["approved"]["status"], "approved")

    def test_generation_without_task_id_auto_loads_approved_task(self):
        approved = self._approve(self._create_draft())
        generate_mock = Mock(return_value=generation_result())
        patchers = self._generation_patches(generate_mock)

        with patchers[0], patchers[1], patchers[2], patchers[3], patchers[4], patchers[5], patchers[6], patchers[7]:
            response = self.client.post(
                self._generate_url(),
                json={"model": "test-model", "max_tokens": 1000, "temperature": 0.2},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(generate_mock.call_args.kwargs["chapter_task"]["id"], approved["id"])

    def test_generation_rejects_explicit_draft_task_id(self):
        draft = self._create_draft()
        generate_mock = Mock(return_value=generation_result())
        patchers = self._generation_patches(generate_mock)

        with patchers[0], patchers[1], patchers[2], patchers[3], patchers[4], patchers[5], patchers[6], patchers[7]:
            response = self.client.post(
                self._generate_url(),
                json={
                    "model": "test-model",
                    "max_tokens": 1000,
                    "temperature": 0.2,
                    "chapter_task_id": draft["id"],
                },
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "chapter_task_not_approved")
        generate_mock.assert_not_called()

    def test_generation_rejects_cross_chapter_task_id(self):
        approved = self._approve(self._create_draft(chapter_number=1), chapter_number=1)
        generate_mock = Mock(return_value=generation_result(2))
        patchers = self._generation_patches(generate_mock)

        with patchers[0], patchers[1], patchers[2], patchers[3], patchers[4], patchers[5], patchers[6], patchers[7]:
            response = self.client.post(
                self._generate_url(chapter_number=2),
                json={
                    "model": "test-model",
                    "max_tokens": 1000,
                    "temperature": 0.2,
                    "chapter_task_id": approved["id"],
                },
            )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "chapter_task_not_found")
        generate_mock.assert_not_called()

    def test_sync_generation_passes_task_contract_and_relative_path(self):
        approved = self._approve(self._create_draft())
        generate_mock = Mock(return_value=generation_result())
        patchers = self._generation_patches(generate_mock)

        with patchers[0], patchers[1], patchers[2], patchers[3], patchers[4], patchers[5], patchers[6], patchers[7]:
            response = self.client.post(
                self._generate_url(),
                json={"model": "test-model", "max_tokens": 1000, "temperature": 0.2},
            )

        self.assertEqual(response.status_code, 200, response.text)
        kwargs = generate_mock.call_args.kwargs
        self.assertEqual(kwargs["chapter_task"]["id"], approved["id"])
        self.assertIn("Derived Allowed Scene Contract", kwargs["allowed_scene_contract"])
        self.assertEqual(kwargs["chapter_task_relative_path"], "planning/chapter_task_sheets.json")

    def test_stream_generation_passes_same_task_fields(self):
        approved = self._approve(self._create_draft())
        stream_mock = Mock(
            return_value=iter(
                [
                    {
                        "type": "done",
                        "chapter_number": 1,
                        "title": "测试章节",
                        "chapter_file": "chapter_001.md",
                        "summary_file": "chapter_001_summary.md",
                        "index_file": "chapter_index.md",
                        "message": "Chapter generated.",
                    }
                ]
            )
        )

        with (
            patch("api.routers.generation._load_project_config_or_error", return_value={"title": "API Test"}),
            patch("api.routers.generation._ensure_outline_character_ready"),
            patch("api.routers.generation._ensure_chapter_assets_ready"),
            patch("api.routers.generation._ensure_model_configured"),
            patch("api.routers.generation.start_generation_task", return_value=True),
            patch("api.routers.generation.complete_generation_task"),
            patch("api.routers.generation.fail_generation_task"),
            patch("api.routers.generation.stream_generate_single_chapter", stream_mock),
        ):
            response = self.client.post(
                self._generate_url(stream=True),
                json={"model": "test-model", "max_tokens": 1000, "temperature": 0.2},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn('"type":"done"', response.text)
        kwargs = stream_mock.call_args.kwargs
        self.assertEqual(kwargs["chapter_task"]["id"], approved["id"])
        self.assertIn("Derived Allowed Scene Contract", kwargs["allowed_scene_contract"])
        self.assertEqual(kwargs["chapter_task_relative_path"], "planning/chapter_task_sheets.json")

    def test_generation_without_task_keeps_legacy_behavior(self):
        generate_mock = Mock(return_value=generation_result(chapter_number=3))
        patchers = self._generation_patches(generate_mock)

        with patchers[0], patchers[1], patchers[2], patchers[3], patchers[4], patchers[5], patchers[6], patchers[7]:
            response = self.client.post(
                self._generate_url(chapter_number=3),
                json={"model": "test-model", "max_tokens": 1000, "temperature": 0.2},
            )

        self.assertEqual(response.status_code, 200, response.text)
        kwargs = generate_mock.call_args.kwargs
        self.assertIsNone(kwargs["chapter_task"])
        self.assertEqual(kwargs["allowed_scene_contract"], "")

    def test_router_integration_never_calls_deepseek(self):
        generate_mock = Mock(return_value=generation_result(chapter_number=4))
        patchers = self._generation_patches(generate_mock)

        with (
            patchers[0],
            patchers[1],
            patchers[2],
            patchers[3],
            patchers[4],
            patchers[5],
            patchers[6],
            patchers[7],
            patch("deepseek_client.generate_text", side_effect=AssertionError("DeepSeek must not be called")) as deepseek_mock,
        ):
            response = self.client.post(
                self._generate_url(chapter_number=4),
                json={"model": "test-model", "max_tokens": 1000, "temperature": 0.2},
            )

        self.assertEqual(response.status_code, 200, response.text)
        deepseek_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
