from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from project_context import create_workspace_book
from services.chapter_task_service import approve_chapter_task, save_chapter_task_draft
from services.scene_plan_service import (
    approve_scene_plan,
    format_approved_scene_plan_for_prompt,
    get_scene_plans,
    resolve_approved_scene_plan,
    save_scene_plan_draft,
)
from services.generation_service import _chapter_ai_run_metadata, build_generation_messages


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


def scene_plan_payload(**overrides):
    payload = {
        "scenes": [scene(1), scene(2)],
    }
    payload.update(overrides)
    return payload


class ScenePlanServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.books_root = Path(self.temp_dir.name) / "books"
        self.book = create_workspace_book("Scene Plan Test", books_root=self.books_root)
        self.project_ref = f"book:{self.book.book_id}"

    def tearDown(self):
        self.temp_dir.cleanup()

    def _create_task(self, **overrides):
        result = save_chapter_task_draft(
            self.project_ref,
            1,
            task_payload(**overrides),
            books_root=self.books_root,
        )
        self.assertTrue(result.ok, result.message)
        return result.latest_draft

    def _approve_task(self, draft):
        result = approve_chapter_task(
            self.project_ref,
            1,
            task_id=draft["id"],
            revision=draft["revision"],
            books_root=self.books_root,
        )
        self.assertTrue(result.ok, result.message)
        return result.approved

    def _create_plan(self, chapter_number: int = 1, **overrides):
        result = save_scene_plan_draft(
            self.project_ref,
            chapter_number,
            scene_plan_payload(**overrides),
            books_root=self.books_root,
        )
        self.assertTrue(result.ok, result.message)
        return result.latest_draft

    def _approve_plan(self, draft, chapter_number: int = 1):
        result = approve_scene_plan(
            self.project_ref,
            chapter_number,
            scene_plan_id=draft["id"],
            revision=draft["revision"],
            books_root=self.books_root,
        )
        self.assertTrue(result.ok, result.message)
        return result.approved

    def test_create_draft_revision_one(self):
        draft = self._create_plan()

        self.assertEqual(draft["revision"], 1)
        self.assertEqual(draft["status"], "draft")
        self.assertEqual(len(draft["scenes"]), 2)

    def test_update_existing_draft(self):
        draft = self._create_plan()
        result = save_scene_plan_draft(
            self.project_ref,
            1,
            scene_plan_payload(id=draft["id"], revision=draft["revision"], scenes=[scene(1, title="新标题"), scene(2)]),
            books_root=self.books_root,
        )

        self.assertTrue(result.ok, result.message)
        self.assertEqual(result.latest_draft["revision"], 1)
        self.assertEqual(result.latest_draft["scenes"][0]["title"], "新标题")

    def test_editing_approved_creates_next_draft_without_overwriting_approved(self):
        approved = self._approve_plan(self._create_plan())

        result = save_scene_plan_draft(
            self.project_ref,
            1,
            scene_plan_payload(id=approved["id"], scenes=[scene(1, title="修订场景"), scene(2)]),
            books_root=self.books_root,
        )

        self.assertTrue(result.ok, result.message)
        self.assertEqual(result.approved["revision"], 1)
        self.assertEqual(result.latest_draft["revision"], 2)
        self.assertNotEqual(result.latest_draft["id"], approved["id"])
        self.assertEqual(result.approved["scenes"][0]["title"], "场景 1")

    def test_only_one_approved_per_chapter(self):
        first = self._approve_plan(self._create_plan())
        second_draft = self._create_plan(scenes=[scene(1, title="第二版"), scene(2)])
        second = self._approve_plan(second_draft)

        loaded = get_scene_plans(self.project_ref, 1, books_root=self.books_root)

        self.assertTrue(loaded.ok, loaded.message)
        approved_items = [item for item in loaded.history if item["status"] == "approved"]
        self.assertEqual(len(approved_items), 1)
        self.assertEqual(approved_items[0]["id"], second["id"])
        self.assertNotEqual(first["id"], second["id"])

    def test_approve_supersedes_old_approved_atomically(self):
        first = self._approve_plan(self._create_plan())
        second = self._approve_plan(self._create_plan(scenes=[scene(1, title="第二版"), scene(2)]))

        loaded = get_scene_plans(self.project_ref, 1, books_root=self.books_root)
        statuses = {item["id"]: item["status"] for item in loaded.history}

        self.assertEqual(statuses[first["id"]], "superseded")
        self.assertEqual(statuses[second["id"]], "approved")

    def test_draft_cannot_be_used_for_generation(self):
        draft = self._create_plan()

        result = resolve_approved_scene_plan(
            self.project_ref,
            1,
            scene_plan_id=draft["id"],
            books_root=self.books_root,
        )

        self.assertFalse(result.ok)
        self.assertEqual(result.error_code, "scene_plan_not_approved")

    def test_superseded_cannot_be_used_for_generation(self):
        first = self._approve_plan(self._create_plan())
        self._approve_plan(self._create_plan(scenes=[scene(1, title="第二版"), scene(2)]))

        result = resolve_approved_scene_plan(
            self.project_ref,
            1,
            scene_plan_id=first["id"],
            books_root=self.books_root,
        )

        self.assertFalse(result.ok)
        self.assertEqual(result.error_code, "scene_plan_not_approved")

    def test_cross_chapter_id_is_rejected(self):
        approved = self._approve_plan(self._create_plan(chapter_number=1), chapter_number=1)

        result = resolve_approved_scene_plan(
            self.project_ref,
            2,
            scene_plan_id=approved["id"],
            books_root=self.books_root,
        )

        self.assertFalse(result.ok)
        self.assertEqual(result.error_code, "scene_plan_not_found")

    def test_scene_count_less_than_two_is_rejected(self):
        result = save_scene_plan_draft(
            self.project_ref,
            1,
            scene_plan_payload(scenes=[scene(1)]),
            books_root=self.books_root,
        )

        self.assertFalse(result.ok)
        self.assertIn("2 to 4", result.message)

    def test_scene_count_more_than_four_is_rejected(self):
        result = save_scene_plan_draft(
            self.project_ref,
            1,
            scene_plan_payload(scenes=[scene(1), scene(2), scene(3), scene(4), scene(5)]),
            books_root=self.books_root,
        )

        self.assertFalse(result.ok)
        self.assertIn("2 to 4", result.message)

    def test_non_continuous_scene_no_is_rejected(self):
        result = save_scene_plan_draft(
            self.project_ref,
            1,
            scene_plan_payload(scenes=[scene(1), scene(3)]),
            books_root=self.books_root,
        )

        self.assertFalse(result.ok)
        self.assertIn("continuously", result.message)

    def test_empty_participants_are_rejected(self):
        result = save_scene_plan_draft(
            self.project_ref,
            1,
            scene_plan_payload(scenes=[scene(1, participants=[]), scene(2)]),
            books_root=self.books_root,
        )

        self.assertFalse(result.ok)
        self.assertIn("participants", result.message)

    def test_empty_allowed_or_forbidden_information_is_rejected(self):
        result = save_scene_plan_draft(
            self.project_ref,
            1,
            scene_plan_payload(scenes=[scene(1, allowed_information=[]), scene(2)]),
            books_root=self.books_root,
        )
        self.assertFalse(result.ok)
        self.assertIn("allowed_information", result.message)

        result = save_scene_plan_draft(
            self.project_ref,
            1,
            scene_plan_payload(scenes=[scene(1, forbidden_information=[]), scene(2)]),
            books_root=self.books_root,
        )
        self.assertFalse(result.ok)
        self.assertIn("forbidden_information", result.message)

    def test_canon_budget_none_rejects_reveal_scene_functions(self):
        task = self._approve_task(self._create_task())
        result = save_scene_plan_draft(
            self.project_ref,
            1,
            scene_plan_payload(
                source_chapter_task_id=task["id"],
                source_chapter_task_revision=task["revision"],
                scenes=[scene(1, scene_function="information_reveal"), scene(2)],
            ),
            books_root=self.books_root,
        )

        self.assertFalse(result.ok)
        self.assertIn("canon_budget 'none'", result.message)

    def test_scene_plan_binding_draft_task_is_rejected(self):
        task = self._create_task()

        result = save_scene_plan_draft(
            self.project_ref,
            1,
            scene_plan_payload(source_chapter_task_id=task["id"], source_chapter_task_revision=task["revision"]),
            books_root=self.books_root,
        )

        self.assertFalse(result.ok)
        self.assertIn("draft Chapter Task", result.message)

    def test_scene_plan_binding_superseded_task_is_rejected(self):
        first = self._approve_task(self._create_task())
        second_draft = save_chapter_task_draft(
            self.project_ref,
            1,
            task_payload(ending_state="第二版"),
            books_root=self.books_root,
        ).latest_draft
        self._approve_task(second_draft)

        result = save_scene_plan_draft(
            self.project_ref,
            1,
            scene_plan_payload(source_chapter_task_id=first["id"], source_chapter_task_revision=first["revision"]),
            books_root=self.books_root,
        )

        self.assertFalse(result.ok)
        self.assertIn("superseded Chapter Task", result.message)

    def test_scene_plan_reversing_task_advances_is_rejected(self):
        task = self._approve_task(self._create_task())

        result = save_scene_plan_draft(
            self.project_ref,
            1,
            scene_plan_payload(
                source_chapter_task_id=task["id"],
                source_chapter_task_revision=task["revision"],
                scenes=[scene(1, allowed_information=["揭示组织秘密"]), scene(2)],
            ),
            books_root=self.books_root,
        )

        self.assertFalse(result.ok)
        self.assertIn("forbidden_advances", result.message)

        result = save_scene_plan_draft(
            self.project_ref,
            1,
            scene_plan_payload(
                source_chapter_task_id=task["id"],
                source_chapter_task_revision=task["revision"],
                scenes=[scene(1, forbidden_information=["恢复有限信任", "不释放新正典信息"]), scene(2)],
            ),
            books_root=self.books_root,
        )

        self.assertFalse(result.ok)
        self.assertIn("allowed_advances", result.message)

    def test_approved_scene_plan_formats_for_prompt(self):
        approved = self._approve_plan(self._create_plan())

        prompt = format_approved_scene_plan_for_prompt(approved)

        self.assertIn("Approved Scene Plan", prompt)
        self.assertIn("Do not add extra scenes", prompt)
        self.assertIn("Scene 1", prompt)

    def test_approved_scene_plan_enters_generation_messages(self):
        approved = self._approve_plan(self._create_plan())

        messages, notices = build_generation_messages(
            project_ref="",
            mode="chapter",
            project_config={"title": "Scene Plan Test"},
            chapter_number=1,
            use_previous_context=False,
            scene_plan=approved,
        )

        joined = "\n".join(message["content"] for message in messages)
        self.assertIn("Approved Scene Plan", joined)
        self.assertIn("Do not add extra scenes", joined)
        self.assertTrue(any("Loaded approved Scene Plan" in notice for notice in notices))

    def test_ai_run_metadata_contains_scene_plan_provenance(self):
        approved = self._approve_plan(self._create_plan())

        metadata = _chapter_ai_run_metadata(
            messages=[{"role": "user", "content": "test"}],
            temperature=0.2,
            max_tokens=1000,
            use_previous_context=True,
            narrative_context_text="context",
            scene_plan=approved,
            scene_plan_relative_path="planning/scene_plans.json",
        )

        provenance = metadata["context"]["metadata"]
        self.assertEqual(provenance["scene_plan_id"], approved["id"])
        self.assertEqual(provenance["scene_plan_revision"], approved["revision"])
        self.assertEqual(provenance["scene_plan_status"], "approved")
        self.assertEqual(provenance["scene_plan_path"], "planning/scene_plans.json")


if __name__ == "__main__":
    unittest.main()
