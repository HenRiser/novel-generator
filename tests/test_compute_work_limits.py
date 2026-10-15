from __future__ import annotations

import copy
import json
import unittest
from dataclasses import asdict
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from api.main import app
from services import chapter_planning_contract as contract
from services import chapter_planning_service as planning
from services import compute_service as compute
from services import context_pack_service as context
from services import work_limits as limits
from tests.test_chapter_planning_contract import node, planning_input
from tests.test_compute_reliability import KEY, body_input, payload


def document(nodes=None, edges=None, registry=None):
    return {"graph": {"nodes": nodes or [], "edges": edges or []}, "tag_registry": registry or {}}


def goal(count):
    return " ".join(f"word{index}" for index in range(count))


class WorkLimitTests(unittest.TestCase):
    def test_raw_counts_include_filtered_records_and_fail_before_copy(self):
        for field, maximum in (("nodes", 2000), ("edges", 4000)):
            graph = document()
            graph["graph"][field] = [None] * maximum
            limits.check_graph_counts(graph)
            graph["graph"][field].append(None)
            with patch.object(compute.copy, "deepcopy", side_effect=AssertionError("copied before rejection")):
                with self.assertRaises(limits.WorkloadLimitError):
                    compute._graph({"graph": graph})
            with patch.object(contract, "_provenance", side_effect=AssertionError("filtered before rejection")):
                with self.assertRaises(limits.WorkloadLimitError):
                    contract.filter_planning_graph(graph, 1)

    def test_goal_boundaries_preserve_unique_lowercase_and_chinese_tokens(self):
        self.assertEqual(limits.check_goal("A a AA aa 中 中 中文 中文"), ["aa", "中", "中文"])
        self.assertEqual(len(limits.check_goal(goal(256))), 256)
        self.assertEqual(limits.check_goal("repeat " * 2000), ["repeat"])
        self.assertEqual(limits.check_goal("a" * 16384), ["a" * 16384])
        for text in (goal(257), "a" * 16385, " " * 16385):
            with self.subTest(length=len(text)), self.assertRaises(limits.WorkloadLimitError):
                limits.check_goal(text)

    def test_exact_work_budgets_are_accepted_and_next_unit_rejected(self):
        graph = document([{}] * 2000, [{}] * 4000)
        self.assertEqual(len(limits.check_context_workload(graph, goal(100))), 100)
        with self.assertRaises(limits.WorkloadLimitError):
            limits.check_context_workload(graph, goal(101))
        graph = document([{"summary": "x" * 4_000_000}])
        limits.check_context_workload(graph, goal(16))
        with self.assertRaises(limits.WorkloadLimitError):
            limits.check_context_workload(graph, goal(17))
        graph["graph"]["nodes"][0]["summary"] += "x"
        with self.assertRaises(limits.WorkloadLimitError):
            limits.check_context_workload(graph, "")

    def test_shared_and_duplicate_tags_are_rejected_before_expansion_or_scoring(self):
        cases = [
            (document([node("n", importance=8, tags=["shared"] * 1000)], registry={"shared": {"description": "x" * 10000}}), "needle"),
            (document([node(str(i), importance=8, tags=["shared"]) for i in range(400)], registry={"shared": {"description": "x" * 30000}}), goal(256)),
        ]
        for graph, chapter_goal in cases:
            with self.subTest(nodes=len(graph["graph"]["nodes"])), \
                 patch.object(context, "_tag_text", side_effect=AssertionError("expanded before rejection")), \
                 patch.object(context, "_score_node", side_effect=AssertionError("scored before rejection")):
                with self.assertRaises(limits.WorkloadLimitError):
                    context.build_context_pack_from_graph("book:test", {"chapter_goal": chapter_goal}, graph)

    def test_normal_context_result_and_input_remain_unchanged(self):
        graph = document([node(f"n{i}", importance=8, tags=["shared"]) for i in range(25)],
                         registry={"shared": {"description": "important note", "aliases": ["canonical"]}})
        original = copy.deepcopy(graph)
        request = {"chapter_goal": "important 中文", "max_nodes": 20}
        with patch.object(context, "check_context_workload", return_value=limits.check_goal(request["chapter_goal"])):
            expected = asdict(context.build_context_pack_from_graph("book:test", request, graph))
        actual = asdict(context.build_context_pack_from_graph("book:test", request, graph))
        self.assertEqual(actual, expected)
        self.assertEqual(actual["context_pack"]["stats"]["nodes_considered"], 25)
        self.assertEqual(actual["context_pack"]["stats"]["truncated_nodes"], 5)
        self.assertEqual(graph, original)

    def test_repeated_endpoint_labels_and_dangling_ids_have_expansion_budget(self):
        graph = document([node("long", label="x" * 100000), node("other")],
                         [{"id": str(i), "source": "long", "target": "other"} for i in range(40)])
        with patch.object(context, "_edge_payload", side_effect=AssertionError("expanded before rejection")):
            with self.assertRaises(limits.WorkloadLimitError):
                context.build_context_pack_from_graph("book:test", {"chapter_goal": ""}, graph)
        dangling = "x" * 40001
        graph = document(edges=[{"source": dangling, "target": dangling}] * 50)
        with self.assertRaises(limits.WorkloadLimitError):
            limits.check_context_workload(graph, "")

    def test_planning_raw_limits_survive_filter_and_keep_structured_error(self):
        for over_graph in (True, False):
            data = planning_input()
            if over_graph:
                data["graph"] = document([{}] * 2001)
            else:
                data["author_intent"] = goal(257)
            with patch.object(contract, "filter_planning_graph", side_effect=AssertionError("filtered too early")):
                with self.assertRaises(limits.WorkloadLimitError) as caught:
                    contract.validate_input(data)
            self.assertEqual((caught.exception.status, caught.exception.code), (413, "workload_too_large"))

    def test_growth_is_rejected_without_changing_supplied_graph(self):
        for kind, count in (("node", 2000), ("edge", 4000)):
            graph = document([{"id": f"n{i}"} for i in range(2000 if kind == "node" else 2)],
                             [{"id": f"e{i}", "source": "n0", "target": "n1"} for i in range(count if kind == "edge" else 0)])
            original = copy.deepcopy(graph)
            builder = "build_graph_node_for_create" if kind == "node" else "build_graph_edge_for_create"
            with patch.object(compute.graphs, builder, return_value=({"id": "new"}, "")):
                with self.assertRaises(limits.WorkloadLimitError):
                    compute._graph_change({"graph": graph, "action": "create_" + kind, kind + "_id": "new"})
            self.assertEqual(graph, original)
        graph = document([{"id": f"n{i}", "label": str(i)} for i in range(1999)])
        original = copy.deepcopy(graph)
        with self.assertRaises(limits.WorkloadLimitError):
            compute._graph_change({"graph": graph, "action": "import_assets", "assets": {"outline": "## 主要人物\n- **甲**：演员\n- **乙**：演员"}})
        self.assertEqual(graph, original)

    def test_node_delete_removes_only_linked_edges_and_clears_child_parent(self):
        graph = document([{"id": "remove"}, {"id": "child", "parent_id": "remove"}, {"id": "keep"}],
                         [{"id": "a", "source": "remove", "target": "child"},
                          {"id": "b", "source": "child", "target": "remove"},
                          {"id": "c", "source": "child", "target": "keep"}])
        result = compute._graph_change({"graph": graph, "action": "delete_node", "node_id": "remove", "delete_edges": True})
        self.assertEqual([e["id"] for e in result["graph"]["graph"]["edges"]], ["c"])
        self.assertIsNone(result["graph"]["graph"]["nodes"][0]["parent_id"])
        self.assertEqual(len(graph["graph"]["edges"]), 3)

    def test_public_context_error_is_413_even_without_model_credentials(self):
        with TestClient(app) as client, patch.object(compute, "request_text") as model:
            response = client.post("/api/compute/context_pack", json=payload({"graph": document([None] * 2001)}, key=""))
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["error"]["code"], "workload_too_large")
        model.assert_not_called()


class WorkLimitAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_implicit_context_json_and_stream_fail_before_model(self):
        for streaming in (False, True):
            data = body_input()
            data["graph"] = document([None] * 2001)
            with patch.object(compute, "request_text", new_callable=AsyncMock) as model, \
                 patch.object(compute, "request_text_stream") as stream:
                with self.assertRaises(limits.WorkloadLimitError):
                    if streaming:
                        async for _ in compute.stream_compute("generate_chapter", data, {"api_key": KEY}, {}):
                            pass
                    else:
                        await compute.compute("generate_chapter", data, {"api_key": KEY}, {})
                model.assert_not_called()
                stream.assert_not_called()

    async def test_planning_full_work_guard_rejects_before_model_in_both_modes(self):
        data = planning_input()
        data["author_intent"] = goal(256)
        data["graph"] = document([node("known", {"created_by": "user"}, summary="x" * 300000)])
        for streaming in (False, True):
            model = AsyncMock(side_effect=AssertionError("provider called"))
            with self.subTest(streaming=streaming), self.assertRaises(limits.WorkloadLimitError):
                if streaming:
                    async for _ in planning.stream_plan_chapter(data, model):
                        pass
                else:
                    await planning.plan_chapter(data, model)
            model.assert_not_called()

    async def test_import_candidate_limit_precedes_model(self):
        data = {"results": [{"characters": [{"status": "accepted"}] * 2001}]}
        with patch.object(compute, "request_text", new_callable=AsyncMock) as model:
            with self.assertRaises(limits.WorkloadLimitError):
                await compute.compute("import_synthesis", data, {"api_key": KEY}, {})
        model.assert_not_called()

    async def test_review_accept_cannot_grow_graph_beyond_limit(self):
        from tests.test_story_delta_json_mode import valid_payload
        data = {**body_input(), "chapter": {"content": "The door closed."}}
        with patch.object(compute, "request_text", AsyncMock(return_value=json.dumps(valid_payload()))):
            result = await compute.compute("story_delta", data, {"api_key": KEY}, {})
        draft = result["knowledge_draft"]
        data.update(graph=document([{"id": f"n{i}"} for i in range(2000)]), draft=draft,
                    change_id=draft["candidate_changes"][0]["id"], action="accept")
        original = copy.deepcopy(data)
        with self.assertRaises(limits.WorkloadLimitError):
            await compute.compute("review_change", data, {}, {})
        self.assertEqual(data, original)
