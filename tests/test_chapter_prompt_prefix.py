from __future__ import annotations

import os
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from config import MAX_PREVIOUS_CHAPTER_CHARS, MAX_REFERENCE_CHARS, MAX_SUMMARIES_CHARS
from prompt_templates import build_chapter_prompt
from services.generation_service import CHAPTER_MODE, build_generation_messages
from services.prompt_profile_service import build_prompt_profile


PROJECT = {"title": "Prefix Test", "worldview": "Stable world", "word_count_range": "2000-3000"}
OUTLINE = "OUTLINE_REFERENCE_SENTINEL"
CHARACTERS = "CHARACTER_REFERENCE_SENTINEL"
SUMMARY = "### chapter_001_summary\nFIRST_CONFIRMED_SUMMARY"
PREVIOUS = "PREVIOUS_CHAPTER_SENTINEL"


class ChapterPromptPrefixTests(unittest.TestCase):
    def prompt(self, number=2, **overrides):
        values = {
            "project_config": PROJECT,
            "chapter_number": number,
            "outline": OUTLINE,
            "characters": CHARACTERS,
            "summaries": SUMMARY,
            "previous_chapter": PREVIOUS,
        }
        values.update(overrides)
        return build_chapter_prompt(**values)

    def test_chapter_number_changes_only_after_all_shared_material(self):
        first, second = self.prompt(2), self.prompt(3)
        self.assertEqual([item["role"] for item in first], ["system", "user"])
        self.assertEqual(first[0], second[0])
        shared = os.path.commonprefix([first[1]["content"], second[1]["content"]])
        for value in (OUTLINE, CHARACTERS, SUMMARY, PREVIOUS, "## 正文要求", "## 正文格式要求"):
            self.assertIn(value, shared)
        for number, messages in ((2, first), (3, second)):
            self.assertIn(f"## 章节编号\n第 {number} 章", messages[1]["content"])
            self.assertIn(f"# 第 {number} 章：贴合本章内容的章节标题", messages[1]["content"])

    def test_all_fixed_rules_precede_changing_narrative_context(self):
        text = self.prompt()[1]["content"]
        rules = text[:text.index(OUTLINE)]
        for value in (
            "Prompt Authority Order", "Hard Continuity Constraints always win",
            "必须以 Markdown 一级标题开头", "标题与正文之间空一行",
            "不要输出“（待定标题）”", "## 正文要求",
            "15. Historical Planning Reference",
        ):
            self.assertIn(value, rules)
        authority = text[text.index("## Prompt Authority Order"):text.index("Hard Continuity Constraints always win")]
        expected_order = (
            "1. Hard Continuity Constraints", "2. Approved Chapter Task Sheet",
            "3. Derived Allowed Scene Contract", "4. Current Narrative Context",
            "5. Previous Chapter", "6. Historical Planning References",
        )
        positions = [authority.index(item) for item in expected_order]
        self.assertEqual(positions, sorted(positions))

    def test_changed_reference_content_is_never_reused_as_stale_text(self):
        old = self.prompt()[1]["content"]
        for field, original in (("outline", OUTLINE), ("characters", CHARACTERS)):
            with self.subTest(field=field):
                replacement = f"REVISED_{field.upper()}"
                new = self.prompt(**{field: replacement})[1]["content"]
                self.assertIn(replacement, new)
                self.assertNotIn(original, new)
                self.assertNotEqual(old, new)
        new = self.prompt(project_config={**PROJECT, "worldview": "Revised world"})[1]["content"]
        self.assertIn("Revised world", new)
        self.assertNotIn("Stable world", new)

    def test_reference_budgets_and_previous_chapter_tail_are_preserved(self):
        text = self.prompt(
            outline="O" * MAX_REFERENCE_CHARS + "DROPPED_OUTLINE_END",
            characters="C" * MAX_REFERENCE_CHARS + "DROPPED_CHARACTERS_END",
            summaries="S" * MAX_SUMMARIES_CHARS + "DROPPED_SUMMARY_END",
            previous_chapter="DROPPED_PREVIOUS_START" + "P" * MAX_PREVIOUS_CHAPTER_CHARS + "PREVIOUS_END",
        )[1]["content"]
        for value, size in (("O", MAX_REFERENCE_CHARS), ("C", MAX_REFERENCE_CHARS), ("S", MAX_SUMMARIES_CHARS)):
            self.assertIn(value * size + "\n...", text)
            self.assertNotIn(value * (size + 1), text)
        self.assertIn("## Previous Chapter\n...\n", text)
        self.assertIn("PREVIOUS_END", text)
        self.assertNotIn("DROPPED_", text)

    def test_first_chapter_without_optional_context_keeps_output_requirements(self):
        messages = build_chapter_prompt({}, 0)
        self.assertEqual(len(messages), 2)
        text = messages[1]["content"]
        self.assertIn("暂无额外上下文。", text)
        self.assertIn("## 章节编号\n第 1 章", text)
        self.assertIn("必须以 Markdown 一级标题开头", text)
        self.assertIn("## 正文要求", text)

    def test_profile_identifies_new_template_and_fingerprints_the_full_request(self):
        first = build_prompt_profile("chapter_generation", self.prompt(2))
        second = build_prompt_profile("chapter_generation", self.prompt(3))
        self.assertEqual(first["profile_id"], "chapter_generation_v2")
        self.assertEqual(first["template_version"], "v2")
        self.assertEqual(first["prompt_hash"], build_prompt_profile("chapter_generation", self.prompt(2))["prompt_hash"])
        self.assertNotEqual(first["prompt_hash"], second["prompt_hash"])


