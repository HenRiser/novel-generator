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
        "forbidden_advances": ["揭示组织秘密"],
        "required_characters": ["林默", "周岚"],
        "relationship_goal": "让两人愿意继续同行",
        "decision_goal": "决定先回住处休整",
        "allowed_scene_types": ["低强度对话"],
        "forbidden_scene_drivers": ["查阅旧档案"],
        "ending_state": "两人形成脆弱共识",
        "notes": "保持低强度",
    }
    payload.update(overrides)
    return payload


def scene(scene_no: int, **overrides):
    payload = {
        "scene_no": scene_no,
        "title": f"场景 {scene_no}",
        "location": "住处厨房",
        "participants": ["林默", "周岚"],
        "scene_function": "relationship_dialogue",
        "allowed_information": ["恢复有限信任"],
        "forbidden_information": ["不释放新正典信息"],
        "emotional_shift": "从回避到暂时信任",
        "ending_state": "决定稍后再处理材料",
    }
    payload.update(overrides)
    return payload


def scene_payload(**overrides):
    payload = {"scenes": [scene(1), scene(2)]}
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


class ScenePlanApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.books_root = Path(self.temp_dir.name) / "books"
        self.book = create_workspace_book("Scene API Test", books_root=self.books_root)
        self.project_ref = f"book:{self.book.book_id}"
        self.client = TestClient(app)
        self.scene_context_patcher = patch(
            "services.scene_plan_service.resolve_project_context",
            side_effect=self._resolve_project_context,
        )
        self.task_context_patcher = patch(
            "services.chapter_task_service.resolve_project_context",
            side_effect=self._resolve_project_context,
        )
        self.scene_context_patcher.start()
        self.task_context_patcher.start()

    def tearDown(self):
        self.scene_context_patcher.stop()
        self.task_context_patcher.stop()
        self.client.close()
        self.temp_dir.cleanup()

    def _resolve_project_context(self, project_ref: str, **_kwargs):
        if project_ref == self.project_ref:
            return self.book
        raise FileNotFoundError("Project not found.")

    def _task_url(self, chapter_number: int = 1) -> str:
        return f"/api/projects/{self.project_ref}/chapter-tasks/{chapter_number}"

    def _plan_url(self, chapter_number: int = 1) -> str:
        return f"/api/projects/{self.project_ref}/scene-plans/{chapter_number}"

    def _generate_url(self, chapter_number: int = 1, stream: bool = False) -> str:
        suffix = "/stream" if stream else ""
        return f"/api/projects/{self.project_ref}/chapters/{chapter_number}/generate{suffix}"

    def _create_task(self, **overrides) -> dict:
        response = self.client.post(self._task_url(), json=task_payload(**overrides))
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["latest_draft"]

    def _approve_task(self, draft: dict) -> dict:
        response = self.client.post(
            f"{self._task_url()}/approve",
            json={"task_id": draft["id"], "revision": draft["revision"]},
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["approved"]

    def _create_plan(self, chapter_number: int = 1, **overrides) -> dict:
        response = self.client.post(self._plan_url(chapter_number), json=scene_payload(**overrides))
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["latest_draft"]

    def _approve_plan(self, draft: dict, chapter_number: int = 1) -> dict:
        response = self.client.post(
            f"{self._plan_url(chapter_number)}/approve",
            json={"scene_plan_id": draft["id"], "revision": draft["revision"]},
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["approved"]

    def _generation_patches(self, generate_mock: Mock):
        return (
            patch("api.routers.generation._load_project_config_or_error", return_value={"title": "Scene API Test"}),
            patch("api.routers.generation._ensure_outline_character_ready"),
            patch("api.routers.generation._ensure_chapter_assets_ready"),
            patch("api.routers.generation._ensure_model_configured"),
            patch("api.routers.generation.start_generation_task", return_value=True),
            patch("api.routers.generation.complete_generation_task"),
            patch("api.routers.generation.fail_generation_task"),
            patch("api.routers.generation.generate_single_chapter", generate_mock),
        )

    def test_get_returns_plan_state_and_current_approved_task(self):
        task = self._approve_task(self._create_task())
        approved = self._approve_plan(
            self._create_plan(source_chapter_task_id=task["id"], source_chapter_task_revision=task["revision"])
        )
        draft = self._create_plan(scenes=[scene(1, title="第二版"), scene(2)])

        response = self.client.get(self._plan_url())

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["approved"]["id"], approved["id"])
        self.assertEqual(payload["latest_draft"]["id"], draft["id"])
        self.assertEqual(payload["current_approved_chapter_task"]["id"], task["id"])
        self.assertEqual(len(payload["history"]), 2)

    def test_post_creates_and_updates_draft(self):
        draft = self._create_plan()

        response = self.client.post(
            self._plan_url(),
            json=scene_payload(id=draft["id"], revision=draft["revision"], scenes=[scene(1, title="更新"), scene(2)]),
        )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["latest_draft"]["revision"], 1)
        self.assertEqual(payload["latest_draft"]["scenes"][0]["title"], "更新")

    def test_approve_uses_requested_id_and_revision(self):
        draft = self._create_plan()

        response = self.client.post(
            f"{self._plan_url()}/approve",
            json={"scene_plan_id": draft["id"], "revision": draft["revision"]},
        )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["approved"]["id"], draft["id"])
        self.assertEqual(payload["approved"]["revision"], draft["revision"])

    def test_generation_rejects_draft_scene_plan_id(self):
        draft = self._create_plan()
        generate_mock = Mock(return_value=generation_result())
        patchers = self._generation_patches(generate_mock)

        with patchers[0], patchers[1], patchers[2], patchers[3], patchers[4], patchers[5], patchers[6], patchers[7]:
            response = self.client.post(
                self._generate_url(),
                json={"model": "test-model", "max_tokens": 1000, "temperature": 0.2, "scene_plan_id": draft["id"]},
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "scene_plan_not_approved")
        generate_mock.assert_not_called()

    def test_sync_generation_passes_approved_scene_plan(self):
        approved = self._approve_plan(self._create_plan())
        generate_mock = Mock(return_value=generation_result())
        patchers = self._generation_patches(generate_mock)

        with patchers[0], patchers[1], patchers[2], patchers[3], patchers[4], patchers[5], patchers[6], patchers[7]:
            response = self.client.post(
                self._generate_url(),
                json={"model": "test-model", "max_tokens": 1000, "temperature": 0.2, "scene_plan_id": approved["id"]},
            )

        self.assertEqual(response.status_code, 200, response.text)
        kwargs = generate_mock.call_args.kwargs
        self.assertEqual(kwargs["scene_plan"]["id"], approved["id"])
        self.assertEqual(kwargs["scene_plan_relative_path"], "planning/scene_plans.json")

    def test_stream_generation_passes_approved_scene_plan(self):
        approved = self._approve_plan(self._create_plan())
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
            patch("api.routers.generation._load_project_config_or_error", return_value={"title": "Scene API Test"}),
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
                json={"model": "test-model", "max_tokens": 1000, "temperature": 0.2, "scene_plan_id": approved["id"]},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn('"type":"done"', response.text)
        kwargs = stream_mock.call_args.kwargs
        self.assertEqual(kwargs["scene_plan"]["id"], approved["id"])
        self.assertEqual(kwargs["scene_plan_relative_path"], "planning/scene_plans.json")

    def test_generation_rejects_scene_plan_chapter_task_mismatch(self):
        first_task = self._approve_task(self._create_task())
        approved_plan = self._approve_plan(
            self._create_plan(
                source_chapter_task_id=first_task["id"],
                source_chapter_task_revision=first_task["revision"],
            )
        )
        second_task = self._approve_task(self._create_task(ending_state="第二版任务单"))
        generate_mock = Mock(return_value=generation_result())
        patchers = self._generation_patches(generate_mock)

        with patchers[0], patchers[1], patchers[2], patchers[3], patchers[4], patchers[5], patchers[6], patchers[7]:
            response = self.client.post(
                self._generate_url(),
                json={
                    "model": "test-model",
                    "max_tokens": 1000,
                    "temperature": 0.2,
                    "chapter_task_id": second_task["id"],
                    "scene_plan_id": approved_plan["id"],
                },
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "scene_plan_task_mismatch")
        generate_mock.assert_not_called()

    def test_generation_rejects_unbound_scene_plan_when_task_is_loaded(self):
        self._approve_task(self._create_task())
        approved_plan = self._approve_plan(self._create_plan())
        generate_mock = Mock(return_value=generation_result())
        patchers = self._generation_patches(generate_mock)

        with patchers[0], patchers[1], patchers[2], patchers[3], patchers[4], patchers[5], patchers[6], patchers[7]:
            response = self.client.post(
                self._generate_url(),
                json={
                    "model": "test-model",
                    "max_tokens": 1000,
                    "temperature": 0.2,
                    "scene_plan_id": approved_plan["id"],
                },
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "scene_plan_task_mismatch")
        generate_mock.assert_not_called()

    def test_generation_without_scene_plan_keeps_legacy_behavior(self):
        generate_mock = Mock(return_value=generation_result(chapter_number=3))
        patchers = self._generation_patches(generate_mock)

        with patchers[0], patchers[1], patchers[2], patchers[3], patchers[4], patchers[5], patchers[6], patchers[7]:
            response = self.client.post(
                self._generate_url(chapter_number=3),
                json={"model": "test-model", "max_tokens": 1000, "temperature": 0.2},
            )

        self.assertEqual(response.status_code, 200, response.text)
        kwargs = generate_mock.call_args.kwargs
        self.assertIsNone(kwargs["scene_plan"])
        self.assertIsNone(kwargs["scene_plan_relative_path"])

    def test_router_integration_never_calls_deepseek(self):
        approved = self._approve_plan(self._create_plan())
        generate_mock = Mock(return_value=generation_result())
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
                self._generate_url(),
                json={"model": "test-model", "max_tokens": 1000, "temperature": 0.2, "scene_plan_id": approved["id"]},
            )

        self.assertEqual(response.status_code, 200, response.text)
        deepseek_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
