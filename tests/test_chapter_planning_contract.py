from __future__ import annotations

import copy
import unittest
from types import SimpleNamespace

from services.chapter_planning_contract import filter_planning_graph, validate_candidate, validate_input
from services.scene_plan_service import _validate_plan_against_task, validate_scene_constraints


def constraints(**changes):
    return {"canon_budget": "none", "required_characters": ["林默", "周岚"],
            "forbidden_advances": ["揭示组织秘密"], **changes}


def candidate():
    task = {
        "primary_function": "emotional_aftermath", "secondary_functions": ["relationship_progress"],
        "intensity": "low", "canon_budget": "none", "must_carry": ["承接争执"],
        "allowed_advances": ["恢复有限信任"], "forbidden_advances": ["揭示组织秘密"],
        "required_characters": ["林默", "周岚"], "relationship_goal": "继续同行", "decision_goal": "回家休整",
        "allowed_scene_types": ["低强度对话"], "forbidden_scene_drivers": ["查阅旧档案"],
        "ending_state": "脆弱共识", "notes": "保持低强度",
    }
    scenes = [{"scene_no": number, "title": f"场景 {number}", "location": "厨房", "participants": ["林默", "周岚"],
               "scene_function": "relationship_dialogue", "allowed_information": ["恢复有限信任"],
               "forbidden_information": ["不释放新正典信息"], "emotional_shift": "暂时信任", "ending_state": "共同休整"}
              for number in (1, 2)]
    return {"task_payload": task, "scene_proposal": {"scenes": scenes}}


def node(identifier, source=None, **changes):
    record = {"id": identifier, "type": "character", "label": identifier, "summary": "已知事实",
              "importance": 8, "status": "active", "aliases": [], "tags": [], "properties": {}, "notes": ""}
    if source is not None:
        record["source"] = source
    return {**record, **changes}


def document(nodes=None, edges=None):
    return {"version": 1, "metadata": {"future_secret": "未来真相"},
            "tag_registry": {"ending": {"description": "未来真相"}},
            "graph": {"nodes": nodes or [], "edges": edges or [], "archive": "不应上传"}}


def planning_input():
    return {"project_ref": "book:bk_test", "chapter_number": 2,
            "prefix": [{"chapter_number": 1, "revision": "revision-1", "status": "confirmed",
                        "summary_status": "ready", "summary": "两人争执", "content": "上一章已确认正文"}],
            "author_intent": "让两人恢复有限信任", "constraints": constraints(),
            "setting": {field: "设定" for field in ("protagonist", "supporting_characters", "worldview", "core_conflict", "genre", "style")},
            "graph": document(), "excluded_records": 0}


