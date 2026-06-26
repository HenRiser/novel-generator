from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from project_context import create_workspace_book
from services.ai_run_service import create_ai_run_record
from services.chapter_task_service import (
    TASK_SHEETS_NAME,
    approve_chapter_task,
    derive_allowed_scene_contract,
    get_chapter_tasks,
    resolve_approved_chapter_task,
    save_chapter_task_draft,
)
from services.generation_service import (
    CHAPTER_MODE,
    _chapter_ai_run_metadata,
    build_generation_messages,
)


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


class ChapterTaskServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.books_root = Path(self.temp_dir.name) / "books"
        self.first = create_workspace_book("First", books_root=self.books_root)
        self.second = create_workspace_book("Second", books_root=self.books_root)
        self.first_ref = f"book:{self.first.book_id}"
        self.second_ref = f"book:{self.second.book_id}"

    def tearDown(self):
        self.temp_dir.cleanup()

    def save(self, project_ref=None, chapter_number=1, payload=None):
        return save_chapter_task_draft(
            project_ref or self.first_ref,
            chapter_number,
            payload or task_payload(),
            books_root=self.books_root,
        )

    def approve(self, result, project_ref=None, chapter_number=1):
        return approve_chapter_task(
            project_ref or self.first_ref,
            chapter_number,
            task_id=result.task["id"],
            revision=result.task["revision"],
            books_root=self.books_root,
        )

    def test_create_task_draft(self):
        result = self.save()

        self.assertTrue(result.ok)
        self.assertEqual(result.task["status"], "draft")
        self.assertEqual(result.task["revision"], 1)
        self.assertEqual(result.task["chapter_number"], 1)
        self.assertTrue((self.first.project_dir / "planning" / TASK_SHEETS_NAME).exists())

    def test_update_existing_draft_in_place(self):
        created = self.save()
        updated = self.save(payload=task_payload(notes="更新后的备注"))

        self.assertTrue(updated.ok)
        self.assertEqual(updated.task["id"], created.task["id"])
        self.assertEqual(updated.task["revision"], 1)
        self.assertEqual(updated.task["notes"], "更新后的备注")
        self.assertEqual(len(updated.history), 1)

    def test_approve_draft(self):
        approved = self.approve(self.save())

        self.assertTrue(approved.ok)
        self.assertEqual(approved.task["status"], "approved")
        self.assertIsNotNone(approved.task["approved_at"])
        self.assertIsNone(approved.latest_draft)

    def test_approved_revision_is_not_overwritten(self):
        approved = self.approve(self.save())
        new_draft = self.save(payload=task_payload(notes="revision two"))
        loaded = get_chapter_tasks(self.first_ref, 1, books_root=self.books_root)

        self.assertTrue(new_draft.ok)
        self.assertEqual(new_draft.task["revision"], 2)
        self.assertEqual(loaded.approved["revision"], approved.task["revision"])
        self.assertEqual(loaded.approved["notes"], "保持低强度")
        self.assertEqual(loaded.latest_draft["notes"], "revision two")

    def test_edit_approved_creates_new_draft_revision(self):
        first = self.approve(self.save())
        second = self.save(payload=task_payload(intensity="medium", canon_budget="minor"))

        self.assertEqual(second.task["id"], first.task["id"])
        self.assertEqual(second.task["revision"], 2)
        self.assertEqual(second.task["status"], "draft")
        self.assertEqual(second.approved["revision"], 1)

    def test_approving_new_revision_supersedes_old_approved(self):
        first = self.approve(self.save())
        second_draft = self.save(payload=task_payload(notes="new revision"))
        second = self.approve(second_draft)

        history = second.history
        old = next(task for task in history if task["revision"] == first.task["revision"])
        current = next(task for task in history if task["revision"] == second_draft.task["revision"])
        self.assertEqual(old["status"], "superseded")
        self.assertIsNotNone(old["superseded_at"])
        self.assertEqual(current["status"], "approved")

    def test_each_chapter_has_at_most_one_approved_revision(self):
        self.approve(self.save())
        self.approve(self.save(payload=task_payload(notes="second")))
        loaded = get_chapter_tasks(self.first_ref, 1, books_root=self.books_root)

        approved = [task for task in loaded.history if task["status"] == "approved"]
        self.assertEqual(len(approved), 1)
        self.assertEqual(approved[0]["revision"], 2)

    def test_cross_chapter_task_id_is_rejected(self):
        approved = self.approve(self.save())
        result = resolve_approved_chapter_task(
            self.first_ref,
            2,
            task_id=approved.task["id"],
            books_root=self.books_root,
        )

        self.assertFalse(result.ok)
        self.assertEqual(result.error_code, "chapter_task_not_found")

    def test_cross_project_task_id_is_rejected(self):
        approved = self.approve(self.save())
        result = resolve_approved_chapter_task(
            self.second_ref,
            1,
            task_id=approved.task["id"],
            books_root=self.books_root,
        )

        self.assertFalse(result.ok)
        self.assertEqual(result.error_code, "chapter_task_not_found")

    def test_invalid_enum_is_rejected(self):
        result = self.save(payload=task_payload(intensity="quiet"))

        self.assertFalse(result.ok)
        self.assertEqual(result.error_code, "chapter_task_invalid")

    def test_none_budget_rejects_primary_information_reveal(self):
        result = self.save(payload=task_payload(primary_function="information_reveal"))

        self.assertFalse(result.ok)
        self.assertIn("primary_function 'information_reveal'", result.message)
        self.assertIn("canon_budget 'none'", result.message)
        self.assertIn("raise canon_budget", result.message)

    def test_none_budget_rejects_secondary_information_reveal(self):
        result = self.save(
            payload=task_payload(secondary_functions=["relationship_progress", "information_reveal"])
        )

        self.assertFalse(result.ok)
        self.assertIn("secondary_functions", result.message)
        self.assertIn("information_reveal", result.message)

    def test_none_budget_rejects_primary_foreshadowing_setup(self):
        result = self.save(payload=task_payload(primary_function="foreshadowing_setup"))

        self.assertFalse(result.ok)
        self.assertIn("foreshadowing_setup", result.message)
        self.assertIn("canon_budget 'none'", result.message)

    def test_none_budget_rejects_secondary_foreshadowing_setup(self):
        result = self.save(
            payload=task_payload(secondary_functions=["relationship_progress", "foreshadowing_setup"])
        )

        self.assertFalse(result.ok)
        self.assertIn("secondary_functions", result.message)
        self.assertIn("foreshadowing_setup", result.message)

    def test_none_budget_allows_foreshadowing_payoff(self):
        result = self.save(
            payload=task_payload(
                primary_function="foreshadowing_payoff",
                secondary_functions=["emotional_aftermath"],
            )
        )

        self.assertTrue(result.ok)

    def test_none_budget_payoff_contract_contains_specific_boundary(self):
        draft = self.save(
            payload=task_payload(
                primary_function="foreshadowing_payoff",
                secondary_functions=["emotional_aftermath"],
            )
        )
        approved = self.approve(draft).task
        contract = derive_allowed_scene_contract(approved)

        self.assertIn("伏笔回收只能兑现已经确认的信息所产生的关系、情绪或现实后果", contract)
        self.assertIn("不得揭示新的正典事实、身份、因果、证据或终局答案", contract)
        self.assertIn("零新正典", contract)

    def test_primary_function_cannot_repeat_in_secondary_functions(self):
        result = self.save(
            payload=task_payload(
                primary_function="emotional_aftermath",
                secondary_functions=["relationship_progress", "emotional_aftermath"],
            )
        )

        self.assertFalse(result.ok)
        self.assertIn("secondary_functions cannot contain primary_function", result.message)

    def test_allowed_and_forbidden_advance_conflict_is_rejected(self):
        result = self.save(
            payload=task_payload(
                allowed_advances=["恢复有限信任"],
                forbidden_advances=[" 恢复有限信任 "],
            )
        )

        self.assertFalse(result.ok)
        self.assertIn("恢复有限信任", result.message)

    def test_english_case_only_advance_conflict_is_rejected(self):
        result = self.save(
            payload=task_payload(
                allowed_advances=["Reveal Existing Consequence"],
                forbidden_advances=["reveal existing consequence"],
            )
        )

        self.assertFalse(result.ok)
        self.assertIn("Reveal Existing Consequence", result.message)

    def test_reading_existing_inconsistent_json_fails(self):
        created = self.save()
        path = self.first.project_dir / "planning" / TASK_SHEETS_NAME
        document = json.loads(path.read_text(encoding="utf-8"))
        document["tasks"][0]["primary_function"] = "information_reveal"
        path.write_text(json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8")

        result = get_chapter_tasks(self.first_ref, 1, books_root=self.books_root)

        self.assertFalse(result.ok)
        self.assertEqual(result.error_code, "chapter_task_read_failed")
        self.assertIn("invalid task contract", result.message)
        self.assertIn("information_reveal", result.message)
        self.assertEqual(created.task["canon_budget"], "none")

    def test_valid_low_none_emotional_aftermath_remains_supported(self):
        result = self.save()

        self.assertTrue(result.ok)
        approved = self.approve(result).task
        contract = derive_allowed_scene_contract(approved)
        self.assertIn("允许推进关系、情绪、选择", contract)
        self.assertIn("揭示新的正典事实、身份、因果、证据或终局答案", contract)

    def test_invalid_status_is_rejected(self):
        result = self.save(payload=task_payload(status="approved"))

        self.assertFalse(result.ok)
        self.assertEqual(result.error_code, "chapter_task_invalid")

    def test_foreign_task_id_cannot_create_a_new_chapter_draft(self):
        approved = self.approve(self.save())
        result = self.save(chapter_number=2, payload=task_payload(id=approved.task["id"]))

        self.assertFalse(result.ok)
        self.assertEqual(result.error_code, "chapter_task_not_found")

    @patch("services.generation_service.read_history_summaries", return_value="")
    @patch("services.generation_service.read_previous_chapter", return_value=(None, None))
    @patch("services.generation_service.read_latest_characters", return_value=(None, None))
    @patch("services.generation_service.read_latest_outline", return_value=(None, None))
    def test_draft_does_not_enter_generation_messages(self, *_mocks):
        draft = self.save().task
        messages, _ = build_generation_messages(
            project_ref=self.first_ref,
            mode=CHAPTER_MODE,
            project_config={"title": "Test"},
            chapter_number=1,
            use_previous_context=False,
            chapter_task=draft,
            allowed_scene_contract="SHOULD_NOT_APPEAR",
        )
        text = "\n".join(message["content"] for message in messages)

        self.assertNotIn("### Approved Chapter Task Sheet", text)
        self.assertNotIn("SHOULD_NOT_APPEAR", text)

    @patch("services.generation_service.read_history_summaries", return_value="")
    @patch("services.generation_service.read_previous_chapter", return_value=(None, None))
    @patch("services.generation_service.read_latest_characters", return_value=(None, None))
    @patch("services.generation_service.read_latest_outline", return_value=(None, None))
    def test_approved_task_enters_generation_messages(self, *_mocks):
        approved = self.approve(self.save()).task
        contract = derive_allowed_scene_contract(approved)
        messages, _ = build_generation_messages(
            project_ref=self.first_ref,
            mode=CHAPTER_MODE,
            project_config={"title": "Test"},
            chapter_number=1,
            use_previous_context=False,
            chapter_task=approved,
            allowed_scene_contract=contract,
        )
        text = "\n".join(message["content"] for message in messages)

        self.assertIn("Approved Chapter Task Sheet", text)
        self.assertIn(approved["id"], text)
        self.assertIn("Derived Allowed Scene Contract", text)
        self.assertIn("Hard Continuity Constraints", text)
        self.assertIn("Historical Planning References", text)

    def test_low_intensity_none_contract_contains_positive_scene_drivers(self):
        approved = self.approve(self.save()).task
        contract = derive_allowed_scene_contract(approved)

        self.assertIn("人物低强度对话", contract)
        self.assertIn("情绪消化", contract)
        self.assertIn("一个不释放新正典的小决定", contract)
        self.assertIn("厨房对话", contract)

    def test_low_intensity_none_contract_forbids_material_interpretation(self):
        approved = self.approve(self.save()).task
        contract = derive_allowed_scene_contract(approved)

        self.assertIn("阅读或解码材料", contract)
        self.assertIn("打开档案", contract)
        self.assertIn("从既有材料中释放新的正典信息", contract)
        self.assertIn("查阅旧案卷", contract)

    @patch("services.generation_service.read_history_summaries", return_value="")
    @patch("services.generation_service.read_previous_chapter", return_value=(None, None))
    @patch("services.generation_service.read_latest_characters", return_value=(None, None))
    @patch("services.generation_service.read_latest_outline", return_value=(None, None))
    def test_generation_without_task_keeps_legacy_low_intensity_fallback(self, *_mocks):
        context = "Chapter goal: low-intensity emotional aftermath with no new canon"
        messages, _ = build_generation_messages(
            project_ref=self.first_ref,
            mode=CHAPTER_MODE,
            project_config={"title": "Test"},
            chapter_number=1,
            use_previous_context=False,
            narrative_context_text=context,
        )
        text = "\n".join(message["content"] for message in messages)

        self.assertIn("Low-Intensity Chapter Constraints", text)
        self.assertNotIn("### Approved Chapter Task Sheet", text)

    def test_ai_run_metadata_contains_task_provenance(self):
        approved = self.approve(self.save()).task
        metadata = _chapter_ai_run_metadata(
            [{"role": "user", "content": "test"}],
            0.7,
            4000,
            True,
            "context",
            approved,
            "planning/chapter_task_sheets.json",
        )
        provenance = metadata["context"]["metadata"]

        self.assertEqual(provenance["chapter_task_sheet_id"], approved["id"])
        self.assertEqual(provenance["chapter_task_revision"], approved["revision"])
        self.assertEqual(provenance["chapter_task_status"], "approved")
        self.assertEqual(provenance["chapter_task_sheet_path"], "planning/chapter_task_sheets.json")

    @patch("services.ai_run_service.resolve_project_context")
    def test_ai_run_record_preserves_task_provenance(self, resolve_context):
        resolve_context.return_value = self.first
        approved = self.approve(self.save()).task
        metadata = _chapter_ai_run_metadata(
            [{"role": "user", "content": "test"}],
            0.7,
            4000,
            True,
            "context",
            approved,
            "planning/chapter_task_sheets.json",
        )
        result = create_ai_run_record(
            project_ref=self.first_ref,
            run_type="chapter_generation",
            chapter_number=1,
            model="test-model",
            temperature=0.7,
            max_tokens=4000,
            prompt_profile={},
            context=metadata["context"],
            result={"status": "success"},
        )

        self.assertTrue(result.ok)
        provenance = result.run["context"]["metadata"]
        self.assertEqual(provenance["chapter_task_sheet_id"], approved["id"])
        self.assertEqual(provenance["chapter_task_revision"], approved["revision"])
        self.assertEqual(provenance["chapter_task_status"], "approved")


if __name__ == "__main__":
    unittest.main()
