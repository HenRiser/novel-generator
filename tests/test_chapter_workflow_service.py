from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from file_manager import read_chapter, save_chapter
from project_context import create_workspace_book
from services import chapter_workflow_service as workflow


ORIGINAL = "# 第 1 章：旧标题\n\n林默走入房间，发现门窗紧闭。"
EDITED = "# 第 1 章：新标题\n\n林默走入房间。周岚还活着，正在窗前等他。"
CONTEXT = "### Hard Continuity Constraints\n- 周岚已死亡。\n### Other\n无"


class ChapterWorkflowServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.books_root = self.root / "books"
        self.ctx = create_workspace_book("工作流测试", books_root=self.books_root)
        self.ref = f"book:{self.ctx.book_id}"
        self.patch_roots = patch("file_manager.get_books_root", return_value=self.books_root)
        self.patch_roots.start()
        self.addCleanup(self.patch_roots.stop)
        self.addCleanup(self.temp.cleanup)

    def register(self, number=1, content=ORIGINAL, **kwargs):
        path = save_chapter(self.ref, number, content)
        return workflow.register_generated_chapter(self.ref, number, path, content, "test-model", **kwargs)

    def confirm(self, state, content=None):
        return workflow.confirm_chapter(self.ref, state["chapter_number"],
                                        state["content"] if content is None else content,
                                        state["revision"])

    def finish(self, state, response="林默发现房间门窗紧闭。"):
        with patch.object(workflow, "generate_text", return_value=response) as generate:
            workflow.run_confirmed_chapter_tasks(self.ref, state["chapter_number"], state["revision"])
        return workflow.get_chapter_workflow(self.ref, state["chapter_number"]), generate

    def metadata(self, number=1):
        path = self.ctx.logs_dir / "chapter_workflow" / f"chapter_{number:03d}.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def test_no_model_before_confirmation_and_pending_survives_get(self):
        with patch.object(workflow, "generate_text") as generate:
            state = self.register(narrative_context_text=CONTEXT)
            self.assertEqual(state["status"], "awaiting_confirmation")
            self.assertEqual(state["summary_status"], "not_requested")
            workflow.get_chapter_workflow(self.ref, 1)
            pending = self.confirm(state)
            self.assertEqual(pending["summary_status"], "pending")
            self.assertEqual(workflow.get_chapter_workflow(self.ref, 1)["summary_status"], "pending")
            generate.assert_not_called()

    def test_unchanged_confirmation_summarizes_exact_body_once(self):
        state = self.confirm(self.register())
        duplicate = self.confirm(state)
        self.assertEqual(state, duplicate)
        final, generate = self.finish(state)
        self.assertEqual(final["summary_status"], "ready")
        self.assertEqual(final["review_scope"], "rules_only")
        self.assertEqual(final["review_status"], "ready")
        self.assertIn(ORIGINAL, generate.call_args.kwargs["messages"][-1]["content"])
        self.assertNotIn("json_mode", generate.call_args.kwargs)
        generate.assert_called_once()
        with patch.object(workflow, "generate_text") as generate_again:
            workflow.run_confirmed_chapter_tasks(self.ref, 1, state["revision"])
            self.confirm(final)
            generate_again.assert_not_called()

    def test_edited_body_is_versioned_reviewed_and_index_title_updated(self):
        state = self.register(narrative_context_text=CONTEXT,
                              chapter_task={"status": "approved", "ending_state": "门窗紧闭"})
        pending = self.confirm(state, EDITED)
        self.assertNotEqual(pending["revision"], state["revision"])
        self.assertEqual((self.ctx.chapters_dir / state["chapter_file"]).read_text(encoding="utf-8"), ORIGINAL)
        self.assertEqual(pending["chapter_file"], "chapter_001_v2.md")
        self.assertIn("新标题", self.ctx.chapter_index_path.read_text(encoding="utf-8"))
        response = json.dumps({"summary": "林默遇见周岚。", "warnings": [{
            "code": "possible_life_state_conflict", "message": "周岚的生死状态发生冲突。",
            "constraint": "周岚已死亡。", "evidence": "周岚还活着，正在窗前等他。",
            "suggestion": "请核对该段是否为闪回。",
        }]}, ensure_ascii=False)
        final, generate = self.finish(pending, response)
        self.assertEqual(final["summary"], "林默遇见周岚。")
        self.assertEqual(final["review_scope"], "semantic_and_rules")
        self.assertEqual(final["review_status"], "ready")
        self.assertTrue(final["warnings"])
        for warning in final["warnings"]:
            self.assertIn(warning["evidence"], EDITED)
            self.assertEqual(warning["severity"], "warning")
        payload = json.loads(generate.call_args.kwargs["messages"][-1]["content"])
        self.assertTrue(generate.call_args.kwargs["json_mode"])
        self.assertEqual(payload["confirmed_chapter_text"], EDITED)
        self.assertEqual(payload["frozen_constraints"]["narrative_context_text"], CONTEXT)
        self.assertEqual(workflow.current_summary_for_context(self.ref, 1), (True, "林默遇见周岚。"))

    def test_reasonable_edit_does_not_automatically_trigger_warning(self):
        pending = self.confirm(self.register(), EDITED)
        final, _ = self.finish(pending, json.dumps({"summary": "两人会面。", "warnings": []}))
        self.assertEqual(final["warnings"], [])
        self.assertEqual(final["review_status"], "ready")

    def test_invalid_semantic_warning_types_are_not_stringified_or_claimed_as_passed(self):
        warning = {"message": "疑似矛盾", "evidence": "周岚还活着", "constraint": "已确认事实"}
        invalid_values = ["没有问题", None, [123]]
        invalid_values.extend([
            [{**warning, field: value}]
            for field, value in (("code", 1), ("message", {"bad": "object"}),
                                 ("constraint", []), ("evidence", True), ("suggestion", None))
        ])
        for warnings in invalid_values:
            with self.subTest(warnings=warnings):
                pending = self.confirm(self.register(), EDITED)
                final, _ = self.finish(pending, json.dumps({"summary": "两人会面。", "warnings": warnings}))
                self.assertEqual(final["summary_status"], "ready")
                self.assertEqual(final["review_status"], "failed")
                self.assertEqual(final["warnings"], [])

    def test_invalid_summary_type_cannot_be_saved_as_confirmed_context(self):
        for summary in (123, {}, [], None, ""):
            with self.subTest(summary=summary):
                pending = self.confirm(self.register(), EDITED)
                final, _ = self.finish(pending, json.dumps({"summary": summary, "warnings": []}))
                self.assertEqual(final["summary_status"], "failed")
                self.assertEqual(workflow.current_summary_for_context(self.ref, 1), (True, ""))
                self.assertEqual(list(self.ctx.summaries_dir.iterdir()), [])

    def test_model_warning_without_verbatim_evidence_is_not_claimed_as_passed(self):
        pending = self.confirm(self.register(), EDITED)
        response = json.dumps({"summary": "两人会面。", "warnings": [{
            "message": "疑似冲突", "evidence": "正文中不存在的证据", "constraint": "未知",
        }]})
        final, _ = self.finish(pending, response)
        self.assertEqual(final["summary_status"], "ready")
        self.assertEqual(final["review_status"], "failed")
        self.assertTrue(final["review_error"])
        self.assertEqual(final["warnings"], [])

    def test_stale_revision_cannot_overwrite_new_confirmation(self):
        state = self.register()
        self.confirm(state, EDITED)
        with self.assertRaises(workflow.WorkflowError) as caught:
            self.confirm(state, "过期编辑")
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(caught.exception.code, "revision_conflict")
        self.assertEqual(read_chapter(self.ref, 1)[0], EDITED)

    def test_stale_job_cannot_write_summary_file_or_index(self):
        pending = self.confirm(self.register())
        replacement = {}

        def replace_during_generation(**kwargs):
            replacement.update(self.confirm(workflow.get_chapter_workflow(self.ref, 1), EDITED))
            return "旧正文的过期摘要"

        with patch.object(workflow, "generate_text", side_effect=replace_during_generation):
            workflow.run_confirmed_chapter_tasks(self.ref, 1, pending["revision"])
        state = workflow.get_chapter_workflow(self.ref, 1)
        self.assertEqual(state["revision"], replacement["revision"])
        self.assertEqual(state["summary_status"], "pending")
        self.assertEqual(list(self.ctx.summaries_dir.glob("*.md")), [])
        self.assertNotIn("旧正文的过期摘要", self.ctx.chapter_index_path.read_text(encoding="utf-8"))

    def test_external_disk_edit_invalidates_completed_summary(self):
        final, _ = self.finish(self.confirm(self.register()))
        (self.ctx.chapters_dir / final["chapter_file"]).write_text(EDITED, encoding="utf-8")
        state = workflow.get_chapter_workflow(self.ref, 1)
        self.assertEqual(state["status"], "awaiting_confirmation")
        self.assertEqual(state["summary_status"], "not_requested")
        self.assertEqual(state["summary"], "")
        self.assertEqual(workflow.current_summary_for_context(self.ref, 1), (True, ""))
        with self.assertRaises(workflow.WorkflowError):
            workflow.prepare_next_chapter(self.ref, 2)

    def test_unconfirmed_and_pending_summaries_block_next_chapter(self):
        state = self.register()
        for confirm in (False, True):
            if confirm:
                state = self.confirm(state)
            with self.assertRaises(workflow.WorkflowError) as caught:
                workflow.prepare_next_chapter(self.ref, 2)
            self.assertEqual(caught.exception.code, "previous_chapter_not_ready")
            self.assertTrue(workflow.get_chapter_workflow(self.ref, 1)["editable"])

    def test_start_next_chapter_persistently_locks_previous_even_without_next_output(self):
        final, _ = self.finish(self.confirm(self.register()))
        workflow.prepare_next_chapter(self.ref, 2)
        state = workflow.get_chapter_workflow(self.ref, 1)
        self.assertFalse(state["editable"])
        self.assertEqual(state["locked_by_chapter"], 2)
        # The next generation may fail; no second chapter file is required for
        # the lock to survive subsequent requests or restarts.
        self.assertFalse(self.ctx.get_chapter_path(2).exists())
        self.assertEqual(self.metadata()["locked_by_chapter"], 2)
        with self.assertRaises(workflow.WorkflowError) as caught:
            self.confirm(final, EDITED)
        self.assertEqual(caught.exception.code, "chapter_locked")

    def test_existing_later_legacy_chapter_also_locks_untracked_history(self):
        save_chapter(self.ref, 1, ORIGINAL)
        second = save_chapter(self.ref, 2, "# 第 2 章：后续\n后文")
        with self.assertRaises(workflow.WorkflowError) as caught:
            workflow.ensure_chapter_editable(self.ref, 1)
        self.assertEqual(caught.exception.code, "chapter_locked")
        self.assertEqual(workflow.current_summary_for_context(self.ref, 1), (False, ""))
        second.unlink()
        self.assertFalse(workflow.get_chapter_workflow(self.ref, 1)["editable"])
        # Conservative lock metadata does not turn legacy chapters into newly
        # unconfirmed chapters and block all future generation.
        workflow.prepare_next_chapter(self.ref, 3)

    def test_failure_is_visible_sanitized_and_same_body_can_retry(self):
        pending = self.confirm(self.register())
        with patch.object(workflow, "generate_text", side_effect=RuntimeError("secret-api-token")):
            workflow.run_confirmed_chapter_tasks(self.ref, 1, pending["revision"])
        failed = workflow.get_chapter_workflow(self.ref, 1)
        self.assertEqual(failed["summary_status"], "failed")
        self.assertEqual(failed["review_status"], "failed")
        self.assertNotIn("secret-api-token", json.dumps(self.metadata()))
        retry = self.confirm(failed)
        final, generate = self.finish(retry)
        self.assertEqual(final["summary_status"], "ready")
        generate.assert_called_once()

    def test_restart_residue_is_failed_and_retryable(self):
        pending = self.confirm(self.register())
        job_id = self.metadata()["job_id"]
        workflow._PENDING_JOBS.discard(job_id)
        workflow._ACTIVE_JOBS.discard(job_id)
        interrupted = workflow.get_chapter_workflow(self.ref, 1)
        self.assertEqual(interrupted["summary_status"], "failed")
        self.assertEqual(interrupted["revision"], pending["revision"])
        retry = self.confirm(interrupted)
        self.assertEqual(retry["summary_status"], "pending")

    def test_worker_claim_write_failure_releases_job_and_allows_retry(self):
        pending = self.confirm(self.register())
        job_id = self.metadata()["job_id"]
        with patch.object(workflow, "_write_metadata", side_effect=OSError("mock disk failure")), \
                patch.object(workflow, "generate_text") as generate:
            with self.assertRaises(OSError):
                workflow.run_confirmed_chapter_tasks(self.ref, 1, pending["revision"])
            generate.assert_not_called()
        self.assertNotIn(job_id, workflow._ACTIVE_JOBS)
        self.assertNotIn(job_id, workflow._PENDING_JOBS)
        interrupted = workflow.get_chapter_workflow(self.ref, 1)
        self.assertEqual(interrupted["summary_status"], "failed")
        final, generate = self.finish(self.confirm(interrupted))
        self.assertEqual(final["summary_status"], "ready")
        generate.assert_called_once()

    def test_duplicate_worker_during_running_job_makes_no_extra_call(self):
        pending = self.confirm(self.register())

        def nested_worker(**kwargs):
            workflow.run_confirmed_chapter_tasks(self.ref, 1, pending["revision"])
            return "摘要"

        with patch.object(workflow, "generate_text", side_effect=nested_worker) as generate:
            workflow.run_confirmed_chapter_tasks(self.ref, 1, pending["revision"])
        generate.assert_called_once()

    def test_batch_registered_summary_is_ready_without_model(self):
        with patch.object(workflow, "generate_text") as generate:
            ready = self.register(confirmed=True, summary="批量已生成的摘要。", summary_path="chapter_001_summary.md")
            workflow.prepare_next_chapter(self.ref, 2)
            generate.assert_not_called()
        self.assertEqual(ready["summary_status"], "ready")

    def test_missing_project_and_chapter_return_404(self):
        with self.assertRaises(workflow.WorkflowError) as chapter:
            workflow.get_chapter_workflow(self.ref, 1)
        self.assertEqual(chapter.exception.status_code, 404)
        with self.assertRaises(workflow.WorkflowError) as project:
            workflow.get_chapter_workflow("book:missing", 1)
        self.assertEqual(project.exception.status_code, 404)

    def test_new_chapter_guard_allows_append_but_rejects_earlier_gap(self):
        workflow.ensure_chapter_editable(self.ref, 1)
        self.register(number=2, content="# 第 2 章：后文\n后文")
        workflow.ensure_chapter_editable(self.ref, 3)
        with self.assertRaises(workflow.WorkflowError) as caught:
            workflow.ensure_chapter_editable(self.ref, 1)
        self.assertEqual(caught.exception.code, "chapter_locked")

    def test_external_version_save_requires_new_confirmation(self):
        final, _ = self.finish(self.confirm(self.register()))
        path = save_chapter(self.ref, 1, EDITED)
        result = workflow.invalidate_after_external_edit(self.ref, 1)
        self.assertEqual(result["chapter_file"], path.name)
        self.assertEqual(result["status"], "awaiting_confirmation")
        self.assertNotEqual(result["revision"], final["revision"])
        self.assertEqual(workflow.current_summary_for_context(self.ref, 1), (True, ""))

    def test_identical_text_new_file_still_changes_revision(self):
        initial = self.register()
        save_chapter(self.ref, 1, ORIGINAL)
        current = workflow.get_chapter_workflow(self.ref, 1)
        self.assertNotEqual(initial["revision"], current["revision"])
        with self.assertRaises(workflow.WorkflowError):
            self.confirm(initial)

    def test_editing_untracked_legacy_body_still_requests_semantic_review(self):
        # The old continuation/save path has already written the new version
        # before enrolling this previously untracked chapter in the workflow.
        save_chapter(self.ref, 1, ORIGINAL)
        save_chapter(self.ref, 1, EDITED)
        invalidated = workflow.invalidate_after_external_edit(self.ref, 1)
        pending = self.confirm(invalidated)
        self.assertEqual(pending["review_scope"], "semantic_and_rules")
        final, generate = self.finish(pending, json.dumps({"summary": "两人会面。", "warnings": []}))
        self.assertEqual(final["summary_status"], "ready")
        payload = json.loads(generate.call_args.kwargs["messages"][-1]["content"])
        self.assertEqual(payload["confirmed_chapter_text"], EDITED)

    def test_true_legacy_project_uses_same_confirmation_workflow(self):
        outputs = self.root / "outputs"
        legacy = outputs / "旧项目"
        legacy.mkdir(parents=True)
        ref = "legacy:旧项目"
        with patch("file_manager.get_outputs_root", return_value=outputs):
            path = save_chapter(ref, 1, ORIGINAL)
            state = workflow.register_generated_chapter(ref, 1, path, ORIGINAL, "test-model")
            pending = workflow.confirm_chapter(ref, 1, ORIGINAL, state["revision"])
            with patch.object(workflow, "generate_text", return_value="旧项目摘要"):
                workflow.run_confirmed_chapter_tasks(ref, 1, pending["revision"])
            final = workflow.get_chapter_workflow(ref, 1)
            self.assertEqual(final["summary"], "旧项目摘要")
            self.assertTrue((legacy / "logs" / "chapter_workflow" / "chapter_001.json").exists())

    def test_missing_chapter_cannot_be_created_by_confirm(self):
        with self.assertRaises(workflow.WorkflowError) as caught:
            workflow.confirm_chapter(self.ref, 1, ORIGINAL, "missing-revision")
        self.assertEqual(caught.exception.status_code, 404)
        self.assertFalse(self.ctx.get_chapter_path(1).exists())


if __name__ == "__main__":
    unittest.main()