class GenerationMessagePrefixTests(unittest.TestCase):
    def setUp(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        self.outline = stack.enter_context(patch("services.generation_service.read_latest_outline", return_value=(OUTLINE, Path("outline.md"))))
        self.characters = stack.enter_context(patch("services.generation_service.read_latest_characters", return_value=(CHARACTERS, Path("characters.md"))))
        self.summaries = stack.enter_context(patch("services.generation_service.read_history_summaries", return_value=SUMMARY))
        self.previous = stack.enter_context(patch("services.generation_service.read_previous_chapter", return_value=(PREVIOUS, Path("chapter_001.md"))))

    def build(self, number, **overrides):
        return build_generation_messages(
            project_ref="book:prefix-test", mode=CHAPTER_MODE,
            project_config=PROJECT, chapter_number=number,
            use_previous_context=overrides.pop("use_previous_context", True), **overrides,
        )

    def test_adjacent_chapters_share_rules_references_and_existing_summaries(self):
        first, _ = self.build(2)
        self.summaries.return_value = SUMMARY + "\n\n### chapter_002_summary\nNEW_CONFIRMED_SUMMARY"
        self.previous.return_value = ("NEW_PREVIOUS_CHAPTER", Path("chapter_002.md"))
        second, _ = self.build(3)
        shared = os.path.commonprefix([first[1]["content"], second[1]["content"]])
        for value in ("## 正文要求", "## 正文格式要求", OUTLINE, CHARACTERS, SUMMARY):
            self.assertIn(value, shared)
        self.assertIn("NEW_CONFIRMED_SUMMARY", second[1]["content"])
        self.assertIn("NEW_PREVIOUS_CHAPTER", second[1]["content"])
        self.assertNotIn(PREVIOUS, second[1]["content"])
        self.summaries.assert_called_with("book:prefix-test", before_chapter=3)
        self.previous.assert_called_with("book:prefix-test", 3)

    def test_approved_constraints_remain_in_dynamic_tail_with_unchanged_authority(self):
        messages, _ = self.build(
            2,
            narrative_context_text="### Hard Continuity Constraints\nKEEP_CONFIRMED_FACT",
            chapter_task={"status": "approved", "id": "TASK_SENTINEL", "chapter_number": 2, "revision": 1},
            allowed_scene_contract="### Derived Allowed Scene Contract\nCONTRACT_SENTINEL",
            scene_plan={"status": "approved", "id": "SCENE_SENTINEL", "chapter_number": 2, "revision": 1, "scenes": []},
        )
        text = messages[1]["content"]
        boundary = text.index("## 章节编号")
        for value in ("KEEP_CONFIRMED_FACT", "TASK_SENTINEL", "CONTRACT_SENTINEL", "SCENE_SENTINEL", "Do not add extra scenes"):
            self.assertGreater(text.index(value), boundary)
        self.assertIn("Hard Continuity Constraints always win", text[:boundary])
        self.assertIn("Historical planning references may be stale", text[:boundary])

    def test_drafts_stay_out_and_legacy_low_intensity_constraint_is_preserved(self):
        messages, _ = self.build(
            2, use_previous_context=False,
            narrative_context_text="Chapter goal: low-intensity emotional aftermath with no new canon",
            chapter_task={"status": "draft", "id": "DRAFT_TASK_SENTINEL"},
            allowed_scene_contract="DRAFT_CONTRACT_SENTINEL",
            scene_plan={"status": "draft", "id": "DRAFT_SCENE_SENTINEL"},
        )
        text = messages[1]["content"]
        self.assertIn("Low-Intensity Chapter Constraints", text)
        self.assertNotIn("DRAFT_", text)
        self.assertNotIn(PREVIOUS, text)
        self.assertIn(SUMMARY, text)
        self.previous.assert_not_called()


if __name__ == "__main__":
    unittest.main()