class PlanningCandidateTests(unittest.TestCase):
    def test_information_conflicts_are_local_to_each_scene(self):
        proposal = candidate()
        first, second = proposal["scene_proposal"]["scenes"]
        first["allowed_information"].append("发现备用钥匙")
        second["forbidden_information"].append("发现备用钥匙")
        self.assertEqual(validate_candidate(proposal, constraints())["issues"], [])
        first["forbidden_information"].append("发现备用钥匙")
        self.assertIn("scene_task_conflict", [issue["code"] for issue in validate_candidate(proposal, constraints())["issues"]])
        self.assertIn("forbidden_information", _validate_plan_against_task(proposal["scene_proposal"], None)[1])

    def test_valid_proposal_remains_unbound_and_does_not_mutate_inputs(self):
        proposal, fixed = candidate(), constraints()
        originals = copy.deepcopy((proposal, fixed))
        result = validate_candidate(proposal, fixed)
        self.assertEqual(result["issues"], [])
        self.assertEqual(result["task_payload"], proposal["task_payload"])
        self.assertEqual(result["scene_proposal"], proposal["scene_proposal"])
        self.assertEqual((proposal, fixed), originals)
        self.assertEqual(set(result["scene_proposal"]), {"scenes"})

    def test_missing_extra_metadata_and_wrong_types_are_rejected(self):
        mutations = [
            lambda c: c.update(status="approved"),
            lambda c: c["task_payload"].update(id="forged"),
            lambda c: c["task_payload"].pop("notes"),
            lambda c: c["task_payload"].update(relationship_goal=4),
            lambda c: c["task_payload"].update(required_characters=None),
            lambda c: c["scene_proposal"].update(source_chapter_task_id="forged"),
            lambda c: c["scene_proposal"]["scenes"][0].pop("emotional_shift"),
            lambda c: c["scene_proposal"]["scenes"][0].update(location=4),
            lambda c: c["scene_proposal"]["scenes"][0].update(scene_no=True),
            lambda c: c["scene_proposal"]["scenes"][0].update(participants=["林默", 4]),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                proposal = candidate()
                mutate(proposal)
                self.assertTrue(validate_candidate(proposal, constraints())["issues"])

    def test_existing_domain_rules_are_reused(self):
        mutations = [
            lambda c: c["task_payload"].update(primary_function="unknown"),
            lambda c: c["task_payload"].update(primary_function="information_reveal"),
            lambda c: c["task_payload"].update(secondary_functions=["emotional_aftermath"]),
            lambda c: c["task_payload"].update(allowed_advances=["揭示组织秘密"]),
            lambda c: c["task_payload"].update(ending_state="  "),
            lambda c: c["scene_proposal"].update(scenes=c["scene_proposal"]["scenes"][:1]),
            lambda c: c["scene_proposal"]["scenes"][1].update(scene_no=4),
            lambda c: c["scene_proposal"]["scenes"][0].update(location=""),
            lambda c: c["scene_proposal"]["scenes"][0].update(participants=[]),
            lambda c: c["scene_proposal"]["scenes"][0].update(scene_function="archive_analysis"),
            lambda c: c["scene_proposal"]["scenes"][0].update(forbidden_information=["禁止追逐"]),
            lambda c: c["scene_proposal"]["scenes"][0].update(allowed_information=["揭示组织秘密"]),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                proposal = candidate()
                mutate(proposal)
                self.assertTrue(validate_candidate(proposal, constraints())["issues"])

    def test_explicit_constraints_cannot_change_or_disappear(self):
        for field, value, code in [("canon_budget", "normal", "canon_budget_changed"),
                                   ("required_characters", ["林默"], "required_characters_missing"),
                                   ("forbidden_advances", [], "forbidden_advances_missing")]:
            with self.subTest(field=field):
                proposal = candidate()
                proposal["task_payload"][field] = value
                self.assertIn(code, [issue["code"] for issue in validate_candidate(proposal, constraints())["issues"]])
        proposal = candidate()
        for scene in proposal["scene_proposal"]["scenes"]:
            scene["participants"] = ["林默"]
        self.assertIn("required_characters_absent", [issue["code"] for issue in validate_candidate(proposal, constraints())["issues"]])

    def test_explicit_budget_requires_equality_even_if_candidate_is_stricter(self):
        result = validate_candidate(candidate(), constraints(canon_budget="minor"))
        self.assertIn("canon_budget_changed", [issue["code"] for issue in result["issues"]])

    def test_pure_scene_constraints_preserve_approval_matching(self):
        proposal = candidate()
        task = {**proposal["task_payload"], "id": "task-id", "revision": 1, "status": "approved"}
        plan = {**proposal["scene_proposal"], "source_chapter_task_id": task["id"], "source_chapter_task_revision": 1}
        result = SimpleNamespace(approved=task, history=[task])
        self.assertEqual(_validate_plan_against_task(plan, result), (task, ""))
        plan["scenes"][0]["allowed_information"] = ["揭示组织秘密"]
        self.assertEqual(_validate_plan_against_task(plan, result), (task, validate_scene_constraints(plan, task)))
        task["status"] = "draft"
        self.assertIn("cannot bind a draft", _validate_plan_against_task(plan, result)[1])


class PlanningGraphTests(unittest.TestCase):
    def test_nested_properties_never_enter_planning_input(self):
        reviewed = {"created_by": "knowledge_draft_review", "chapter_number": 1, "introduced_in": "chapter_001"}
        properties = {"private_archive": {"future_text": "FUTURE_ARCHIVE_SENTINEL"},
                      "credentials": {"api_key": "CREDENTIAL_SENTINEL"}, "current_location": "厨房"}
        data = planning_input()
        data["graph"] = document([node("a", reviewed, properties=properties), node("b", reviewed)],
                                 [{"id": "edge", "source": "a", "target": "b", "source_info": reviewed,
                                   "summary": "已审核的人物关系", "properties": properties}])
        before = copy.deepcopy(data)
        normalized, issues = validate_input(data)
        self.assertEqual(issues, [])
        graph = normalized["graph"]
        for record in graph["graph"]["nodes"] + graph["graph"]["edges"]:
            self.assertEqual(record["properties"], {})
        self.assertEqual(graph["graph"]["nodes"][0]["summary"], "已知事实")
        self.assertEqual(graph["graph"]["edges"][0]["summary"], "已审核的人物关系")
        self.assertNotIn("FUTURE_ARCHIVE_SENTINEL", repr(normalized))
        self.assertNotIn("CREDENTIAL_SENTINEL", repr(normalized))
        self.assertEqual(data, before)
        self.assertEqual(filter_planning_graph(graph, 1), (graph, 0))

    def test_provenance_filter_projection_and_edge_endpoints(self):
        global_source = {"created_by": "user", "introduced_in": None, "last_updated_in": None, "future_secret": "未来真相"}
        reviewed_source = {"created_by": "knowledge_draft_review", "chapter_number": 1, "introduced_in": "chapter_001"}
        imported_source = {"kind": "source_fact", "chapter_number": 1, "reviewed": True, "evidence": "无须再上传", "source_hash": "local-only"}
        nodes = [node("global", global_source, credentials="SECRET"), node("reviewed", reviewed_source),
                 node("imported", imported_source), node("future", {**imported_source, "chapter_number": 2}),
                 node("planned", reviewed_source, status=" Planned "), node("unreviewed", {**imported_source, "reviewed": False}),
                 node("missing"), node("updated_later", {**reviewed_source, "last_updated_in": "chapter_002"}),
                 node("proposal", {**reviewed_source, "candidate_source": "next_chapter_proposal"})]
        edges = [{"id": "safe_edge", "source": "global", "target": "reviewed", "type": "knows", "source_info": reviewed_source},
                 {"id": "future_edge", "source": "global", "target": "future", "source_info": global_source},
                 {"id": "missing_source", "source": "global", "target": "reviewed"}]
        original = document(nodes, edges)
        before = copy.deepcopy(original)
        filtered, excluded = filter_planning_graph(original, 1)
        self.assertEqual([n["id"] for n in filtered["graph"]["nodes"]], ["global", "reviewed", "imported"])
        self.assertEqual([e["id"] for e in filtered["graph"]["edges"]], ["safe_edge"])
        self.assertEqual(excluded, 8)
        self.assertEqual(set(filtered), {"version", "graph"})
        self.assertNotIn("credentials", filtered["graph"]["nodes"][0])
        self.assertNotIn("future_secret", filtered["graph"]["nodes"][0]["source"])
        self.assertNotIn("source_hash", filtered["graph"]["nodes"][2]["source"])
        self.assertEqual(original, before)
        self.assertEqual(filter_planning_graph(filtered, 1), (filtered, 0))

    def test_malformed_or_conflicting_sources_are_excluded(self):
        sources = [{"kind": [], "reviewed": True, "chapter_number": 1},
                   {"created_by": "knowledge_draft_review", "chapter_number": True},
                   {"created_by": "knowledge_draft_review", "chapter_number": 1, "introduced_in": "chapter_002"},
                   {"created_by": "user", "introduced_in": "unproven"},
                   {"created_by": "knowledge_draft_review"}]
        filtered, excluded = filter_planning_graph(document([node(str(i), source) for i, source in enumerate(sources)]), 1)
        self.assertEqual(filtered["graph"]["nodes"], [])
        self.assertEqual(excluded, len(sources))
        with self.assertRaises(ValueError):
            filter_planning_graph(document(), True)


class PlanningInputTests(unittest.TestCase):
    def test_next_chapter_snapshot_and_empty_prefix(self):
        data = planning_input()
        data["graph"] = document([node("future", {"kind": "source_fact", "reviewed": True, "chapter_number": 2})])
        data["excluded_records"] = 3
        normalized, issues = validate_input(data)
        self.assertEqual(issues, [])
        self.assertEqual(normalized["excluded_records"], 4)
        self.assertEqual(normalized["graph"]["graph"]["nodes"], [])
        data.update(chapter_number=1, prefix=[])
        self.assertEqual(validate_input(data)[1], [])

    def test_input_rejects_unconfirmed_gaps_wrong_target_and_extra_archives(self):
        mutations = [
            lambda d: d.update(chapter_number=1),
            lambda d: d.update(chapter_number=True),
            lambda d: d.update(source={"archive": "FUTURE"}),
            lambda d: d.update(config={}),
            lambda d: d.update(author_intent=""),
            lambda d: d.update(excluded_records=True),
            lambda d: d["constraints"].update(id="forged"),
            lambda d: d["setting"].update(protagonist=42),
            lambda d: d["prefix"][0].update(chapter_number=2),
            lambda d: d["prefix"][0].update(status="awaiting_confirmation"),
            lambda d: d["prefix"][0].update(summary_status="failed"),
            lambda d: d["prefix"][0].update(summary=""),
            lambda d: d["prefix"][0].update(content=""),
            lambda d: d["prefix"][0].update(revision=3),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                data = planning_input()
                mutate(data)
                normalized, issues = validate_input(data)
                self.assertIsNone(normalized)
                self.assertTrue(issues)

    def test_only_last_prefix_chapter_carries_body(self):
        data = planning_input()
        second = {**data["prefix"][0], "chapter_number": 2, "revision": "revision-2"}
        data["prefix"].append(second)
        data["chapter_number"] = 3
        self.assertIn("prefix_extra_content", [issue["code"] for issue in validate_input(data)[1]])
        data["prefix"][0]["content"] = ""
        self.assertEqual(validate_input(data)[1], [])


if __name__ == "__main__":
    unittest.main()
